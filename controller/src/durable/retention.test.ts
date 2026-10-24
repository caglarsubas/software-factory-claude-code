// Retention per profile (ADR 0003): a finished task keeps its evidence for the shorter of its
// profile's and the config's retention, counted from its last activity; an expiry is recorded
// before anything goes, applied in the home and the replica, never undone by a restore, and a
// task that has not finished is never pruned.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify, parse } from "yaml";
import { sha256 } from "../fsutil.ts";
import { ensureHome, factoryHome, runDir, sessionDir, worktreeDir, type Home } from "../home.ts";
import { otelDir, readOtel } from "../otel/collector.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { commitArtifacts } from "../stages/commit.ts";
import { EventStore } from "../store/events.ts";
import { taskRecord } from "../task/task.ts";
import { hasObject, putObject, storeTree } from "./objects.ts";
import { expiredScopes } from "./refs.ts";
import { initReplica, restore } from "./replica.ts";
import { applyExpiries, effectiveRetention, planRetention, profilePolicy, prune } from "./retention.ts";

const scratch = mkdtempSync(join(tmpdir(), "retention-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const DAY = 86_400_000;
const CONFIG = { bundles: 180, transcripts: 30, otel: 30 };
const START = Date.parse("2026-06-01T00:00:00Z");
const op = { kind: "operator" as const, id: "op" };
const ctl = { kind: "factoryctl" as const, id: "factoryctl" };

function profile(dir: string, name: string, retention: Record<string, number>): string {
  const p = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
  p["retention_days"] = retention;
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, stringify(p));
  return path;
}

interface Seeded {
  id: string;
  artifact: string;
  transcript: string;
  tree: string;
  json: string;
}

/** A task, on `day`, with its files, an artifact, a transcript, an evidence tree, its directories and its telemetry; then ended (or left running). */
function seed(home: Home, store: EventStore, clock: { t: number }, day: number, profilePath: string, end: "DONE" | "FAILED" | null): Seeded {
  clock.t = START + day * DAY;
  const id = store.nextTaskId();
  const dir = runDir(home, id);
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  const body = "Change the rounding rule.\n";
  const json = `${JSON.stringify({ id, target: { repo: "example/t", profile: profilePath }, title: `task ${id}` })}\n`;
  writeFileSync(join(dir, "task.md"), body);
  writeFileSync(join(dir, "task.json"), json);
  const files = { "task.md": putObject(home.objects, body), "task.json": putObject(home.objects, json) };
  store.append({ task_id: id, actor: op, type: "task_created", payload: { remote: "/r", commit_protocol: 1, files } });
  const c = commitArtifacts(store, dir, { taskId: id, stage: "triage", label: "triage", round: 1 }, {}, [{ path: "triage.json", content: `{"task":"${id}"}\n` }], undefined, home.objects);
  writeFileSync(join(dir, "transcripts/triage.ndjson"), `{"said":"${id}"}\n`);
  const stored = storeTree(home.objects, dir);
  store.append({ task_id: id, actor: ctl, type: "command", payload: { command: "evidence_stored", ...stored } });
  if (end !== null) store.append({ task_id: id, actor: ctl, type: "state_changed", from: "RECEIVED", to: end, payload: {} });
  else store.append({ task_id: id, actor: ctl, type: "state_changed", from: "RECEIVED", to: "BUILDING", payload: {} });
  for (const d of [worktreeDir(home, id), sessionDir(home, id), join(home.root, "evals", "captured", `${id}-review`)]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f"), id);
  }
  return { id, artifact: c.artifacts[0]?.digest ?? "", transcript: sha256(`{"said":"${id}"}\n`), tree: stored.tree, json: files["task.json"] };
}

const exports = (task: string) => JSON.stringify({ received_at: "x", signal: "logs", body: { resourceLogs: [{ resource: { attributes: [{ key: "factory.task_id", value: { stringValue: task } }] }, scopeLogs: [] }] } });

describe("retention per profile", () => {
  it("takes the shorter of the profile's and the config's, kind by kind", () => {
    expect(effectiveRetention({ bundles: 30, transcripts: 60, otel: 400 }, CONFIG)).toEqual({ bundles: 30, transcripts: 30, otel: 30 });
    expect(effectiveRetention(null, CONFIG)).toEqual(CONFIG);
  });

  it("expires finished tasks' evidence by their own retention, in the home and the replica, and leaves the rest", async () => {
    const root = join(scratch, "a");
    mkdirSync(root, { recursive: true });
    const home = factoryHome({ FACTORY_HOME: join(root, "home") });
    ensureHome(home);
    initReplica(home, join(root, "replica"), "op");
    const clock = { t: START };
    const store = EventStore.open(home.db, { now: () => new Date(clock.t) });
    const short = profile(root, "short", { bundles: 30, transcripts: 10, otel: 10 });
    const long = profile(root, "long", { bundles: 400, transcripts: 400, otel: 400 });
    const old = seed(home, store, clock, 0, short, "DONE");
    const recent = seed(home, store, clock, 25, short, "FAILED");
    const capped = seed(home, store, clock, 0, long, "DONE");
    const running = seed(home, store, clock, 15, short, null);
    const lost = seed(home, store, clock, 39, join(root, "gone.yaml"), "DONE");
    mkdirSync(otelDir(home.root), { recursive: true });
    writeFileSync(join(otelDir(home.root), "2026-06-01.ndjson"), [old, recent, capped, running, lost].map((t) => exports(t.id)).join("\n") + "\n");
    const validator = createValidator();
    const now = new Date(START + 40 * DAY);
    const plan = planRetention({ store, config: CONFIG, policyFor: profilePolicy(home, store, validator), now });
    expect(plan.expire.map((x) => [x.task_id, x.scope, x.age_days, x.days])).toEqual([
      [old.id, "bundle", 40, 30],
      [recent.id, "transcripts", 15, 10],
      [capped.id, "transcripts", 40, 30],
    ]);
    expect(plan.otel).toEqual([old.id, recent.id, capped.id]);
    expect(plan.unfinished).toEqual([]);
    expect(plan.fallback).toEqual([lost.id]);
    // Planning changes nothing.
    expect(existsSync(join(runDir(home, old.id), "triage.json"))).toBe(true);

    const r = prune({ home, store, plan, by: "op" });
    expect(r).toMatchObject({ otel: 3 });
    // The bundle: everything but task.json, with its directories; the shared task.md stays for the others.
    expect(readdirSync(runDir(home, old.id))).toEqual(["task.json"]);
    for (const d of [worktreeDir(home, old.id), sessionDir(home, old.id), join(home.root, "evals", "captured", `${old.id}-review`)]) expect(existsSync(d), d).toBe(false);
    for (const d of [old.artifact, old.transcript, old.tree]) expect(hasObject(home.objects, d), d).toBe(false);
    expect(hasObject(home.objects, old.json)).toBe(true);
    expect(hasObject(home.objects, sha256("Change the rounding rule.\n"))).toBe(true);
    // Transcripts: the transcripts and the session go; the artifacts, the tree and the worktree stay.
    for (const t of [recent, capped]) {
      expect(existsSync(join(runDir(home, t.id), "transcripts"))).toBe(false);
      expect(existsSync(sessionDir(home, t.id))).toBe(false);
      expect(existsSync(join(runDir(home, t.id), "triage.json"))).toBe(true);
      expect(existsSync(worktreeDir(home, t.id))).toBe(true);
      expect(hasObject(home.objects, t.transcript)).toBe(false);
      expect([hasObject(home.objects, t.artifact), hasObject(home.objects, t.tree)]).toEqual([true, true]);
    }
    // An unfinished task and one past nothing are untouched, and the record names what expired.
    for (const t of [running, lost]) expect(hasObject(home.objects, t.transcript)).toBe(true);
    expect(expiredScopes(store.events(old.id))).toEqual(new Set(["bundle"]));
    expect(store.events(old.id).some((e) => e.type === "task_created")).toBe(true);
    expect(taskRecord(home, store, old.id)?.title).toBe(`task ${old.id}`);
    expect(readOtel(otelDir(home.root)).length).toBe(2);
    // The replica deleted the same, from its own record.
    const replicaObjects = join(root, "replica", "objects");
    for (const d of [old.artifact, old.tree, recent.transcript]) expect(hasObject(replicaObjects, d), d).toBe(false);
    expect(hasObject(replicaObjects, recent.artifact)).toBe(true);

    // Again, the same day: nothing more to do.
    const again = planRetention({ store, config: CONFIG, policyFor: profilePolicy(home, store, validator), now });
    expect(again.expire).toEqual([]);
    expect(prune({ home, store, plan: again, by: "op" })).toMatchObject({ objects: 0, paths: 0 });

    // Age counts from the task's own last activity, not from its expiry's record: 31 days on, `recent` reaches its bundles' 30.
    const later = planRetention({ store, config: CONFIG, policyFor: profilePolicy(home, store, validator), now: new Date(START + 56 * DAY) });
    expect(later.expire.map((x) => [x.task_id, x.scope])).toEqual([[recent.id, "bundle"]]);
    expect(later.unfinished).toEqual([{ task_id: running.id, age_days: 41 }]);

    // A restore brings back no expired file.
    const back = factoryHome({ FACTORY_HOME: join(root, "restored") });
    await restore(join(root, "replica"), back);
    expect(readdirSync(runDir(back, old.id))).toEqual(["task.json"]);
    expect(existsSync(join(runDir(back, recent.id), "transcripts"))).toBe(false);
    expect(existsSync(join(runDir(back, recent.id), "triage.json"))).toBe(true);
    store.close();
  });

  it("completes an expiry a crash left recorded but not applied", () => {
    const root = join(scratch, "b");
    mkdirSync(root, { recursive: true });
    const home = factoryHome({ FACTORY_HOME: join(root, "home") });
    ensureHome(home);
    const clock = { t: START };
    const store = EventStore.open(home.db, { now: () => new Date(clock.t) });
    const t = seed(home, store, clock, 0, profile(root, "p", CONFIG), "DONE");
    store.append({ task_id: t.id, actor: op, type: "command", payload: { command: "evidence_expired", scope: "bundle", age_days: 200, days: 180 } });
    expect(hasObject(home.objects, t.artifact)).toBe(true);
    expect(applyExpiries(store, home.objects, home)).toMatchObject({ objects: 4 });
    expect(hasObject(home.objects, t.artifact)).toBe(false);
    expect(readdirSync(runDir(home, t.id))).toEqual(["task.json"]);
    expect(applyExpiries(store, home.objects, home)).toEqual({ objects: 0, paths: 0 });
    store.close();
  });
});
