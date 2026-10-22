import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { EventError, EventStore } from "./events.ts";

const dir = mkdtempSync(join(tmpdir(), "events-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const fixed = () => new Date("2026-10-09T10:00:00Z");
const actor = { kind: "factoryctl" as const, id: "factoryctl" };

describe("EventStore", () => {
  const path = join(dir, "factory.db");
  const store = EventStore.open(path, { now: fixed });

  it("assigns per-task sequence numbers and timestamps", () => {
    const a = store.append({ task_id: "T-0001", actor, type: "task_created", payload: {} });
    const b = store.append({ task_id: "T-0001", actor, type: "state_changed", from: "RECEIVED", to: "TRIAGED", payload: {} });
    const c = store.append({ task_id: "T-0002", actor, type: "task_created", payload: {} });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);
    expect(a.ts).toBe("2026-10-09T10:00:00.000Z");
    expect(store.events("T-0001").map((e) => e.type)).toEqual(["task_created", "state_changed"]);
    expect(store.nextTaskId()).toBe("T-0003");
  });

  it("reads every task's events, grouped by task in seq order", () => {
    expect(store.allEvents().map((e) => `${e.task_id}#${String(e.seq)}`)).toEqual(["T-0001#1", "T-0001#2", "T-0002#1"]);
  });

  it("rejects events that do not match event.schema.json, and writes nothing", () => {
    expect(() => store.append({ task_id: "T-0001", actor, type: "state_changed", payload: {} })).toThrow(EventError);
    expect(() => store.append({ task_id: "T-0001", actor: { kind: "agent", id: "builder" }, type: "state_changed", from: "TRIAGED", to: "DONE", payload: {} })).toThrow(EventError);
    expect(store.events("T-0001")).toHaveLength(2);
  });

  it("is append-only: updates and deletes abort", () => {
    expect(() => {
      store.unsafeExec("UPDATE events SET type = 'command'");
    }).toThrow(/append-only/);
    expect(() => {
      store.unsafeExec("DELETE FROM events");
    }).toThrow(/append-only/);
    expect(store.events("T-0001")).toHaveLength(2);
  });

  it("reopens an existing database without re-running migrations", () => {
    store.close();
    const again = EventStore.open(path, { now: fixed });
    expect(again.events("T-0001")).toHaveLength(2);
    again.close();
  });
});

describe("deleting by record (ADR 0003)", () => {
  const path = join(dir, "purge.db");
  const store = EventStore.open(path, { now: fixed });
  const tomb = (task_id: string) => ({ task_id, purged_at: "2026-10-22T00:00:00.000Z", events: 2, files: 3, objects: 4 });
  for (const id of ["T-0001", "T-0002"]) {
    store.append({ task_id: id, actor, type: "task_created", payload: { remote: `/r/${id}` } });
    store.append({ task_id: id, actor, type: "state_changed", from: "RECEIVED", to: "TRIAGED", payload: {} });
  }

  it("deletes only a tombstoned task's events, and never adds to it again", () => {
    expect(() => {
      store.unsafeExec("DELETE FROM events WHERE task_id = 'T-0002'");
    }).toThrow(/append-only/);
    expect(store.purgeTasks([tomb("T-0002")])).toBe(2);
    expect(store.events("T-0002")).toEqual([]);
    expect(store.events("T-0001")).toHaveLength(2);
    expect(store.tombstones()).toEqual([tomb("T-0002")]);
    expect(() => store.append({ task_id: "T-0002", actor, type: "command", payload: { command: "x" } })).toThrow(/T-0002 was purged/);
    // Still append-only for every other task, and updates abort for all.
    expect(() => {
      store.unsafeExec("DELETE FROM events WHERE task_id = 'T-0001'");
    }).toThrow(/append-only/);
    expect(() => {
      store.unsafeExec("UPDATE events SET type = 'command'");
    }).toThrow(/append-only/);
  });

  it("keeps tombstones append-only, the first one only, and never reuses a purged id", () => {
    expect(store.purgeTasks([{ ...tomb("T-0002"), purged_at: "2026-10-23T00:00:00.000Z" }])).toBe(0);
    expect(store.tombstones()[0]?.purged_at).toBe("2026-10-22T00:00:00.000Z");
    expect(() => {
      store.unsafeExec("DELETE FROM tombstones");
    }).toThrow(/tombstones are append-only/);
    expect(() => {
      store.unsafeExec("UPDATE tombstones SET events = 0");
    }).toThrow(/tombstones are append-only/);
    expect(store.taskIds()).toEqual(["T-0001"]);
    expect(store.nextTaskId()).toBe("T-0003");
  });

  it("leaves nothing of a purged event in the database's files once compacted", () => {
    const canary = "SF-PURGE-CANARY-7f3a";
    store.append({ task_id: "T-0004", actor, type: "task_created", payload: { remote: canary } });
    const bytes = (): string => ["", "-wal", "-shm"].map((x) => `${path}${x}`).filter((f) => existsSync(f)).map((f) => readFileSync(f).toString("latin1")).join("");
    store.compact();
    // The control: before the purge the canary is on disk, so the check below can see it.
    expect(bytes()).toContain(canary);
    store.purgeTasks([tomb("T-0004")]);
    store.compact();
    expect(bytes()).not.toContain(canary);
    expect(store.nextTaskId()).toBe("T-0005");
  });

  it("brings a schema-3 store to schema 4, keeping its events append-only", () => {
    const old = join(dir, "old.db");
    const s3 = EventStore.open(old, { now: fixed });
    s3.append({ task_id: "T-0001", actor, type: "task_created", payload: {} });
    s3.close();
    // As the release before tombstones left it.
    const db = new DatabaseSync(old);
    db.exec(`DROP TABLE tombstones; DROP TRIGGER events_after_tombstone; DROP TRIGGER events_append_only_delete;
      CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    db.close();
    const s4 = EventStore.open(old, { now: fixed });
    try {
      expect(s4.events("T-0001")).toHaveLength(1);
      expect(s4.tombstones()).toEqual([]);
      expect(() => {
        s4.unsafeExec("DELETE FROM events");
      }).toThrow(/append-only/);
    } finally {
      s4.close();
    }
    const check = new DatabaseSync(old, { readOnly: true });
    expect(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "4" });
    check.close();
  });
});
