// Takeover (ROADMAP P1-04): the operator opens the task's build session in its worktree,
// changes what they need and leaves. Their commits become the candidate, and the task goes back
// through the gates and every judge: a takeover result is never merged on the operator's word.
//
// The candidate re-enters through the commit protocol. The latest round's build.json is
// committed again, from the same inputs, with the operator's head as its candidate: the build
// step stays done, and every step that reads build.json runs again (gates, reviews, refutation,
// policy, approval, summary, publish).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commitAll, git, head } from "../git/repo.ts";
import { runDir, worktreeDir, type Home } from "../home.ts";
import type { EventStore, FactoryEvent } from "../store/events.ts";
import { canMove, currentState, isTerminal, transition } from "../task/lifecycle.ts";
import { commitArtifacts, latestCommit } from "./commit.ts";
import { latestRound, roundLabel, roundPath } from "./rounds.ts";

interface Build {
  base_commit: string;
  round: number;
  start_commit: string;
  candidate_commit: string;
  takeover?: { by: string; from_commit: string };
}

export class TakeoverError extends Error {}

/** The latest round's committed build, the round it belongs to, and its step label. */
export function latestBuild(home: Home, store: EventStore, taskId: string): { round: number; label: string; build: Build } {
  const dir = runDir(home, taskId);
  const round = latestRound(dir);
  const label = roundLabel("build", round);
  if (latestCommit(store.events(taskId), label) === null) throw new TakeoverError(`${taskId} has no committed build to take over; run it until it builds`);
  return { round, label, build: JSON.parse(readFileSync(join(dir, roundPath("build.json", round)), "utf8")) as Build };
}

/** The live build session a takeover resumes: the latest one that reported a session id. Replayed sessions cannot be resumed. */
export function resumableSession(events: readonly FactoryEvent[]): string | null {
  const s = events.findLast((e) => e.type === "stage_completed" && e.payload["stage"] === "build" && e.payload["runner"] === "sdk" && typeof e.payload["session_id"] === "string");
  return s === undefined ? null : String(s.payload["session_id"]);
}

export function checkTakeover(home: Home, store: EventStore, taskId: string): void {
  const at = currentState(store.events(taskId));
  if (isTerminal(at)) throw new TakeoverError(`${taskId} has already ended (${at})`);
  latestBuild(home, store, taskId);
}

export interface TakeoverResult {
  changed: boolean;
  round: number;
  from: string;
  to: string;
}

/**
 * Records what the operator left in the worktree. Uncommitted changes are committed in their
 * name. A new head becomes the latest round's candidate and moves the task back to BUILDING, so
 * the next `resume` runs the gates and the judges on it.
 */
export function applyTakeover(home: Home, store: EventStore, taskId: string, by: string, extra: Record<string, unknown> = {}): TakeoverResult {
  const { round, label, build } = latestBuild(home, store, taskId);
  const worktree = worktreeDir(home, taskId);
  commitAll(worktree, `factory: ${taskId} takeover by ${by}`);
  const to = head(worktree);
  const from = build.candidate_commit;
  const result: TakeoverResult = { changed: to !== from, round, from, to };
  const op = { kind: "operator" as const, id: by };
  if (!result.changed) {
    store.append({ task_id: taskId, actor: op, type: "command", payload: { command: "takeover", ...extra, round, from_commit: from, to_commit: null } });
    return result;
  }
  // The task's base must still be in the candidate's history: a takeover changes the candidate, not what it is based on.
  if (!isAncestor(worktree, build.base_commit, to)) {
    throw new TakeoverError(`the worktree's head ${to.slice(0, 12)} does not descend from the task's base ${build.base_commit.slice(0, 12)}`);
  }
  store.append({ task_id: taskId, actor: op, type: "command", payload: { command: "takeover", ...extra, round, from_commit: from, to_commit: to } });
  const commit = latestCommit(store.events(taskId), label);
  if (commit === null) throw new TakeoverError(`${taskId} has no committed build`);
  const next: Build = { ...build, candidate_commit: to, takeover: { by, from_commit: from } };
  commitArtifacts(store, runDir(home, taskId), { taskId, stage: "build", label, round }, commit.inputs, [{ path: roundPath("build.json", round), content: `${JSON.stringify(next, null, 2)}\n` }]);
  // Back to the round's BUILDING, so every later step moves the task forward again.
  const at = currentState(store.events(taskId));
  const payload = { round, takeover: true, by };
  if (!canMove(at, "BUILDING")) transition(store, taskId, "BLOCKED", { reason: "takeover", by });
  transition(store, taskId, "BUILDING", payload);
  return result;
}

function isAncestor(dir: string, ancestor: string, commit: string): boolean {
  try {
    git(dir, ["merge-base", "--is-ancestor", ancestor, commit]);
    return true;
  } catch {
    return false;
  }
}
