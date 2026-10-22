// Purging tasks (ADR 0003): the one way the factory deletes what it recorded. Offboarding a
// target purges every task of it. A purge is planned in full first, into a journal under
// `$FACTORY_HOME/purges/`: the tasks, every object only they referenced, and every path of
// theirs under the home. It then runs step by step, recording each step in the journal, so a
// crash anywhere resumes where it stopped and every step is safe to run twice.
//
// The tombstones are written first, with the tasks' events deleted in the same transaction: from
// then on the purge is on the record, the ids are never reused, and nothing more can be written
// for those tasks. Then the objects, the paths and the OTel lines go, the store is compacted so
// nothing deleted survives in its file, and the replica completes the same purge from its own
// record. Run it only while the factory is idle: no run, no serve, no live lease.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { fileDigest, TMP, writeAtomic } from "../fsutil.ts";
import { runDir, sessionDir, worktreeDir, type Home } from "../home.ts";
import { otelDir, filterOtel } from "../otel/collector.ts";
import { makeWritable } from "../release/install.ts";
import { EventStore, type FactoryEvent, type Tombstone } from "../store/events.ts";
import { deleteObject, hasObject, listObjects, objectPath, readObject } from "./objects.ts";
import { deletionSet, taskRefs } from "./refs.ts";
import { readReplicaConfig, syncReplica } from "./replica.ts";

export const PURGE_STEPS = ["db", "objects", "paths", "otel", "compact", "replica"] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

export interface PurgeJournal {
  schema_version: 1;
  id: string;
  created_at: string;
  by: string;
  reason: string;
  tasks: Tombstone[];
  /** Objects only the purged tasks referenced, and objects no task references (a crashed write's), trees last. */
  objects: string[];
  /** What goes from the home: the tasks' run, worktree and session directories, their captures, and the caller's own paths. */
  paths: string[];
  done: PurgeStep[];
}

export interface PurgeOutcome {
  tasks: number;
  events: number;
  objects: number;
  paths: number;
  otel: number;
}

export class PurgeError extends Error {}

/** An object no task names is a crashed write's; one younger than this may be a live writer's, about to be named. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) return walk(full);
    return s.isFile() ? [full] : [];
  });
}

const journalPath = (home: Home, id: string): string => join(home.purges, `${id}.json`);

/** A target's repository from the GitHub remote a task was created with, as `githubRemote` writes it. */
const GITHUB_REMOTE = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\.git$/;

function writeJournal(home: Home, j: PurgeJournal): void {
  mkdirSync(home.purges, { recursive: true, mode: 0o700 });
  writeAtomic(journalPath(home, j.id), `${JSON.stringify(j, null, 2)}\n`);
}

/**
 * Plans a purge of these tasks and writes its journal; nothing is deleted yet. A task already
 * purged is skipped; an id the store has never seen is an error.
 */
export function planPurge(home: Home, store: EventStore, taskIds: readonly string[], o: { by: string; reason: string; now?: Date; paths?: readonly string[] }): PurgeJournal {
  const now = o.now ?? new Date();
  const known = new Set(store.taskIds());
  const purged = new Set(store.tombstones().map((t) => t.task_id));
  const unknown = taskIds.filter((id) => !known.has(id) && !purged.has(id));
  if (unknown.length > 0) throw new PurgeError(`no such task: ${unknown.join(", ")}`);
  const ids = taskIds.filter((id) => known.has(id));
  const byTask = new Map(store.taskIds().map((id) => [id, store.events(id)] as const));
  const events = (id: string): FactoryEvent[] => byTask.get(id) ?? [];
  const kept = [...byTask.keys()].filter((id) => !ids.includes(id));
  // The run directories' files too: a file whose tree went missing is still the task's.
  const local = new Map(ids.map((id) => [id, walk(runDir(home, id)).map(fileDigest).filter((d) => hasObject(home.objects, d))] as const));
  const owned = deletionSet(ids.map(events), kept.map(events), home.objects, [...local.values()].flat());
  const named = new Set<string>([...local.values()].flat());
  for (const id of byTask.keys()) for (const d of taskRefs(events(id), home.objects).live) named.add(d);
  const orphans = listObjects(home.objects).filter((d) => !named.has(d) && now.getTime() - statSync(objectPath(home.objects, d)).mtimeMs > ORPHAN_AGE_MS).sort();
  const objects = [...orphans, ...owned];
  const gone = new Set(objects);
  const captured = join(home.root, "evals", "captured");
  const captures = existsSync(captured) ? readdirSync(captured) : [];
  const tasks: Tombstone[] = ids.map((id) => ({
    task_id: id,
    purged_at: now.toISOString(),
    events: events(id).length,
    files: walk(runDir(home, id)).length,
    objects: [...new Set([...taskRefs(events(id), home.objects).digests, ...(local.get(id) ?? [])])].filter((d) => gone.has(d)).length,
  }));
  const paths = [
    ...ids.flatMap((id) => [runDir(home, id), worktreeDir(home, id), sessionDir(home, id), ...captures.filter((c) => c.startsWith(`${id}-`)).map((c) => join(captured, c))]),
    ...(o.paths ?? []),
  ];
  for (const p of paths) {
    const rel = relative(home.root, p);
    if (rel === "" || rel.startsWith("..")) throw new PurgeError(`${p} is not inside ${home.root}`);
  }
  const j: PurgeJournal = { schema_version: 1, id: `${now.toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`, created_at: now.toISOString(), by: o.by, reason: o.reason, tasks, objects, paths, done: [] };
  writeJournal(home, j);
  return j;
}

/** In the replica: completes the purge from its own record, then deletes the journal's other objects no replica task names. */
function purgeReplica(home: Home, j: PurgeJournal): void {
  const config = readReplicaConfig(home);
  if (config === null) return;
  syncReplica(home);
  const objects = join(config.path, "objects");
  const store = EventStore.open(join(config.path, "factory.db"));
  try {
    const named = new Set<string>();
    for (const id of store.taskIds()) for (const d of taskRefs(store.events(id), objects).live) named.add(d);
    for (const d of j.objects) if (!named.has(d)) deleteObject(objects, d);
  } finally {
    store.close();
  }
}

/**
 * Runs a journal's remaining steps, recording each as it finishes, then deletes the journal.
 * `probe` marks the instant after a step's work and before its record (kill-point tests).
 */
export function runJournal(home: Home, store: EventStore, j: PurgeJournal, o: { probe?: (step: PurgeStep) => void; log?: (line: string) => void } = {}): PurgeOutcome {
  const ids = new Set(j.tasks.map((t) => t.task_id));
  const out: PurgeOutcome = { tasks: j.tasks.length, events: 0, objects: 0, paths: 0, otel: 0 };
  for (const step of PURGE_STEPS) {
    if (j.done.includes(step)) continue;
    if (step === "db") out.events = store.purgeTasks(j.tasks);
    else if (step === "objects") out.objects = j.objects.filter((d) => deleteObject(home.objects, d)).length;
    else if (step === "paths") {
      for (const p of j.paths) {
        if (!existsSync(p)) continue;
        makeWritable(p);
        rmSync(p, { recursive: true, force: true });
        out.paths++;
      }
    } else if (step === "otel") out.otel = filterOtel(otelDir(home.root), (t) => ids.has(t)).removed;
    else if (step === "compact") store.compact();
    else purgeReplica(home, j);
    o.probe?.(step);
    j.done.push(step);
    writeJournal(home, j);
    o.log?.(`purge ${j.id}: ${step} done`);
  }
  rmSync(journalPath(home, j.id), { force: true });
  return out;
}

/** Purges that stopped part-way, oldest first: run each again with runJournal. */
export function pendingJournals(home: Home): PurgeJournal[] {
  if (!existsSync(home.purges)) return [];
  return readdirSync(home.purges).filter((f) => f.endsWith(".json") && !TMP.test(f)).sort().map((f) => JSON.parse(readFileSync(join(home.purges, f), "utf8")) as PurgeJournal);
}

/**
 * Every task of a target, and the tasks whose target cannot be told. The record decides: the
 * task.json object its task_created event names, else its run directory's task.json, else the
 * GitHub remote or the issue the event names. A purge stops while any task is unplaced.
 */
export function tasksOfTarget(home: Home, store: EventStore, repo: string): { tasks: string[]; unknown: string[] } {
  const tasks: string[] = [];
  const unknown: string[] = [];
  for (const id of store.taskIds()) {
    const created = store.events(id).find((e) => e.type === "task_created");
    const target = ((): string | null => {
      const digest = ((created?.payload["files"] ?? {}) as Record<string, string>)["task.json"];
      try {
        if (digest !== undefined && hasObject(home.objects, digest)) return (JSON.parse(readObject(home.objects, digest).toString("utf8")) as { target: { repo: string } }).target.repo;
        return (JSON.parse(readFileSync(join(runDir(home, id), "task.json"), "utf8")) as { target: { repo: string } }).target.repo;
      } catch {
        const given = created?.payload["remote"];
        const remote = typeof given === "string" ? GITHUB_REMOTE.exec(given)?.[1] : undefined;
        if (remote !== undefined) return remote;
        const issue = created?.payload["issue"] as { repo?: string } | undefined;
        return issue?.repo ?? null;
      }
    })();
    if (target === null) unknown.push(id);
    else if (target === repo) tasks.push(id);
  }
  return { tasks, unknown };
}
