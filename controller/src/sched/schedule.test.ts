// serve's scheduling rules (P2-03): eligible tasks by priority and age, within the concurrency
// limit, never two at once whose scopes overlap on one target.
import { describe, expect, it } from "vitest";
import { eligible, MERGE_POLL_MS, nextTasks, scopesOverlap, type Ledger, type TaskView } from "./schedule.ts";

const task = (id: string, o: Partial<TaskView> = {}): TaskView => ({ id, target: "o/a", state: "BUILDING", gate: null, paused: false, scope: ["src/a/"], priority: 1, lastSeq: 10, lease: "free", ...o });
const empty: Ledger = { finished: new Map(), polled: new Map() };

describe("scope overlap", () => {
  it("compares the literal prefixes of include globs, and treats a missing spec as overlapping everything", () => {
    expect(scopesOverlap(["src/a/"], ["src/b/"])).toBe(false);
    expect(scopesOverlap(["src/a/**"], ["src/a/x.ts"])).toBe(true);
    expect(scopesOverlap(["src/**"], ["src/b/"])).toBe(true);
    expect(scopesOverlap(["docs/"], ["src/", "docs/guide.md"])).toBe(true);
    expect(scopesOverlap(["**/*.md"], ["src/"])).toBe(true);
    expect(scopesOverlap(null, ["src/"])).toBe(true);
  });
});

describe("eligibility", () => {
  it("skips ended, paused and leased tasks, and runs a task again only once something happened", () => {
    expect(eligible(task("T-0001"), empty, 0)).toBe(true);
    expect(eligible(task("T-0001", { state: "DONE" }), empty, 0)).toBe(false);
    expect(eligible(task("T-0001", { paused: true }), empty, 0)).toBe(false);
    expect(eligible(task("T-0001", { lease: "held" }), empty, 0)).toBe(false);
    expect(eligible(task("T-0001", { lease: "lapsed" }), empty, 0)).toBe(true);
    const ledger: Ledger = { finished: new Map([["T-0001", 10]]), polled: new Map([["T-0001", 1000]]) };
    expect(eligible(task("T-0001"), ledger, 0)).toBe(false);
    expect(eligible(task("T-0001", { lastSeq: 11 }), ledger, 0)).toBe(true);
    // A task at the merge gate is polled for its merge, not more often than MERGE_POLL_MS.
    const merge = task("T-0001", { state: "NEEDS_HUMAN", gate: "merge" });
    expect(eligible(merge, ledger, 1000 + MERGE_POLL_MS - 1)).toBe(false);
    expect(eligible(merge, ledger, 1000 + MERGE_POLL_MS)).toBe(true);
    expect(eligible(task("T-0001", { state: "NEEDS_HUMAN", gate: "spec" }), ledger, 10 * MERGE_POLL_MS)).toBe(false);
  });
});

describe("next tasks", () => {
  it("fills the free slots by priority then age, serialising overlapping scopes on one target", () => {
    const first = task("T-0001", { scope: ["src/a/"] });
    const tasks = [
      first,
      task("T-0002", { scope: ["src/a/x.ts"] }),
      task("T-0003", { scope: ["src/b/"], priority: 2 }),
      task("T-0004", { target: "o/b", scope: null }),
      task("T-0005", { target: "o/b", scope: ["docs/"] }),
    ];
    expect(nextTasks(tasks, [], 10, empty, 0).map((t) => t.id)).toEqual(["T-0003", "T-0001", "T-0004"]);
    expect(nextTasks(tasks, [], 2, empty, 0).map((t) => t.id)).toEqual(["T-0003", "T-0001"]);
    // With T-0001 running, T-0002 waits; a running task is never started twice.
    const running = [first];
    expect(nextTasks(tasks, running, 10, empty, 0).map((t) => t.id)).toEqual(["T-0003", "T-0004"]);
    expect(nextTasks(tasks, running, 1, empty, 0)).toEqual([]);
  });
});
