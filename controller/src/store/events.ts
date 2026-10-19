// The event store: SQLite in WAL mode with append-only events (ROADMAP §2.4, principle 8).
// Task state is a fold over events; nothing here updates or deletes an event, and triggers make
// sure nothing else can either.
//
// Leases and fencing (P2-03): a task's writer holds a lease, and every lease grant raises the
// task's epoch. An event factoryctl writes for a task carries the epoch its writer was granted,
// and the store rejects it, inside the same transaction as the write, unless that epoch is the
// task's current one. A writer whose lease was taken over can therefore write nothing more,
// however long it keeps running. Leases are coordination state, not history: their table is
// updated in place, and each grant is also recorded as an event.
import { DatabaseSync } from "node:sqlite";
import { createValidator, type Validator } from "../schemas/validate.ts";

export type State =
  | "RECEIVED" | "TRIAGED" | "SPECIFIED" | "NEEDS_HUMAN" | "BUILDING" | "VERIFYING" | "REVIEWING" | "REMEDIATING" | "POLICY"
  | "AUTO_APPROVED" | "MERGE_QUEUED" | "MERGED" | "DEPLOYING" | "OBSERVING" | "DONE" | "ROLLED_BACK" | "BLOCKED" | "FAILED"
  | "CANCELLED" | "SUPERSEDED";

export type EventType =
  | "task_created" | "state_changed" | "stage_started" | "stage_completed" | "stage_failed" | "command" | "side_effect_intent" | "side_effect_done"
  | "artifact_committed" | "alarm" | "usage";

export interface Actor {
  kind: "factoryctl" | "operator" | "agent" | "github";
  id: string;
}

/** One event (schemas/event.schema.json). */
export interface FactoryEvent {
  schema_version: 1;
  seq: number;
  task_id: string;
  ts: string;
  epoch: number;
  actor: Actor;
  type: EventType;
  from?: State;
  to?: State;
  payload: Record<string, unknown>;
}

export type NewEvent = Omit<FactoryEvent, "schema_version" | "seq" | "ts" | "epoch"> & { epoch?: number };

/** A task's lease: its holder (a factoryctl process, `pid@start`), its epoch, and when it lapses (ms since the epoch). */
export interface Lease {
  task_id: string;
  holder: string;
  epoch: number;
  expires_at: number;
}

/** A target's merge lease (P2-06): the one task that may check its base and merge into it now. */
export interface MergeLease {
  target: string;
  task_id: string;
  holder: string;
  acquired_at: string;
}

/** Forward-only migrations: each runs once, in order, inside a transaction. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     type TEXT NOT NULL,
     body TEXT NOT NULL,
     UNIQUE (task_id, seq)
   );
   CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
   CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;`,
  `CREATE TABLE leases (
     task_id TEXT PRIMARY KEY,
     holder TEXT NOT NULL,
     epoch INTEGER NOT NULL CHECK (epoch > 0),
     expires_at INTEGER NOT NULL
   );`,
  // Transient: a lease whose holder is gone is free, so the replica does not copy them.
  `CREATE TABLE merge_leases (
     target TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     holder TEXT NOT NULL,
     acquired_at TEXT NOT NULL
   );`,
];

export class EventError extends Error {}
/** A write from a lease that is no longer the task's current one. */
export class StaleEpochError extends EventError {}
/** A lease another live writer holds. */
export class LeaseHeldError extends EventError {}

export class EventStore {
  readonly #db: DatabaseSync;
  readonly #validator: Validator;
  readonly #now: () => Date;

  private constructor(db: DatabaseSync, validator: Validator, now: () => Date) {
    this.#db = db;
    this.#validator = validator;
    this.#now = now;
  }

  static open(path: string, opts: { validator?: Validator; now?: () => Date } = {}): EventStore {
    const db = new DatabaseSync(path);
    // The busy timeout comes first: switching to WAL takes a lock another process may hold.
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    // The version is read under the write lock, so two processes opening a new store at once
    // (serve and a worker, or two replica syncs) migrate it once between them.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const current = row === undefined ? 0 : Number(row.value);
      if (current > MIGRATIONS.length) throw new EventError(`factory.db is at schema ${String(current)}; this factoryctl knows ${String(MIGRATIONS.length)}`);
      for (let v = current; v < MIGRATIONS.length; v++) {
        db.exec(MIGRATIONS[v] ?? "");
        db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(v + 1));
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      db.close();
      throw e;
    }
    return new EventStore(db, opts.validator ?? createValidator(), opts.now ?? (() => new Date()));
  }

  /** The epoch this store's writer holds per task, from its own lease grants. */
  readonly #epochs = new Map<string, number>();

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.#db.exec("COMMIT");
      return r;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Inside a transaction: fence, validate and insert one event. */
  #insert(event: NewEvent): FactoryEvent {
    const epoch = event.epoch ?? this.#epochs.get(event.task_id) ?? 0;
    if (event.actor.kind === "factoryctl") {
      const lease = this.#lease(event.task_id);
      if (lease !== null && lease.epoch !== epoch) throw new StaleEpochError(`${event.task_id}: a write at epoch ${String(epoch)} is stale; the task's lease is at epoch ${String(lease.epoch)} (${lease.holder})`);
    }
    const last = this.#db.prepare("SELECT MAX(seq) AS seq FROM events WHERE task_id = ?").get(event.task_id) as { seq: number | null };
    const full: FactoryEvent = { schema_version: 1, seq: (last.seq ?? 0) + 1, ts: this.#now().toISOString(), ...event, epoch };
    const check = this.#validator.validate("event.schema.json", full);
    if (!check.valid) throw new EventError(`invalid event: ${check.errors.join("; ")}`);
    this.#db.prepare("INSERT INTO events (task_id, seq, type, body) VALUES (?, ?, ?, ?)").run(full.task_id, full.seq, full.type, JSON.stringify(full));
    return full;
  }

  /** Validate and append one event; the store assigns seq and ts, and fences factoryctl's writes. */
  append(event: NewEvent): FactoryEvent {
    return this.#tx(() => this.#insert(event));
  }

  /**
   * Append an event built from the task's events as they are inside the write's transaction, so
   * a decision taken on them (a lifecycle transition) cannot race another writer.
   */
  appendWith(taskId: string, build: (events: () => FactoryEvent[]) => NewEvent): FactoryEvent {
    return this.#tx(() => this.#insert(build(() => this.events(taskId))));
  }

  #lease(taskId: string): Lease | null {
    const row = this.#db.prepare("SELECT task_id, holder, epoch, expires_at FROM leases WHERE task_id = ?").get(taskId) as Lease | undefined;
    return row === undefined ? null : { task_id: row.task_id, holder: row.holder, epoch: row.epoch, expires_at: row.expires_at };
  }

  lease(taskId: string): Lease | null {
    return this.#lease(taskId);
  }

  leases(): Lease[] {
    const rows = this.#db.prepare("SELECT task_id, holder, epoch, expires_at FROM leases ORDER BY task_id").all() as unknown as Lease[];
    return rows.map((r) => ({ task_id: r.task_id, holder: r.holder, epoch: r.epoch, expires_at: r.expires_at }));
  }

  /**
   * Grant `holder` the task's lease at the next epoch, if `mayTake` accepts the lease it finds
   * (it decides whether a lease held by someone else is free to take: its holder dead, or killed
   * after it lapsed). The grant is recorded as an event at the new epoch.
   */
  acquireLease(taskId: string, holder: string, ttlMs: number, mayTake: (current: Lease) => boolean): Lease {
    return this.#tx(() => {
      const current = this.#lease(taskId);
      if (current !== null && current.holder !== holder && !mayTake(current)) {
        const lapsed = current.expires_at <= this.#now().getTime();
        throw new LeaseHeldError(`${taskId} is leased to ${current.holder} at epoch ${String(current.epoch)}${lapsed ? " (lapsed, but its holder was not stopped)" : ""}`);
      }
      const lease: Lease = { task_id: taskId, holder, epoch: (current?.epoch ?? 0) + 1, expires_at: this.#now().getTime() + ttlMs };
      this.#db.prepare("INSERT INTO leases (task_id, holder, epoch, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (task_id) DO UPDATE SET holder = excluded.holder, epoch = excluded.epoch, expires_at = excluded.expires_at").run(lease.task_id, lease.holder, lease.epoch, lease.expires_at);
      this.#epochs.set(taskId, lease.epoch);
      this.#insert({ task_id: taskId, actor: { kind: "factoryctl", id: "factoryctl" }, type: "command", payload: { command: "lease_acquired", holder, epoch: lease.epoch, ...(current === null ? {} : { from: { holder: current.holder, epoch: current.epoch } }) } });
      return lease;
    });
  }

  /** Extends a lease this writer still holds; a lease taken over meanwhile raises StaleEpochError. */
  renewLease(lease: Lease, ttlMs: number): Lease {
    return this.#tx(() => {
      const expires = this.#now().getTime() + ttlMs;
      const r = this.#db.prepare("UPDATE leases SET expires_at = ? WHERE task_id = ? AND holder = ? AND epoch = ?").run(expires, lease.task_id, lease.holder, lease.epoch);
      if (Number(r.changes) === 0) throw new StaleEpochError(`${lease.task_id}: the lease at epoch ${String(lease.epoch)} was taken over`);
      return { ...lease, expires_at: expires };
    });
  }

  /** Lets a lease lapse now, if this writer still holds it; its epoch stays, so the next grant raises it. */
  releaseLease(lease: Lease): void {
    this.#tx(() => {
      this.#db.prepare("UPDATE leases SET expires_at = 0 WHERE task_id = ? AND holder = ? AND epoch = ?").run(lease.task_id, lease.holder, lease.epoch);
    });
  }

  mergeLease(target: string): MergeLease | null {
    const row = this.#db.prepare("SELECT target, task_id, holder, acquired_at FROM merge_leases WHERE target = ?").get(target) as MergeLease | undefined;
    return row === undefined ? null : { target: row.target, task_id: row.task_id, holder: row.holder, acquired_at: row.acquired_at };
  }

  /**
   * Grants `taskId` the target's merge lease (P2-06), or returns null while another task's holder
   * may still act on it (`mayTake` decides: its holder is gone). The grant is on the task's record,
   * at the task's epoch, so a writer whose task lease was taken over cannot take it.
   */
  acquireMergeLease(target: string, taskId: string, holder: string, mayTake: (current: MergeLease) => boolean): MergeLease | null {
    return this.#tx(() => {
      const current = this.mergeLease(target);
      if (current !== null && current.task_id !== taskId && !mayTake(current)) return null;
      const lease: MergeLease = { target, task_id: taskId, holder, acquired_at: this.#now().toISOString() };
      this.#db.prepare("INSERT INTO merge_leases (target, task_id, holder, acquired_at) VALUES (?, ?, ?, ?) ON CONFLICT (target) DO UPDATE SET task_id = excluded.task_id, holder = excluded.holder, acquired_at = excluded.acquired_at").run(target, taskId, holder, lease.acquired_at);
      this.#insert({ task_id: taskId, actor: { kind: "factoryctl", id: "factoryctl" }, type: "command", payload: { command: "merge_lease", action: "acquired", target, holder, ...(current === null || current.task_id === taskId ? {} : { from: current.task_id }) } });
      return lease;
    });
  }

  /** Frees the target's merge lease if `taskId` still holds it. */
  releaseMergeLease(lease: MergeLease): void {
    this.#tx(() => {
      const r = this.#db.prepare("DELETE FROM merge_leases WHERE target = ? AND task_id = ? AND holder = ?").run(lease.target, lease.task_id, lease.holder);
      if (Number(r.changes) > 0) this.#insert({ task_id: lease.task_id, actor: { kind: "factoryctl", id: "factoryctl" }, type: "command", payload: { command: "merge_lease", action: "released", target: lease.target } });
    });
  }

  events(taskId: string): FactoryEvent[] {
    const rows = this.#db.prepare("SELECT body FROM events WHERE task_id = ? ORDER BY seq").all(taskId) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as FactoryEvent);
  }

  /** Every task's events, grouped by task in seq order (reports read the whole store). */
  allEvents(): FactoryEvent[] {
    const rows = this.#db.prepare("SELECT body FROM events ORDER BY task_id, seq").all() as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as FactoryEvent);
  }

  taskIds(): string[] {
    const rows = this.#db.prepare("SELECT DISTINCT task_id FROM events ORDER BY task_id").all() as { task_id: string }[];
    return rows.map((r) => r.task_id);
  }

  nextTaskId(): string {
    const ids = this.taskIds().map((id) => Number(id.slice(2)));
    return `T-${String(Math.max(0, ...ids) + 1).padStart(4, "0")}`;
  }

  /** For the append-only test only: run raw SQL against the store. */
  unsafeExec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}
