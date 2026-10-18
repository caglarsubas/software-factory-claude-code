// Mirror a fixture target to its throwaway GitHub repository (ROADMAP P0-08). The base commit is
// deterministic, so every mirror of a fixture starts from the same SHA.
//
//   node scripts/mirror-fixture.ts ts-mini                    print the base commit; push nothing
//   node scripts/mirror-fixture.ts ts-mini --push [--reset]   push it to the profile's target.repo
//
// --footprint --factory-ref vX.Y.Z adds the governance footprint (P2-05b) on top of the base, as a
// second deterministic commit: the target policy for the App in $FACTORY_HOME/github-app.json and
// the workflows, pinned to that release's commit. --rulesets then applies the footprint's
// rulesets to the repository.
//
// --push needs FACTORY_GITHUB_TOKEN, which reaches only the git process; with --footprint it also
// needs Workflows: write, and --rulesets needs Administration: write. --reset puts a main that has
// moved on (merged factory PRs) back at the fixture base: fixture repositories are throwaway.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildTargetRepo, commitFootprint, fixtureNames, loadFixture, mirrorRepo } from "../controller/src/fixtures/targets.ts";
import { authEnv, githubRemote } from "../controller/src/git/repo.ts";
import { appConfig } from "../controller/src/github/app.ts";
import { githubApiUrl } from "../controller/src/github/client.ts";
import { applyRulesets, renderFootprint, type FootprintProfile } from "../controller/src/governance/footprint.ts";
import { factoryHome } from "../controller/src/home.ts";
import { loadYaml, REPO_ROOT } from "../controller/src/policy/load.ts";
import { createValidator } from "../controller/src/schemas/validate.ts";

/** This repository on GitHub. */
const FACTORY_REPO = "caglarsubas/software-factory-claude-code";

function fail(message: string): never {
  process.stderr.write(`mirror-fixture: ${message}\n`);
  process.exit(2);
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { push: { type: "boolean" }, reset: { type: "boolean" }, footprint: { type: "boolean" }, "factory-ref": { type: "string" }, rulesets: { type: "boolean" } } });
const name = positionals[0];
if (name === undefined || !fixtureNames().includes(name)) fail(`usage: node scripts/mirror-fixture.ts <${fixtureNames().join("|")}> [--footprint --factory-ref vX.Y.Z] [--push [--reset]] [--rulesets]`);

const validator = createValidator();
const fixture = loadFixture(name, validator);
const repo = mirrorRepo(fixture);
const dir = mkdtempSync(join(tmpdir(), `mirror-${name}-`));
try {
  const plainBase = buildTargetRepo(fixture, join(dir, "repo"));
  let base = plainBase;
  if (values.footprint === true) {
    const tag = values["factory-ref"];
    if (tag === undefined) fail("--footprint needs --factory-ref vX.Y.Z, a tagged release");
    const ref = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], { encoding: "utf8" }).stdout.trim();
    if (ref === "") fail(`no tag ${tag} here: git fetch --tags first`);
    const app = appConfig(factoryHome());
    if (app === null) fail("--footprint needs the factory App: factoryctl app init --app-id N --installation-id N");
    const profile = loadYaml(fixture.profilePath, "profile.schema.json", validator) as FootprintProfile;
    base = commitFootprint(join(dir, "repo"), renderFootprint({ profile, appId: app.appId, factoryRepo: FACTORY_REPO, factoryRef: ref, factoryTag: tag, validator }));
  }
  process.stdout.write(`${base}\n`);
  if (values.push !== true && values.rulesets !== true) process.exit(0);

  const token = process.env["FACTORY_GITHUB_TOKEN"];
  if (token === undefined) fail("--push and --rulesets need FACTORY_GITHUB_TOKEN");
  const remote = githubRemote(repo);
  const env = authEnv(remote, { token });
  const run = (args: string[]): string => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: join(dir, "repo"), encoding: "utf8", env });
    if (r.status !== 0) fail(`git ${args[0] ?? ""} ${repo}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  if (values.push === true) {
    const current = run(["ls-remote", remote, "refs/heads/main"]).split("\t")[0] ?? "";
    // The footprint sits on the plain base: adding it to a main still at the base is a fast-forward.
    const fastForward = current === "" || (current === plainBase && base !== plainBase);
    if (current === base) {
      process.stderr.write(`mirror-fixture: ${repo} main is already at the fixture base\n`);
    } else if (!fastForward && values.reset !== true) {
      fail(`${repo} main is at ${current}, not the fixture base; pass --reset to put it back`);
    } else {
      run(["push", ...(fastForward ? [] : ["--force"]), remote, "main:refs/heads/main"]);
      process.stderr.write(`mirror-fixture: ${repo} main is at ${base}\n`);
    }
  }
  if (values.rulesets === true) {
    for (const line of await applyRulesets({ repo, token, api: githubApiUrl(process.env["FACTORY_GITHUB_API_URL"]) })) process.stderr.write(`mirror-fixture: ${line}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
