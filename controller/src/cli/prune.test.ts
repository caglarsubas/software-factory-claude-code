// `factoryctl prune` (P2-11, ADR 0003): the operator's command for retention. It refuses inside
// Claude Code, finishes a purge that stopped part-way, shows what is due without changing it on
// --dry-run, and expires what is past retention; `status` and `doctor` show what it did.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { planPurge } from "../durable/purge.ts";
import { ensureHome, factoryHome, runDir } from "../home.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { EventStore } from "../store/events.ts";
import { CLI } from "./testing.ts";

const root = mkdtempSync(join(tmpdir(), "prune-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const home = factoryHome({ FACTORY_HOME: join(root, "home") });
const env = { PATH: process.env["PATH"] ?? "", HOME: root, FACTORY_HOME: home.root };
const factoryctl = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", env: { ...env, ...extra } });

/** A task finished `daysAgo` days ago, on the template profile (bundles 180, transcripts 30 days). */
function finished(store: EventStore, clock: { t: number }, daysAgo: number, title: string): string {
  clock.t = Date.now() - daysAgo * 86_400_000;
  const id = store.nextTaskId();
  const dir = runDir(home, id);
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  writeFileSync(join(dir, "task.json"), `${JSON.stringify({ id, target: { repo: "example/t", profile: join(REPO_ROOT, "profiles/template/profile.yaml") }, title })}\n`);
  writeFileSync(join(dir, "transcripts/build.ndjson"), "{}\n");
  store.append({ task_id: id, actor: { kind: "operator", id: "op" }, type: "task_created", payload: { remote: "/r", commit_protocol: 1, files: {} } });
  store.append({ task_id: id, actor: { kind: "factoryctl", id: "factoryctl" }, type: "state_changed", from: "RECEIVED", to: "DONE", payload: {} });
  return id;
}

describe("factoryctl prune", { timeout: 60_000 }, () => {
  ensureHome(home);
  const clock = { t: Date.now() };
  const store = EventStore.open(home.db, { now: () => new Date(clock.t) });
  const old = finished(store, clock, 200, "an old task");
  const mid = finished(store, clock, 40, "a month-old task");
  const fresh = finished(store, clock, 1, "a new task");
  const purged = finished(store, clock, 1, "a task being purged");
  // A purge that stopped before its first step.
  planPurge(home, store, [purged], { by: "op", reason: "test" });
  store.close();

  it("refuses inside a Claude Code session", () => {
    const r = factoryctl(["prune"], { CLAUDECODE: "1" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("prune refuses to run inside a Claude Code session");
  });

  it("shows what is due on --dry-run and changes nothing", () => {
    const doctor = factoryctl(["doctor"]);
    expect(doctor.stdout).toMatch(/^warn {2}retention: 2 finished task\(s\) past retention: factoryctl prune$/m);
    expect(doctor.stdout).toMatch(/^warn {2}purges: 1 purge\(s\) stopped part-way/m);
    const r = factoryctl(["prune", "--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("(test) stopped part-way: prune finishes it");
    expect(r.stdout).toMatch(new RegExp(`^${old}  bundle: 200 day\\(s\\) since its last activity; kept 180$`, "m"));
    expect(r.stdout).toMatch(new RegExp(`^${mid}  transcripts: 40 day\\(s\\) since its last activity; kept 30$`, "m"));
    expect(r.stdout).toContain("dry run: 2 expiry(ies)");
    expect(readdirSync(runDir(home, old)).sort()).toEqual(["task.json", "transcripts"]);
    expect(existsSync(runDir(home, purged))).toBe(true);
  });

  it("finishes the stopped purge, expires what is past retention, and status shows it", () => {
    const r = factoryctl(["prune"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("(test) finished: 1 task(s)");
    expect(existsSync(runDir(home, purged))).toBe(false);
    expect(r.stdout).toContain("pruned: 2 expiry(ies) recorded");
    expect(readdirSync(runDir(home, old))).toEqual(["task.json"]);
    expect(existsSync(join(runDir(home, mid), "transcripts"))).toBe(false);
    expect(existsSync(join(runDir(home, fresh), "transcripts"))).toBe(true);
    const status = factoryctl(["status"]).stdout;
    expect(status).toMatch(new RegExp(`^${old}  DONE {8} \\(evidence expired\\)  an old task$`, "m"));
    expect(status).toMatch(new RegExp(`^${fresh}  DONE {8}  a new task$`, "m"));
    expect(status).not.toContain(purged);
    expect(factoryctl(["doctor"]).stdout).toMatch(/^ok {4}retention: nothing past retention$/m);
    expect(factoryctl(["prune"]).stdout).toContain("pruned: 0 expiry(ies) recorded; 0 object(s), 0 path(s)");
  });
});
