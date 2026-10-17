// What `factoryctl serve` runs next (ROADMAP P2-03): pure rules over the tasks' events, leases
// and specs. A task is eligible when it can move (not ended, not paused, not leased to a live
// writer) and something happened since this scheduler last ran it; a task at the merge gate is
// polled for its merge now and then. Tasks on one target whose spec scopes overlap run one at a
// time, and a task without a spec yet overlaps every task on its target.

export interface TaskView {
  id: string;
  target: string;
  state: string;
  gate: string | null;
  paused: boolean;
  /** The spec's scope.include, or null before the spec exists. */
  scope: readonly string[] | null;
  priority: number;
  lastSeq: number;
  lease: "free" | "held" | "lapsed";
}

const TERMINAL = new Set(["DONE", "ROLLED_BACK", "FAILED", "CANCELLED", "SUPERSEDED"]);
const GLOB = /[*?[{]/;

/** The literal part of a glob before its first wildcard. */
const prefix = (glob: string): string => {
  const i = glob.search(GLOB);
  return i === -1 ? glob : glob.slice(0, i);
};

/** Whether two include lists could name a common path: one literal prefix starts the other. */
export function scopesOverlap(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return true;
  return a.some((x) => b.some((y) => {
    const p = prefix(x);
    const q = prefix(y);
    return p.startsWith(q) || q.startsWith(p);
  }));
}

export const conflicts = (a: TaskView, b: TaskView): boolean => a.id !== b.id && a.target === b.target && scopesOverlap(a.scope, b.scope);

export interface Ledger {
  /** The task's last event seq when this scheduler's last worker for it ended. */
  finished: ReadonlyMap<string, number>;
  /** When this scheduler last polled a task at the merge gate (ms). */
  polled: ReadonlyMap<string, number>;
}

export const MERGE_POLL_MS = 300_000;

export function eligible(t: TaskView, ledger: Ledger, now: number): boolean {
  if (TERMINAL.has(t.state) || t.paused || t.lease === "held") return false;
  const finished = ledger.finished.get(t.id);
  if (finished === undefined || t.lastSeq > finished) return true;
  return t.state === "NEEDS_HUMAN" && t.gate === "merge" && now - (ledger.polled.get(t.id) ?? 0) >= MERGE_POLL_MS;
}

/** The tasks to start now, by priority then age, within the concurrency limit and never beside an overlapping one. */
export function nextTasks(tasks: readonly TaskView[], running: readonly TaskView[], max: number, ledger: Ledger, now: number): TaskView[] {
  const picked: TaskView[] = [];
  const busy = [...running];
  const runningIds = new Set(running.map((r) => r.id));
  const order = [...tasks].filter((t) => !runningIds.has(t.id) && eligible(t, ledger, now)).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const t of order) {
    if (busy.length >= max) break;
    if (busy.some((r) => conflicts(r, t))) continue;
    picked.push(t);
    busy.push(t);
  }
  return picked;
}
