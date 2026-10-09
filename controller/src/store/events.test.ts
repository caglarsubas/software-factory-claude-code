import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
