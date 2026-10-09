// Mirror a fixture target to its throwaway GitHub repository (ROADMAP P0-08). The base commit is
// deterministic, so every mirror of a fixture starts from the same SHA.
//
//   node scripts/mirror-fixture.ts ts-mini                    print the base commit; push nothing
//   node scripts/mirror-fixture.ts ts-mini --push [--reset]   push it to the profile's target.repo
//
// --push needs FACTORY_GITHUB_TOKEN, which reaches only the git process. --reset puts a main that
// has moved on (merged factory PRs) back at the fixture base: fixture repositories are throwaway.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildTargetRepo, fixtureNames, loadFixture, mirrorRepo } from "../controller/src/fixtures/targets.ts";
import { authEnv, githubRemote } from "../controller/src/git/repo.ts";
import { createValidator } from "../controller/src/schemas/validate.ts";

function fail(message: string): never {
  process.stderr.write(`mirror-fixture: ${message}\n`);
  process.exit(2);
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { push: { type: "boolean" }, reset: { type: "boolean" } } });
const name = positionals[0];
if (name === undefined || !fixtureNames().includes(name)) fail(`usage: node scripts/mirror-fixture.ts <${fixtureNames().join("|")}> [--push [--reset]]`);

const fixture = loadFixture(name, createValidator());
const repo = mirrorRepo(fixture);
const dir = mkdtempSync(join(tmpdir(), `mirror-${name}-`));
try {
  const base = buildTargetRepo(fixture, join(dir, "repo"));
  process.stdout.write(`${base}\n`);
  if (values.push !== true) process.exit(0);

  const token = process.env["FACTORY_GITHUB_TOKEN"];
  if (token === undefined) fail("--push needs FACTORY_GITHUB_TOKEN");
  const remote = githubRemote(repo);
  const env = authEnv(remote, { token });
  const run = (args: string[]): string => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: join(dir, "repo"), encoding: "utf8", env });
    if (r.status !== 0) fail(`git ${args[0] ?? ""} ${repo}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const current = run(["ls-remote", remote, "refs/heads/main"]).split("\t")[0] ?? "";
  if (current === base) {
    process.stderr.write(`mirror-fixture: ${repo} main is already at the fixture base\n`);
  } else if (current !== "" && values.reset !== true) {
    fail(`${repo} main is at ${current}, not the fixture base; pass --reset to put it back`);
  } else {
    run(["push", ...(current === "" ? [] : ["--force"]), remote, "main:refs/heads/main"]);
    process.stderr.write(`mirror-fixture: ${repo} main is at ${base}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
