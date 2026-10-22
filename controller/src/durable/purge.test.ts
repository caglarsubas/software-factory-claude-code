// Purging tasks (ADR 0003): a purge deletes exactly what its tasks alone held, in the home and
// in the replica, resumes from its journal wherever it stops, never comes back with a restore,
// and leaves no byte of a purged event in either database file.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { githubRemote } from "../git/repo.ts";
import { ensureHome, factoryHome, runDir, sessionDir, worktreeDir, type Home } from "../home.ts";
import { otelDir, readOtel } from "../otel/collector.ts";
import { commitArtifacts } from "../stages/commit.ts";
import { EventStore } from "../store/events.ts";
import { restoreDrill } from "./drill.ts";
import { hasObject, objectPath, putObject, storeTree } from "./objects.ts";
import { PURGE_STEPS, pendingJournals, planPurge, PurgeError, runJournal, tasksOfTarget, type PurgeStep } from "./purge.ts";
import { initReplica, restore, syncReplica } from "./replica.ts";

const scratch = mkdtempSync(join(tmpdir(), "purge-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const CANARY = "SF-GONE-CANARY-41c9";
const op = { kind: "operator" as const, id: "op" };
const ctl = { kind: "factoryctl" as const, id: "factoryctl" };
const HOUR = 60 * 60 * 1000;

/** A task on `repo` with its creation files, a committed artifact, a transcript and an evidence tree. */
function seed(home: Home, store: EventStore, repo: string, note: string): { id: string; artifact: string; tree: string } {
  const id = store.nextTaskId();
  const dir = runDir(home, id);
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  const body = "Change the rounding rule.\n";
  const json = `${JSON.stringify({ id, target: { repo, profile: "/p.yaml" }, title: note })}\n`;
  writeFileSync(join(dir, "task.md"), body);
  writeFileSync(join(dir, "task.json"), json);
  const files = { "task.md": putObject(home.objects, body), "task.json": putObject(home.objects, json) };
  store.append({ task_id: id, actor: op, type: "task_created", payload: { remote: githubRemote(repo), commit_protocol: 1, files } });
  const c = commitArtifacts(store, dir, { taskId: id, stage: "triage", label: "triage", round: 1 }, {}, [{ path: "triage.json", content: `{"note":"${note}"}\n` }], undefined, home.objects);
  writeFileSync(join(dir, "transcripts/triage.ndjson"), `{"text":"${note}"}\n`);
  const stored = storeTree(home.objects, dir);
  store.append({ task_id: id, actor: ctl, type: "command", payload: { command: "evidence_stored", ...stored } });
  store.append({ task_id: id, actor: ctl, type: "stage_failed", payload: { stage: "build", category: "gate_fail", reason: note } });
  for (const d of [worktreeDir(home, id), sessionDir(home, id)]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f"), note);
  }
  const capture = join(home.root, "evals", "captured", `${id}-review`);
  mkdirSync(capture, { recursive: true });
  writeFileSync(join(capture, "case.json"), note);
  return { id, artifact: c.artifacts[0]?.digest ?? "", tree: stored.tree };
}

const resource = (task: string) => ({ resource: { attributes: [{ key: "factory.task_id", value: { stringValue: task } }] }, scopeLogs: [] });

interface World {
  home: Home;
  store: EventStore;
  replica: string;
  kept: ReturnType<typeof seed>;
  gone: ReturnType<typeof seed>;
  shared: string;
  oldOrphan: string;
  youngOrphan: string;
}

let n = 0;
function world(): World {
  const root = join(scratch, `w-${String(++n)}`);
  const home = factoryHome({ FACTORY_HOME: join(root, "home") });
  ensureHome(home);
  const replica = join(root, "replica");
  initReplica(home, replica, "op");
  const store = EventStore.open(home.db);
  const kept = seed(home, store, "example/keep", "kept task");
  const gone = seed(home, store, "example/gone", CANARY);
  // An export per session, and one carrying both tasks' sessions.
  mkdirSync(otelDir(home.root), { recursive: true });
  writeFileSync(join(otelDir(home.root), "2026-10-22.ndjson"), [kept.id, gone.id, null].map((t) => JSON.stringify({ received_at: "x", signal: "logs", body: { resourceLogs: t === null ? [resource(kept.id), resource(gone.id)] : [resource(t)] } })).join("\n") + `\n{"torn":"${gone.id}`);
  // Objects no task names: a crashed write long ago, and one a live writer may be about to name.
  const oldOrphan = putObject(home.objects, `${CANARY} staged, never committed\n`);
  const past = new Date(Date.now() - 2 * HOUR);
  utimesSync(objectPath(home.objects, oldOrphan), past, past);
  const youngOrphan = putObject(home.objects, "just written\n");
  syncReplica(home);
  return { home, store, replica, kept, gone, shared: putObject(home.objects, "Change the rounding rule.\n"), oldOrphan, youngOrphan };
}

/** Every byte under `dir`, as text: a purged string must appear nowhere in it. */
const allBytes = (dir: string): string => {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => join(dir, f)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f).toString("latin1")).join("");
};

function expectPurged(w: World): void {
  const { home, store, kept, gone } = w;
  expect(store.events(gone.id)).toEqual([]);
  expect(store.tombstones().map((t) => t.task_id)).toEqual([gone.id]);
  expect(store.events(kept.id)).toHaveLength(4);
  expect(store.nextTaskId()).toBe("T-0003");
  for (const d of [gone.artifact, gone.tree, w.oldOrphan]) expect(hasObject(home.objects, d), d).toBe(false);
  for (const d of [kept.artifact, kept.tree, w.shared, w.youngOrphan]) expect(hasObject(home.objects, d), d).toBe(true);
  for (const p of [runDir(home, gone.id), worktreeDir(home, gone.id), sessionDir(home, gone.id), join(home.root, "evals", "captured", `${gone.id}-review`)]) expect(existsSync(p), p).toBe(false);
  for (const p of [runDir(home, kept.id), worktreeDir(home, kept.id), sessionDir(home, kept.id)]) expect(existsSync(p), p).toBe(true);
  const tasks = readOtel(otelDir(home.root)).flatMap((r) => ((r.body as { resourceLogs: ReturnType<typeof resource>[] }).resourceLogs).map((x) => x.resource.attributes[0]?.value.stringValue));
  expect(tasks).toEqual([kept.id, kept.id]);
  expect(pendingJournals(home)).toEqual([]);
  // The replica completed the same purge from its own record.
  const r = EventStore.open(join(w.replica, "factory.db"));
  try {
    expect(r.events(gone.id)).toEqual([]);
    expect(r.events(kept.id)).toHaveLength(4);
    expect(r.tombstones().map((t) => t.task_id)).toEqual([gone.id]);
  } finally {
    r.close();
  }
  for (const d of [gone.artifact, gone.tree, w.oldOrphan]) expect(hasObject(join(w.replica, "objects"), d), d).toBe(false);
  expect(hasObject(join(w.replica, "objects"), w.shared)).toBe(true);
  // No byte of the purged task anywhere, the databases' files included; the kept task's are there.
  for (const dir of [home.root, w.replica]) {
    const bytes = allBytes(dir);
    expect(bytes.includes(CANARY), dir).toBe(false);
    expect(bytes.includes("kept task"), dir).toBe(true);
  }
}

describe("a purge", () => {
  it("deletes what only its tasks held, in the home and the replica, and nothing else", () => {
    const w = world();
    const j = planPurge(w.home, w.store, [w.gone.id], { by: "op", reason: "offboard example/gone" });
    // Planned, not done: nothing is gone yet, and the journal is on disk.
    expect(w.store.events(w.gone.id)).toHaveLength(4);
    expect(pendingJournals(w.home).map((x) => x.id)).toEqual([j.id]);
    expect(j.objects).toEqual(expect.arrayContaining([w.gone.artifact, w.gone.tree, w.oldOrphan]));
    expect(j.objects).not.toContain(w.shared);
    expect(j.tasks).toEqual([expect.objectContaining({ task_id: w.gone.id, events: 4, files: 4 })]);
    const out = runJournal(w.home, w.store, j);
    expect(out).toMatchObject({ tasks: 1, events: 4, paths: 4, otel: 3 });
    expectPurged(w);
    w.store.close();
  });

  it.each(PURGE_STEPS.map((s) => [s]))("resumes from its journal after a crash at %s", (step: PurgeStep) => {
    const w = world();
    const j = planPurge(w.home, w.store, [w.gone.id], { by: "op", reason: "test" });
    expect(() => runJournal(w.home, w.store, j, { probe: (s) => {
      if (s === step) throw new Error(`killed at ${s}`);
    } })).toThrow(`killed at ${step}`);
    const [pending] = pendingJournals(w.home);
    expect(pending?.done).toEqual(PURGE_STEPS.slice(0, PURGE_STEPS.indexOf(step)));
    runJournal(w.home, w.store, pending ?? j);
    expectPurged(w);
    w.store.close();
  });

  it("waits for an unreachable replica, then completes, and later syncs copy only what is new", () => {
    const w = world();
    renameSync(w.replica, `${w.replica}.away`);
    const j = planPurge(w.home, w.store, [w.gone.id], { by: "op", reason: "test" });
    expect(() => runJournal(w.home, w.store, j)).toThrow(/is its volume mounted/);
    expect(pendingJournals(w.home)[0]?.done).toEqual(["db", "objects", "paths", "otel", "compact"]);
    renameSync(`${w.replica}.away`, w.replica);
    runJournal(w.home, w.store, pendingJournals(w.home)[0] ?? j);
    expectPurged(w);
    // A task after the purge: the replica copies its events alone, with no conflict over the purged rows' ids.
    const next = seed(w.home, w.store, "example/keep", "after the purge");
    expect(next.id).toBe("T-0003");
    expect(syncReplica(w.home)).toMatchObject({ events: 4, purged: [] });
    w.store.close();
  });

  it("is never undone by a restore, nor by the restore drill", async () => {
    const w = world();
    runJournal(w.home, w.store, planPurge(w.home, w.store, [w.gone.id], { by: "op", reason: "test" }));
    const back = factoryHome({ FACTORY_HOME: join(scratch, `restored-${String(n)}`) });
    const r = await restore(w.replica, back);
    expect(r.tasks).toBe(1);
    expect(existsSync(runDir(back, w.gone.id))).toBe(false);
    expect(readFileSync(join(runDir(back, w.kept.id), "triage.json"), "utf8")).toContain("kept task");
    const store = EventStore.open(back.db);
    expect(store.nextTaskId()).toBe("T-0003");
    store.close();
    const drill = await restoreDrill(w.home);
    expect(drill.damaged).toEqual([]);
    w.store.close();
  });

  it("is completed by a restore when the replica recorded it but had not done it", async () => {
    const w = world();
    // The replica holds the tombstone and still the task: as a sync interrupted mid-purge leaves it.
    const db = new DatabaseSync(join(w.replica, "factory.db"));
    db.prepare("INSERT INTO tombstones (task_id, purged_at, events, files, objects) VALUES (?, ?, 4, 4, 4)").run(w.gone.id, "2026-10-22T00:00:00.000Z");
    db.close();
    const back = factoryHome({ FACTORY_HOME: join(scratch, `restored-${String(n)}`) });
    await restore(w.replica, back);
    const store = EventStore.open(back.db);
    try {
      expect(store.events(w.gone.id)).toEqual([]);
      expect(store.events(w.kept.id)).toHaveLength(4);
    } finally {
      store.close();
    }
    expect(hasObject(back.objects, w.gone.artifact)).toBe(false);
    expect(existsSync(runDir(back, w.gone.id))).toBe(false);
    w.store.close();
  });

  it("finds a target's tasks from their record, and names the tasks it cannot place", () => {
    const w = world();
    // A task whose task.json is gone from both the store and its run directory: its GitHub remote places it.
    const byRemote = w.store.nextTaskId();
    w.store.append({ task_id: byRemote, actor: op, type: "task_created", payload: { remote: githubRemote("example/gone"), commit_protocol: 1, files: {} } });
    // One created against a local remote, with nothing else to go on.
    const local = w.store.nextTaskId();
    w.store.append({ task_id: local, actor: op, type: "task_created", payload: { remote: "/srv/git/x.git", commit_protocol: 1, files: {} } });
    expect(tasksOfTarget(w.home, w.store, "example/gone")).toEqual({ tasks: [w.gone.id, byRemote], unknown: [local] });
    expect(tasksOfTarget(w.home, w.store, "example/keep")).toEqual({ tasks: [w.kept.id], unknown: [local] });
    w.store.close();
  });

  it("refuses a task the store never had and a path outside the home", () => {
    const w = world();
    expect(() => planPurge(w.home, w.store, ["T-0099"], { by: "op", reason: "test" })).toThrow(PurgeError);
    expect(() => planPurge(w.home, w.store, [w.gone.id], { by: "op", reason: "test", paths: [scratch] })).toThrow(/is not inside/);
    expect(pendingJournals(w.home)).toEqual([]);
    w.store.close();
  });
});
