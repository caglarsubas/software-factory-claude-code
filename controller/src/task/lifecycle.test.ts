import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EventStore } from "../store/events.ts";
import { canMove, currentState, currentStatePayload, transition, TransitionError } from "./lifecycle.ts";

const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lifecycle", () => {
  it("follows the roadmap's happy path to a human merge gate", () => {
    const store = EventStore.open(join(dir, "a.db"));
    store.append({ task_id: "T-0001", actor: { kind: "operator", id: "op" }, type: "task_created", payload: {} });
    for (const to of ["TRIAGED", "SPECIFIED", "BUILDING", "VERIFYING", "REVIEWING", "POLICY"] as const) transition(store, "T-0001", to);
    transition(store, "T-0001", "NEEDS_HUMAN", { gate: "merge" });
    const events = store.events("T-0001");
    expect(currentState(events)).toBe("NEEDS_HUMAN");
    expect(currentStatePayload(events)).toEqual({ gate: "merge" });
    store.close();
  });

  it("refuses skipped stages and moves out of terminal states", () => {
    const store = EventStore.open(join(dir, "b.db"));
    store.append({ task_id: "T-0001", actor: { kind: "operator", id: "op" }, type: "task_created", payload: {} });
    expect(() => transition(store, "T-0001", "BUILDING")).toThrow(TransitionError);
    transition(store, "T-0001", "CANCELLED");
    expect(() => transition(store, "T-0001", "TRIAGED")).toThrow(TransitionError);
    expect(() => transition(store, "T-0001", "FAILED")).toThrow(TransitionError);
    store.close();
  });

  it("lets any live state fail, cancel or block, and nothing leave DONE", () => {
    for (const from of ["RECEIVED", "BUILDING", "NEEDS_HUMAN", "POLICY"] as const) {
      for (const to of ["FAILED", "CANCELLED", "BLOCKED"] as const) expect(canMove(from, to)).toBe(true);
    }
    expect(canMove("DONE", "FAILED")).toBe(false);
    expect(canMove("VERIFYING", "POLICY")).toBe(false);
  });
});
