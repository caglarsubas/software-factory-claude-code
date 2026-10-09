// The task lifecycle (ROADMAP §2.1) as a state machine. Agents return assessments; only
// factoryctl writes a state, through transition(), which refuses any move the table lacks.
import type { EventStore, FactoryEvent, State } from "../store/events.ts";

const TERMINAL: readonly State[] = ["DONE", "ROLLED_BACK", "FAILED", "CANCELLED", "SUPERSEDED"];
/** Any live task can end in these. */
const ALWAYS: readonly State[] = ["FAILED", "CANCELLED", "BLOCKED"];

const NEXT: Readonly<Partial<Record<State, readonly State[]>>> = {
  RECEIVED: ["TRIAGED"],
  TRIAGED: ["SPECIFIED"],
  SPECIFIED: ["NEEDS_HUMAN", "BUILDING"],
  BUILDING: ["VERIFYING"],
  VERIFYING: ["REVIEWING", "REMEDIATING"],
  REVIEWING: ["POLICY", "REMEDIATING"],
  REMEDIATING: ["BUILDING"],
  POLICY: ["AUTO_APPROVED", "NEEDS_HUMAN"],
  // A spec gate continues to BUILDING; a merge gate waits for a human merge.
  NEEDS_HUMAN: ["BUILDING", "MERGE_QUEUED", "MERGED"],
  AUTO_APPROVED: ["MERGE_QUEUED"],
  MERGE_QUEUED: ["MERGED"],
  MERGED: ["DEPLOYING", "DONE"],
  DEPLOYING: ["OBSERVING", "ROLLED_BACK"],
  OBSERVING: ["DONE", "ROLLED_BACK"],
  BLOCKED: ["RECEIVED", "TRIAGED", "SPECIFIED", "BUILDING"],
};

export function isTerminal(state: State): boolean {
  return TERMINAL.includes(state);
}

export function canMove(from: State, to: State): boolean {
  if (isTerminal(from)) return false;
  return (NEXT[from] ?? []).includes(to) || ALWAYS.includes(to);
}

/** The state a task's events leave it in. */
export function currentState(events: readonly FactoryEvent[]): State {
  let state: State = "RECEIVED";
  for (const e of events) if (e.type === "state_changed" && e.to !== undefined) state = e.to;
  return state;
}

/** The payload of the event that put the task in its current state (e.g. the NEEDS_HUMAN gate). */
export function currentStatePayload(events: readonly FactoryEvent[]): Record<string, unknown> {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "state_changed") return e.payload;
  }
  return {};
}

export class TransitionError extends Error {}

export function transition(store: EventStore, taskId: string, to: State, payload: Record<string, unknown> = {}): State {
  const from = currentState(store.events(taskId));
  if (!canMove(from, to)) throw new TransitionError(`${taskId}: ${from} → ${to} is not a lifecycle transition`);
  store.append({ task_id: taskId, actor: { kind: "factoryctl", id: "factoryctl" }, type: "state_changed", from, to, payload });
  return to;
}
