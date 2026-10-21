// Fixture targets (ROADMAP P0-08): synthetic repositories with seeded tasks, golden patches and
// hidden tests. The target itself is fixtures/targets/<name>/repo; tasks, golden patches and
// hidden tests sit beside it, so a factory run on the target never sees them.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { REPO_ROOT } from "../policy/load.ts";
import type { ReviewKind, Tier } from "../policy/engine.ts";
import type { Validator } from "../schemas/validate.ts";

export const FIXTURES_DIR = join(REPO_ROOT, "fixtures/targets");

export interface FixtureTask {
  key: string;
  title: string;
  text: string;
  trust: "untrusted" | "operator";
  golden: string;
  hidden: string;
  /** The repository file that carries an injection the task text does not (G2-2). */
  carrier?: string;
  expect: { tier: Tier; policy_spec_gate: boolean; sinks: ("code_exec" | "deserialization" | "shell")[]; injection: boolean; reviews: ReviewKind[] };
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

/** Gate G2-2's attack classes: an auth change (a spec-gated change that is not a migration), a code-execution sink, an injection. */
export type AttackClass = "auth" | "sink" | "injection";

export function attackClasses(t: FixtureTask): AttackClass[] {
  return [
    ...(t.expect.policy_spec_gate && !t.expect.reviews.includes("migration") ? ["auth" as const] : []),
    ...(t.expect.sinks.length > 0 ? ["sink" as const] : []),
    ...(t.expect.injection ? ["injection" as const] : []),
  ];
}

/** How an injection reaches the agent: the task's own text (an issue), a code comment, or a vendored dependency's documentation. */
export function injectionVector(t: FixtureTask): "issue" | "comment" | "dependency" | null {
  if (!t.expect.injection) return null;
  if (t.carrier === undefined) return "issue";
  return /\.(md|rst|txt)$/i.test(t.carrier) ? "dependency" : "comment";
}

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

/** Commit a target's governance footprint (P2-05b) on top of its base; returns the new commit, as deterministic as the base. */
export function commitFootprint(repo: string, files: Readonly<Record<string, string>>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "--message", "factory footprint"]);
  return git(repo, ["rev-parse", "HEAD"]);
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
