// The event store: SQLite in WAL mode with append-only events (ROADMAP §2.4, principle 8).
// Task state is a fold over events; nothing here updates or deletes a row, and triggers make
// sure nothing else can either.
import { DatabaseSync } from "node:sqlite";
import { createValidator, type Validator } from "../schemas/validate.ts";

export type State =
  | "RECEIVED" | "TRIAGED" | "SPECIFIED" | "NEEDS_HUMAN" | "BUILDING" | "VERIFYING" | "REVIEWING" | "REMEDIATING" | "POLICY"
  | "AUTO_APPROVED" | "MERGE_QUEUED" | "MERGED" | "DEPLOYING" | "OBSERVING" | "DONE" | "ROLLED_BACK" | "BLOCKED" | "FAILED"
  | "CANCELLED" | "SUPERSEDED";

export type EventType =
  | "task_created" | "state_changed" | "stage_started" | "stage_completed" | "stage_failed" | "command" | "side_effect_intent" | "side_effect_done";

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
];

export class EventError extends Error {}

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
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const current = row === undefined ? 0 : Number(row.value);
    if (current > MIGRATIONS.length) throw new EventError(`factory.db is at schema ${String(current)}; this factoryctl knows ${String(MIGRATIONS.length)}`);
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(MIGRATIONS[v] ?? "");
        db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(v + 1));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    return new EventStore(db, opts.validator ?? createValidator(), opts.now ?? (() => new Date()));
  }

  /** Validate and append one event; the store assigns seq and ts. */
  append(event: NewEvent): FactoryEvent {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.#db.prepare("SELECT MAX(seq) AS seq FROM events WHERE task_id = ?").get(event.task_id) as { seq: number | null };
      const full: FactoryEvent = { schema_version: 1, seq: (last.seq ?? 0) + 1, ts: this.#now().toISOString(), epoch: 0, ...event };
      const check = this.#validator.validate("event.schema.json", full);
      if (!check.valid) throw new EventError(`invalid event: ${check.errors.join("; ")}`);
      this.#db.prepare("INSERT INTO events (task_id, seq, type, body) VALUES (?, ?, ?, ?)").run(full.task_id, full.seq, full.type, JSON.stringify(full));
      this.#db.exec("COMMIT");
      return full;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  events(taskId: string): FactoryEvent[] {
    const rows = this.#db.prepare("SELECT body FROM events WHERE task_id = ? ORDER BY seq").all(taskId) as { body: string }[];
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
