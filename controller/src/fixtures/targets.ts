// Fixture targets (ROADMAP P0-08): synthetic repositories with seeded tasks, golden patches and
// hidden tests. The target itself is fixtures/targets/<name>/repo; tasks, golden patches and
// hidden tests sit beside it, so a factory run on the target never sees them.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { REPO_ROOT } from "../policy/load.ts";
import type { Tier } from "../policy/engine.ts";
import type { Validator } from "../schemas/validate.ts";

export const FIXTURES_DIR = join(REPO_ROOT, "fixtures/targets");

export interface FixtureTask {
  key: string;
  title: string;
  text: string;
  trust: "untrusted" | "operator";
  golden: string;
  hidden: string;
  expect: { tier: Tier; policy_spec_gate: boolean; sinks: ("code_exec" | "deserialization" | "shell")[]; injection: boolean };
}

export interface Fixture {
  name: string;
  dir: string;
  repoDir: string;
  profilePath: string;
  tasks: FixtureTask[];
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR).filter((n) => existsSync(join(FIXTURES_DIR, n, "tasks.yaml"))).sort();
}

export function loadFixture(name: string, validator: Validator): Fixture {
  const dir = join(FIXTURES_DIR, name);
  const manifest: unknown = parse(readFileSync(join(dir, "tasks.yaml"), "utf8"));
  const check = validator.validate("fixture-tasks.schema.json", manifest);
  if (!check.valid) throw new Error(`${name}/tasks.yaml: ${check.errors.join("; ")}`);
  return { name, dir, repoDir: join(dir, "repo"), profilePath: join(dir, "profile.yaml"), tasks: (manifest as { tasks: FixtureTask[] }).tasks };
}

export const taskText = (f: Fixture, t: FixtureTask): string => readFileSync(join(f.dir, t.text), "utf8");

/** The GitHub repository the fixture's profile names: its throwaway mirror. */
export const mirrorRepo = (f: Fixture): string => (parse(readFileSync(f.profilePath, "utf8")) as { target: { repo: string } }).target.repo;

/** Same tree, author and dates give the same base commit on every machine and every mirror. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "software-factory fixtures",
  GIT_AUTHOR_EMAIL: "fixtures@software-factory.invalid",
  GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z",
  GIT_COMMITTER_NAME: "software-factory fixtures",
  GIT_COMMITTER_EMAIL: "fixtures@software-factory.invalid",
  GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z",
};

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** The fixture's target as a fresh repository at `dest` on `main`; returns the base commit. */
export function buildTargetRepo(f: Fixture, dest: string): string {
  cpSync(f.repoDir, dest, { recursive: true, filter: (src) => !/[\\/](node_modules|\.venv)([\\/]|$)/.test(src) });
  git(dest, ["init", "--quiet", "--initial-branch=main"]);
  git(dest, ["add", "--all"]);
  git(dest, ["commit", "--quiet", "--message", `${f.name}: fixture base`]);
  return git(dest, ["rev-parse", "HEAD"]);
}

/** Commit the task's golden patch on the current branch; returns the new commit. */
export function commitGolden(repo: string, f: Fixture, t: FixtureTask): string {
  git(repo, ["apply", "--index", join(f.dir, t.golden)]);
  git(repo, ["commit", "--quiet", "--message", `golden: ${t.key}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Commit the task's hidden tests on the current branch; returns the new commit. */
export function commitHidden(repo: string, f: Fixture, t: FixtureTask): string {
  cpSync(join(f.dir, t.hidden), repo, { recursive: true });
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "--message", `hidden tests: ${t.key}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

export function hiddenFiles(f: Fixture, t: FixtureTask): string[] {
  const root = join(f.dir, t.hidden);
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
  return walk(root, "");
}
