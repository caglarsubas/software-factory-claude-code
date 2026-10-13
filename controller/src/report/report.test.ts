// Run metrics and the weekly taxonomy row over a seeded event store (P1-07).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { taskSpend } from "../budget/budget.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { EventStore, type State } from "../store/events.ts";
import { CATEGORIES, sdkCategory, type Category } from "../task/taxonomy.ts";
import { isoWeek, taskReport, WEEK_HEADER, weekRange, weekRow, weekRowMarkdown } from "./report.ts";

const scratch = mkdtempSync(join(tmpdir(), "report-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const op = { kind: "factoryctl" as const, id: "factoryctl" };

/** A store whose clock the test sets per event. */
function seededStore(): { store: EventStore; at: (iso: string) => void } {
  let now = new Date("2026-10-12T09:00:00Z");
  const store = EventStore.open(join(mkdtempSync(join(scratch, "db-")), "factory.db"), { now: () => now });
  return { store, at: (iso) => (now = new Date(iso)) };
}

interface Seed {
  id: string;
  created: string;
  runner?: "sdk" | "replay";
  path: State[];
  failed?: { category: string; cause?: string; denied?: number };
  costs?: number[];
}

function seed(store: EventStore, at: (iso: string) => void, s: Seed): void {
  at(s.created);
  store.append({ task_id: s.id, actor: { kind: "operator", id: "op" }, type: "task_created", payload: {} });
  const labels = ["triage", "spec", "build"];
  (s.costs ?? []).forEach((cost, i) => {
    const label = labels[i] ?? `stage-${String(i)}`;
    if (s.runner !== undefined) store.append({ task_id: s.id, actor: op, type: "stage_started", payload: { stage: label, label, runner: s.runner, env_keys: [] } });
    const denied = label === "build" ? Array.from({ length: s.failed?.denied ?? 0 }, () => ({ tool: "Write", reason: "protected" })) : [];
    store.append({ task_id: s.id, actor: op, type: "stage_completed", payload: { stage: label, label, ok: true, cost_usd: cost, input_tokens: 1000, output_tokens: 100, num_turns: 2, duration_ms: 60_000, round: 1, denied } });
  });
  let from: State = "RECEIVED";
  for (const to of s.path) {
    store.append({ task_id: s.id, actor: op, type: "state_changed", from, to, payload: to === "FAILED" ? { ...s.failed } : to === "NEEDS_HUMAN" ? { gate: "merge", tier: "R1" } : {} });
    from = to;
  }
}

describe("per-stage cost for every run (P1-06)", () => {
  it("lists a session killed before it reported, charged its cap as the budget charges it", () => {
    const { store, at } = seededStore();
    seed(store, at, { id: "T-0001", created: "2026-10-12T09:00:00Z", runner: "sdk", path: [], costs: [0.05] });
    // The spec session started, the run was killed, and the next run's spec session completed.
    store.append({ task_id: "T-0001", actor: op, type: "stage_started", payload: { stage: "spec", label: "spec", runner: "sdk", env_keys: [], cap_usd: 1.8, round: 1 } });
    store.append({ task_id: "T-0001", actor: op, type: "command", payload: { command: "run_ended", reason: "killed", reconstructed: true } });
    store.append({ task_id: "T-0001", actor: op, type: "stage_started", payload: { stage: "spec", label: "spec", runner: "sdk", env_keys: [], cap_usd: 1.75, round: 1 } });
    store.append({ task_id: "T-0001", actor: op, type: "stage_completed", payload: { stage: "spec", label: "spec", ok: true, cost_usd: 0.3, round: 1, runner: "sdk" } });
    // A build in flight, or killed with nothing after it.
    store.append({ task_id: "T-0001", actor: op, type: "stage_started", payload: { stage: "build", label: "build", runner: "sdk", env_keys: [], cap_usd: 6, round: 1 } });
    const r = taskReport(store.events("T-0001"));
    expect(r.stages.map((s) => [s.label, s.unreported, s.costUsd])).toEqual([["triage", false, 0.05], ["spec", true, 1.8], ["spec", false, 0.3], ["build", true, 6]]);
    expect(r.totals.costUsd).toBeCloseTo(8.15);
    expect(r.totals.costUsd).toBeCloseTo(taskSpend(store.events("T-0001")));
    store.close();
  });
});

describe("ISO weeks", () => {
  it("names the week of a time, across year boundaries", () => {
    expect(isoWeek(new Date("2026-10-13T12:00:00Z"))).toBe("2026-W42");
    expect(isoWeek(new Date("2026-10-12T00:00:00Z"))).toBe("2026-W42");
    expect(isoWeek(new Date("2026-10-11T23:59:59Z"))).toBe("2026-W41");
    expect(isoWeek(new Date("2021-01-03T00:00:00Z"))).toBe("2020-W53");
    expect(isoWeek(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
    expect(isoWeek(new Date("2026-12-31T00:00:00Z"))).toBe("2026-W53");
  });

  it("spans Monday to Monday in UTC, and refuses weeks that do not exist", () => {
    expect(weekRange("2026-W42")).toEqual({ start: new Date("2026-10-12T00:00:00Z"), end: new Date("2026-10-19T00:00:00Z") });
    expect(weekRange("2026-W53").start).toEqual(new Date("2026-12-28T00:00:00Z"));
    expect(() => weekRange("2025-W53")).toThrow("does not exist");
    expect(() => weekRange("2026-W00")).toThrow("does not exist");
    expect(() => weekRange("2026-42")).toThrow("YYYY-Www");
  });
});

describe("the taxonomy", () => {
  it("has the ten P1-07 categories, in the column order of STATUS's weekly table", () => {
    expect(CATEGORIES).toHaveLength(10);
    const status = readFileSync(join(REPO_ROOT, "docs/factory/STATUS.md"), "utf8");
    expect(status).toContain(`${WEEK_HEADER}\n`);
  });

  it("maps SDK result subtypes", () => {
    const cases: [string, Category][] = [
      ["error_max_turns", "max_turns"],
      ["error_max_budget_usd", "budget_exceeded"],
      ["error_max_structured_output_retries", "schema_invalid"],
      ["error_during_execution", "api_error"],
      ["no_result", "api_error"],
    ];
    for (const [subtype, category] of cases) expect(sdkCategory(subtype), subtype).toBe(category);
  });
});

describe("factoryctl report", () => {
  it("sums a task's stages and reads its findings", () => {
    const { store, at } = seededStore();
    seed(store, at, { id: "T-0001", created: "2026-10-12T09:00:00Z", runner: "sdk", path: ["TRIAGED", "SPECIFIED", "BUILDING", "VERIFYING", "REVIEWING", "POLICY", "NEEDS_HUMAN"], costs: [0.05, 0.4, 0.6] });
    const r = taskReport(store.events("T-0001"), [{ findings: [{ severity: "major" }, { severity: "nit" }] }, { findings: [] }]);
    expect(r).toMatchObject({ taskId: "T-0001", state: "NEEDS_HUMAN", gate: "merge", tier: "R1", category: null, live: true, sessions: 3, rounds: 1 });
    expect(r.totals).toEqual({ costUsd: expect.closeTo(1.05, 6) as number, inputTokens: 3000, outputTokens: 300, durationMs: 180_000 });
    expect(r.stages.map((s) => s.runner)).toEqual(["sdk", "sdk", "sdk"]);
    expect(r.findings).toEqual({ blocking: 0, major: 1, minor: 0, nit: 1 });
    store.close();
  });

  it("maps the pre-taxonomy causes of v0.1.x tasks the way the pipeline maps them now", () => {
    const { store, at } = seededStore();
    seed(store, at, { id: "T-0001", created: "2026-10-12T09:00:00Z", runner: "sdk", path: ["TRIAGED", "SPECIFIED", "BUILDING", "FAILED"], failed: { category: "no_change" }, costs: [0.1, 0.1, 0.1] });
    seed(store, at, { id: "T-0002", created: "2026-10-12T10:00:00Z", runner: "sdk", path: ["TRIAGED", "SPECIFIED", "BUILDING", "FAILED"], failed: { category: "no_change", denied: 2 }, costs: [0.1, 0.1, 0.1] });
    seed(store, at, { id: "T-0003", created: "2026-10-12T11:00:00Z", runner: "sdk", path: ["TRIAGED", "SPECIFIED", "BUILDING", "FAILED"], failed: { category: "build_failed" }, costs: [0.1, 0.1, 0.1] });
    expect(taskReport(store.events("T-0001"))).toMatchObject({ category: "gate_fail", cause: "no_change" });
    expect(taskReport(store.events("T-0002"))).toMatchObject({ category: "permission_denied", cause: "no_change" });
    expect(taskReport(store.events("T-0003"))).toMatchObject({ category: "gate_fail", cause: "build_failed" });
    store.close();
  });

  it("counts a week's live tasks by outcome, in aggregates only", () => {
    const { store, at } = seededStore();
    const path: State[] = ["TRIAGED", "SPECIFIED", "BUILDING", "FAILED"];
    seed(store, at, { id: "T-0001", created: "2026-10-12T09:00:00Z", runner: "sdk", path: [...path.slice(0, 3), "VERIFYING", "REVIEWING", "POLICY", "NEEDS_HUMAN", "MERGED"], costs: [0.1, 0.5, 1] });
    seed(store, at, { id: "T-0002", created: "2026-10-13T09:00:00Z", runner: "sdk", path, failed: { category: "budget_exceeded", cause: "error_max_budget_usd" }, costs: [0.1, 0.2, 3] });
    seed(store, at, { id: "T-0003", created: "2026-10-14T09:00:00Z", runner: "sdk", path, failed: { category: "gate_fail" }, costs: [0.1] });
    seed(store, at, { id: "T-0004", created: "2026-10-15T09:00:00Z", runner: "sdk", path: ["TRIAGED", "SPECIFIED", "NEEDS_HUMAN"], costs: [0.1, 0.2] });
    seed(store, at, { id: "T-0005", created: "2026-10-16T09:00:00Z", runner: "sdk", path: ["CANCELLED"], costs: [0.1] });
    seed(store, at, { id: "T-0006", created: "2026-10-16T10:00:00Z", path: [] });
    // Replayed, and outside the week: neither counts.
    seed(store, at, { id: "T-0007", created: "2026-10-17T09:00:00Z", runner: "replay", path, failed: { category: "max_turns" }, costs: [0, 0, 0] });
    seed(store, at, { id: "T-0008", created: "2026-10-19T00:00:00Z", runner: "sdk", path, failed: { category: "wall_clock" }, costs: [9] });
    seed(store, at, { id: "T-0009", created: "2026-10-11T23:59:59Z", runner: "sdk", path, failed: { category: "wall_clock" }, costs: [9] });

    const row = weekRow(store.allEvents(), "2026-W42");
    expect(row).toMatchObject({ week: "2026-W42", tasks: 6, merged: 1, open: 2, cancelled: 1, replayed: 1 });
    expect(row.counts).toMatchObject({ budget_exceeded: 1, gate_fail: 1, max_turns: 0, wall_clock: 0 });
    expect(row.costUsd).toBeCloseTo(5.4, 6);
    expect(weekRowMarkdown(row)).toBe("| 2026-W42 | 6 | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | $5.40 in total; 2 open; 1 cancelled; 1 replayed, not counted |");
    expect(weekRowMarkdown(row).split("|").length).toBe(WEEK_HEADER.split("|").length);
    expect(weekRow(store.allEvents(), "2026-W43")).toMatchObject({ tasks: 1, counts: { wall_clock: 1 } });
    store.close();
  });
});
