// The replica and the restore (ROADMAP P2-07, ADR 0001): durability without Litestream.
//
// The event store is append-only, so replicating it is copying the rows the replica lacks.
// Every second that a factoryctl writer runs (serve, a run, a worker), and after every command,
// syncReplica copies the new events by their row id into a SQLite replica on the operator's
// other volume, replaces its copy of the leases, and copies the objects it lacks from the
// object store, each checked against its digest. The replica is a directory: `factory.db`, the
// same `objects/` layout, and `REPLICA.json`, which says whose replica it is and how far it got.
//
// A restore rebuilds a home from the replica: the database (a consistent SQLite backup), the
// objects, and each task's run directory, from the files its task_created event names, its
// latest evidence tree, and every artifact it committed since, all read back by digest. A
// restored task's clone is rebuilt on its next run from the target and its latest committed
// candidate bundle (stages/pipeline.ts); the outbox finds on GitHub whatever it had already
// pushed or opened.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writeAtomic } from "../fsutil.ts";
import { ensureHome, runDir, type Home } from "../home.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import { hasObject, listObjects, objectPath, readObject, readTree } from "./objects.ts";

export const REPLICA_MARKER = "REPLICA.json";

export interface ReplicaConfig {
  schema_version: 1;
  path: string;
  created_at: string;
  by: string;
}

export interface ReplicaState {
  schema_version: 1;
  /** The home this is a replica of. */
  source: string;
  last_id: number;
  events: number;
  objects: number;
  synced_at: string;
}

export class ReplicaError extends Error {}

export function readReplicaConfig(home: Home): ReplicaConfig | null {
  try {
    return JSON.parse(readFileSync(home.replicaConfig, "utf8")) as ReplicaConfig;
  } catch {
    return null;
  }
}

export function readReplicaState(dir: string): ReplicaState | null {
  try {
    return JSON.parse(readFileSync(join(dir, REPLICA_MARKER), "utf8")) as ReplicaState;
  } catch {
    return null;
  }
}

/** Whether two paths are on one filesystem: a replica there survives no disk failure. */
export function sameVolume(a: string, b: string): boolean {
  return statSync(a).dev === statSync(b).dev;
}

/**
 * Points the home at a replica directory, outside the home and owned by no other home. The
 * directory may be on the same volume (a warning, which `doctor` repeats), since some hosts
 * have only one; G2-6 expects another.
 */
export function initReplica(home: Home, dir: string, by: string, now: Date = new Date()): { config: ReplicaConfig; sameVolume: boolean } {
  if (!isAbsolute(dir)) throw new ReplicaError("the replica directory must be an absolute path");
  const path = resolve(dir);
  const rel = relative(home.root, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new ReplicaError(`the replica must live outside ${home.root}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const state = readReplicaState(path);
  if (state !== null && state.source !== home.root) throw new ReplicaError(`${path} is the replica of ${state.source}`);
  const config: ReplicaConfig = { schema_version: 1, path, created_at: now.toISOString(), by };
  writeAtomic(home.replicaConfig, `${JSON.stringify(config, null, 2)}\n`);
  return { config, sameVolume: sameVolume(home.root, path) };
}

export interface SyncResult {
  events: number;
  objects: number;
  last_id: number;
  synced_at: string;
}

/**
 * Copies what the replica lacks; returns what it copied, or null when no replica is set. A
 * missing replica directory is an error, never created here: on an unmounted volume that would
 * quietly put the replica back on the home's own disk. `cache` keeps the replica's object list
 * between syncs in one process, so a sync reads the replica's disk only for what it copies.
 */
export function syncReplica(home: Home, now: Date = new Date(), cache: { objects?: Set<string> } = {}): SyncResult | null {
  const config = readReplicaConfig(home);
  if (config === null || !existsSync(home.db)) return null;
  const dir = config.path;
  if (!existsSync(dir)) throw new ReplicaError(`the replica directory ${dir} is missing; is its volume mounted?`);
  const previous = readReplicaState(dir);
  if (previous !== null && previous.source !== home.root) throw new ReplicaError(`${dir} is the replica of ${previous.source}`);
  const dbPath = join(dir, "factory.db");
  // The replica's schema is the store's own: open it once through the store, so its migrations run.
  if (!existsSync(dbPath)) EventStore.open(dbPath).close();
  // Several writers may sync at once (a serve and its workers): the replica's write lock orders
  // them, and each copies only the rows after the replica's last one, read under that lock.
  const primary = new DatabaseSync(home.db, { readOnly: true });
  const replica = new DatabaseSync(dbPath);
  let events: number;
  let lastId: number;
  let total: number;
  try {
    // The busy timeout comes first: switching to WAL takes a lock another syncing process may hold.
    replica.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    primary.exec("PRAGMA busy_timeout = 5000;");
    replica.exec("BEGIN IMMEDIATE");
    try {
      lastId = (replica.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number }).id;
      const rows = primary.prepare("SELECT id, task_id, seq, type, body FROM events WHERE id > ? ORDER BY id").all(lastId) as { id: number; task_id: string; seq: number; type: string; body: string }[];
      const leases = primary.prepare("SELECT task_id, holder, epoch, expires_at FROM leases").all() as { task_id: string; holder: string; epoch: number; expires_at: number }[];
      const version = primary.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const insert = replica.prepare("INSERT INTO events (id, task_id, seq, type, body) VALUES (?, ?, ?, ?, ?)");
      for (const r of rows) {
        insert.run(r.id, r.task_id, r.seq, r.type, r.body);
        lastId = r.id;
      }
      replica.exec("DELETE FROM leases");
      const lease = replica.prepare("INSERT INTO leases (task_id, holder, epoch, expires_at) VALUES (?, ?, ?, ?)");
      for (const l of leases) lease.run(l.task_id, l.holder, l.epoch, l.expires_at);
      if (version !== undefined) replica.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(version.value);
      total = (replica.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      replica.exec("COMMIT");
      events = rows.length;
    } catch (e) {
      replica.exec("ROLLBACK");
      throw e;
    }
  } finally {
    primary.close();
    replica.close();
  }
  // Objects after events: an event can name an object the replica gets on the next sync, never the reverse order on disk.
  const target = join(dir, "objects");
  const have = (cache.objects ??= new Set(listObjects(target)));
  let objects = 0;
  for (const digest of listObjects(home.objects)) {
    if (have.has(digest)) continue;
    copyObject(home.objects, target, digest);
    have.add(digest);
    objects++;
  }
  const state: ReplicaState = { schema_version: 1, source: home.root, last_id: lastId, events: total, objects: have.size, synced_at: now.toISOString() };
  writeAtomic(join(dir, REPLICA_MARKER), `${JSON.stringify(state, null, 2)}\n`);
  return { events, objects, last_id: lastId, synced_at: state.synced_at };
}

function copyObject(from: string, to: string, digest: string): void {
  const content = readObject(from, digest);
  const path = objectPath(to, digest);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, content);
}

/** Syncs now and then every `ms` while the process lives; a failed sync is logged and retried. */
export function keepReplica(home: Home, log: (line: string) => void, ms = 1000): { stop: () => void } {
  if (readReplicaConfig(home) === null) return { stop: () => undefined };
  let failing = false;
  const cache: { objects?: Set<string> } = {};
  const tick = (): void => {
    try {
      syncReplica(home, new Date(), cache);
      if (failing) log("replica: syncing again");
      failing = false;
    } catch (e) {
      if (!failing) log(`replica: sync failed (${e instanceof Error ? e.message : String(e)}); retrying every ${String(ms)} ms`);
      failing = true;
    }
  };
  tick();
  const timer = setInterval(tick, ms);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      tick();
    },
  };
}

export interface ReplicaStatus {
  config: ReplicaConfig;
  state: ReplicaState | null;
  /** Events in the home the replica does not have yet. */
  lag_events: number;
  sameVolume: boolean;
}

export function replicaStatus(home: Home): ReplicaStatus | null {
  const config = readReplicaConfig(home);
  if (config === null) return null;
  const state = readReplicaState(config.path);
  let primaryLast = 0;
  if (existsSync(home.db)) {
    const db = new DatabaseSync(home.db, { readOnly: true });
    try {
      primaryLast = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number }).id;
    } finally {
      db.close();
    }
  }
  return { config, state, lag_events: Math.max(0, primaryLast - (state?.last_id ?? 0)), sameVolume: existsSync(config.path) && sameVolume(home.root, config.path) };
}

// --- restore ---------------------------------------------------------------------------

export interface RestoreResult {
  tasks: number;
  events: number;
  objects: number;
  files: number;
  /** Files an event names whose object the replica does not have. */
  missing: string[];
  last_id: number;
  synced_at: string | null;
}

/** What a task's run directory should hold, by path: the latest version of each file the record names. */
export function runFiles(events: readonly FactoryEvent[], objects: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const e of events) {
    if (e.type === "task_created") {
      for (const [path, digest] of Object.entries((e.payload["files"] ?? {}) as Record<string, string>)) files.set(path, digest);
    } else if (e.type === "command" && e.payload["command"] === "evidence_stored" && typeof e.payload["tree"] === "string") {
      if (!hasObject(objects, e.payload["tree"])) continue;
      for (const [path, digest] of Object.entries(readTree(objects, e.payload["tree"]).files)) files.set(path, digest);
    } else if (e.type === "artifact_committed") {
      for (const a of (e.payload["artifacts"] ?? []) as { path: string; digest: string }[]) files.set(a.path, a.digest);
    }
  }
  return files;
}

/** Rebuilds `home` from a replica. The home must hold no store yet: a restore never overwrites one. */
export async function restore(from: string, home: Home): Promise<RestoreResult> {
  const state = readReplicaState(from);
  const source = join(from, "factory.db");
  if (state === null || !existsSync(source)) throw new ReplicaError(`${from} is not a factory replica`);
  if (existsSync(home.db)) throw new ReplicaError(`${home.db} exists; restore into an empty home`);
  ensureHome(home);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, home.db);
  } finally {
    db.close();
  }
  const fromObjects = join(from, "objects");
  let objects = 0;
  for (const digest of listObjects(fromObjects)) {
    if (hasObject(home.objects, digest)) continue;
    copyObject(fromObjects, home.objects, digest);
    objects++;
  }
  const store = EventStore.open(home.db);
  const missing: string[] = [];
  let files = 0;
  let events = 0;
  try {
    const ids = store.taskIds();
    for (const id of ids) {
      const all = store.events(id);
      events += all.length;
      const dir = runDir(home, id);
      for (const [path, digest] of runFiles(all, home.objects)) {
        if (!hasObject(home.objects, digest)) {
          missing.push(`${id}/${path}`);
          continue;
        }
        const file = join(dir, path);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeAtomic(file, readObject(home.objects, digest));
        files++;
      }
    }
    return { tasks: ids.length, events, objects, files, missing, last_id: state.last_id, synced_at: state.synced_at };
  } finally {
    store.close();
  }
}
