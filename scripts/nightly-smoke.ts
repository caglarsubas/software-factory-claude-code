// The nightly smoke run (ROADMAP P1-05): one live fixture task end to end, from a fresh
// FACTORY_HOME to the merge gate, with real sessions, the real guard and container gates. The
// target is a local bare copy of ts-mini, so nothing is pushed anywhere and no PR is opened.
//
//   SMOKE_ANTHROPIC_KEY=… node scripts/nightly-smoke.ts [--cap-usd 1.5]
//
// The key arrives under its own name and goes only into the run's key file, which sessions
// read through apiKeyHelper: no process this script starts gets it in its environment. The cap
// is the copied profile's monthly cap, so a run that costs more pauses rather than spends.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildTargetRepo, loadFixture } from "../controller/src/fixtures/targets.ts";
import { loadYaml, REPO_ROOT } from "../controller/src/policy/load.ts";
import { createValidator } from "../controller/src/schemas/validate.ts";

const KEY_VARS = ["SMOKE_ANTHROPIC_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

function fail(message: string): never {
  process.stderr.write(`nightly-smoke: ${message}\n`);
  process.exit(2);
}

const { values } = parseArgs({ options: { "cap-usd": { type: "string" }, keep: { type: "boolean" } } });
const cap = Number(values["cap-usd"] ?? "1.5");
if (!(cap > 0)) fail("--cap-usd must be a positive number");
const key = process.env["SMOKE_ANTHROPIC_KEY"];
if (key === undefined || key.trim() === "") fail("SMOKE_ANTHROPIC_KEY is not set");
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEY_VARS.includes(k)));

const root = mkdtempSync(join(tmpdir(), "nightly-smoke-"));
try {
  const home = join(root, "factory");
  mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "secrets", "anthropic.key"), `${key.trim()}\n`, { mode: 0o600 });

  const validator = createValidator();
  const fixture = loadFixture("ts-mini", validator);
  const seed = join(root, "seed");
  const base = buildTargetRepo(fixture, seed);
  const remote = join(root, "remote.git");
  if (spawnSync("git", ["clone", "--quiet", "--bare", seed, remote]).status !== 0) throw new Error("could not create the local remote");

  // JSON is YAML: the copy is the fixture's profile with the smoke cap as its monthly cap.
  const profile = loadYaml(fixture.profilePath, "profile.schema.json", validator) as Record<string, unknown>;
  const profilePath = join(root, "profile.yaml");
  writeFileSync(profilePath, `${JSON.stringify({ ...profile, budgets: { monthly_usd: cap } }, null, 2)}\n`);

  const factoryctl = (args: string[]): { status: number | null; stdout: string } => {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(REPO_ROOT, "controller/src/cli/factoryctl.ts"), ...args], {
      encoding: "utf8",
      env: { ...env, FACTORY_HOME: home },
      stdio: ["ignore", "pipe", "inherit"],
    });
    process.stdout.write(r.stdout);
    return { status: r.status, stdout: r.stdout };
  };

  process.stdout.write(`ts-mini base ${base}; cap $${cap.toFixed(2)}\n`);
  factoryctl(["doctor"]);
  const created = factoryctl(["task", "create", "--profile", profilePath, "--title", "Document the listOrders limits", "--body-file", join(fixture.dir, "tasks/docs-limits.md"), "--untrusted", "--remote", remote]);
  const id = created.stdout.trim();
  if (created.status !== 0 || !/^T-[0-9]{4,}$/.test(id)) throw new Error("task create failed");
  const run = factoryctl(["run", id]);
  factoryctl(["report", id]);
  if (run.stdout.trim() !== `${id} NEEDS_HUMAN (gate: merge)`) throw new Error(`${id} did not reach the merge gate`);
  process.stdout.write(`smoke passed: ${id} reached the merge gate\n`);
} catch (e) {
  process.stderr.write(`nightly-smoke: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  // The key file lives in the run's home: it goes with it.
  if (values.keep !== true) rmSync(root, { recursive: true, force: true });
}
