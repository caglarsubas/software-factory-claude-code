// Writes the old homes `old-homes.test.ts` opens (P2-11, "schema migrations tested on old
// bundles"): for each release below, that release's own factoryctl, checked out in a git worktree
// with its own locked dependencies, creates and runs replayed tasks in a home of its own. Its
// database is kept as SQL text, with its run directories and objects as they were written.
//
//   node controller/src/store/testdata/generate.ts      (needs the release tags and the npm registry)
//
// The homes live under a fixed path while they are written, so the paths recorded in them are
// the same on every run; nothing in them is private.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const WORK = "/tmp/sf-old-homes";

/** The releases, each with the store schema it wrote. */
export const OLD_HOMES = [
  { tag: "v0.1.2", schema: 1 },
  { tag: "v0.7.0", schema: 2 },
] as const;

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} (in ${cwd}): ${r.stderr}${r.stdout}`);
  return r;
}

const sqlValue = (v: unknown): string => {
  if (v === null) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  throw new Error(`no SQL literal for ${typeof v}`);
};

/** A database as SQL: tables and indexes, every row in rowid order, the AUTOINCREMENT state, then the triggers. */
export function dumpSql(path: string): string {
  const db = new DatabaseSync(path);
  try {
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { type: string; name: string; sql: string }[];
    const lines: string[] = [];
    for (const o of objects.filter((x) => x.type === "table" || x.type === "index")) lines.push(`${o.sql};`);
    for (const t of objects.filter((x) => x.type === "table")) {
      for (const row of db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all() as Record<string, unknown>[]) {
        lines.push(`INSERT INTO "${t.name}" (${Object.keys(row).map((k) => `"${k}"`).join(", ")}) VALUES (${Object.values(row).map(sqlValue).join(", ")});`);
      }
    }
    const hasSequence = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'").get() !== undefined;
    if (hasSequence) for (const r of db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all() as { name: string; seq: number }[]) lines.push(`INSERT INTO sqlite_sequence (name, seq) VALUES (${sqlValue(r.name)}, ${String(r.seq)});`);
    for (const o of objects.filter((x) => x.type === "trigger")) lines.push(`${o.sql};`);
    return `${lines.join("\n")}\n`;
  } finally {
    db.close();
  }
}

/** The driver each release runs in its own worktree: a target, a profile, tasks and their runs, through its own CLI. */
const DRIVER = String.raw`
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const [W, ROOT, TAG] = process.argv.slice(2);
const { parse, stringify } = await import(createRequire(join(W, "controller/package.json")).resolve("yaml"));
const { answer } = await import(join(W, "controller/src/session/transcript.ts"));
const CLI = join(W, "controller/src/cli/factoryctl.ts");
const home = join(ROOT, "home");
const env = { PATH: process.env.PATH, HOME: ROOT, FACTORY_HOME: home };
const factoryctl = (...args) => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", env });
  process.stdout.write("factoryctl " + args.join(" ") + ": " + r.status + " " + r.stdout + r.stderr + "\n");
  return r.stdout.trim();
};
const git = (cwd, args) => spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", ...args], { cwd, encoding: "utf8" });
const seed = join(ROOT, "seed");
cpSync(join(W, "gates/fixtures/ts"), seed, { recursive: true });
git(seed, ["init", "-q", "-b", "main"]);
git(seed, ["add", "-A"]);
git(seed, ["commit", "-qm", "base"]);
const remote = join(ROOT, "remote.git");
git(ROOT, ["clone", "-q", "--bare", seed, remote]);
const profile = parse(readFileSync(join(W, "profiles/template/profile.yaml"), "utf8"));
profile.target = { repo: "example/ts-mini", default_branch: "main", visibility: "private" };
writeFileSync(join(ROOT, "profile.yaml"), stringify(profile));
writeFileSync(join(ROOT, "task.md"), "Add an emptiness check for carts.\n");
const create = (title) => factoryctl("task", "create", "--profile", join(ROOT, "profile.yaml"), "--title", title, "--body-file", join(ROOT, "task.md"), "--remote", remote);
const replay = join(ROOT, "replay");
mkdirSync(replay, { recursive: true });
if (TAG === "v0.1.2") {
  const write = (label, messages) => writeFileSync(join(replay, label + ".ndjson"), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  write("triage", answer("claude-haiku-5-5", { kind: "fix", proposed_tier: "R3", uncertain: false, duplicate_of: null, summary: "Adjust how carts report emptiness." }));
  write("spec", answer("claude-opus-5-5", { objective: "Report whether a cart is empty", scope: { include: ["src/"], exclude: [] }, acceptance_criteria: [{ id: "AC-1", statement: "isEmpty returns true only for an empty cart", verification: "node --test" }], invariants: [], risk_signals: [], required_evidence: ["unit_tests"], human_gate: { required: true, reason: "a person decides" }, markdown: "# Spec" }));
  const a = create("Stopped at the spec gate");
  factoryctl("run", a, "--replay", replay);
  const b = create("Cancelled before it ran");
  factoryctl("cancel", b);
} else {
  const { writeTranscripts } = await import(join(W, "controller/src/cli/testing.ts"));
  const a = create("Ran to the end, then cancelled");
  writeTranscripts(replay, home, a, "clean");
  writeFileSync(join(replay, "replay.json"), JSON.stringify({ gates: {} }));
  factoryctl("run", a, "--replay", replay);
  factoryctl("cancel", a);
  const b = create("Cancelled before it ran");
  factoryctl("cancel", b);
}
factoryctl("status");
`;

function generate(tag: string): void {
  const root = join(WORK, tag);
  const worktree = join(WORK, `${tag}-src`);
  rmSync(root, { recursive: true, force: true });
  if (existsSync(worktree)) run("git", ["worktree", "remove", "--force", worktree], REPO);
  mkdirSync(root, { recursive: true });
  run("git", ["worktree", "add", "--detach", worktree, tag], REPO);
  try {
    run("pnpm", ["install", "--frozen-lockfile"], worktree);
    const driver = join(WORK, "driver.ts");
    writeFileSync(driver, DRIVER);
    process.stdout.write(run(process.execPath, ["--disable-warning=ExperimentalWarning", driver, worktree, root, tag], worktree).stdout);
    const out = join(HERE, tag);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "factory.sql"), dumpSql(join(root, "home", "factory.db")));
    for (const dir of ["runs", "objects"]) if (existsSync(join(root, "home", dir))) cpSync(join(root, "home", dir), join(out, dir), { recursive: true });
  } finally {
    run("git", ["worktree", "remove", "--force", worktree], REPO);
  }
}

if (import.meta.main) {
  for (const { tag } of OLD_HOMES) generate(tag);
}
