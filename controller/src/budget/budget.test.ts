// Budget arithmetic over events (P1-01): charges, spend, the tier ratchet, calibration, caps
// and the wall clock of active time.
import { describe, expect, it } from "vitest";
import type { BudgetsPolicy } from "../release.ts";
import type { FactoryEvent } from "../store/events.ts";
import { activeMs, budgetTier, calibrate, charges, completedRuns, maxTier, monthSpend, raise, sessionCap, taskSpend, type CompletedRun } from "./budget.ts";

let seq = 0;
const ev = (task: string, type: FactoryEvent["type"], payload: Record<string, unknown>, ts = "2026-10-13T10:00:00.000Z", extra: Partial<FactoryEvent> = {}): FactoryEvent =>
  ({ schema_version: 1, seq: ++seq, task_id: task, ts, epoch: 0, actor: { kind: "factoryctl", id: "factoryctl" }, type, payload, ...extra });
const started = (task: string, label: string, cap: number, runner = "sdk", ts?: string) => ev(task, "stage_started", { stage: label, label, runner, env_keys: [], cap_usd: cap }, ts);
const completed = (task: string, label: string, usd: number) => ev(task, "stage_completed", { stage: label, label, cost_usd: usd, runner: "sdk" });

const policy: Pick<BudgetsPolicy, "task_usd" | "calibration"> = { task_usd: { R0: 3, R1: 12, R2: 30, R3: 60, Restricted: 60 }, calibration: { multiplier: 1.5, min_runs_per_tier: 3 } };

describe("charges and spend", () => {
  it("charges a completed session its cost and a session that never completed its cap (D4)", () => {
    const events = [started("T-1", "triage", 3), completed("T-1", "triage", 0.2), started("T-1", "spec", 9), started("T-1", "build", 6)];
    expect(charges(events).map((c) => [c.label, c.usd, c.killed])).toEqual([["triage", 0.2, false], ["spec", 9, true], ["build", 6, true]]);
    expect(taskSpend(events)).toBeCloseTo(15.2, 6);
    // A label started twice without completing is charged twice.
    expect(taskSpend([started("T-1", "build", 6), started("T-1", "build", 6), completed("T-1", "build", 1)])).toBe(7);
  });

  it("counts a target's live spend in the month: replayed sessions and other targets cost nothing", () => {
    const byTask = new Map<string, FactoryEvent[]>([
      ["T-1", [started("T-1", "build", 6, "sdk", "2026-10-02T00:00:00Z"), completed("T-1", "build", 4)]],
      ["T-2", [started("T-2", "build", 6, "replay", "2026-10-02T00:00:00Z"), completed("T-2", "build", 50)]],
      ["T-3", [started("T-3", "build", 6, "sdk", "2026-09-30T23:59:59Z"), completed("T-3", "build", 7)]],
      ["T-4", [started("T-4", "build", 6, "sdk", "2026-10-03T00:00:00Z"), completed("T-4", "build", 8)]],
    ]);
    expect(monthSpend(byTask, new Set(["T-1", "T-2", "T-3"]), "2026-10")).toBe(4);
    expect(monthSpend(byTask, new Set(["T-3"]), "2026-09")).toBe(7);
  });

  it("caps a session at its stage's share, never above what remains (D2)", () => {
    expect(sessionCap(12, 0, 0.5)).toBe(6);
    expect(sessionCap(12, 10, 0.5)).toBe(2);
    expect(sessionCap(12, 13, 0.5)).toBe(0);
  });
});

describe("the tier ratchet", () => {
  it("budgets at the highest tier before triage, then never below what any later step found", () => {
    expect(budgetTier({})).toBe("Restricted");
    expect(budgetTier({ triage: { proposed_tier: "R0", uncertain: false } })).toBe("R0");
    expect(budgetTier({ triage: { proposed_tier: "R0", uncertain: true } })).toBe("R1");
    expect(budgetTier({ triage: { proposed_tier: "R1", uncertain: false }, provisional: "R2" })).toBe("R2");
    expect(budgetTier({ triage: { proposed_tier: "R2", uncertain: false }, provisional: "R1", policy: "R0" })).toBe("R2");
    expect(budgetTier({ triage: { proposed_tier: "R0", uncertain: false }, provisional: "R0", policy: "R3" })).toBe("R3");
    expect(raise("Restricted")).toBe("Restricted");
    expect(maxTier("R1", "Restricted", "R3")).toBe("Restricted");
  });
});

describe("calibration (D1)", () => {
  const run = (tier: CompletedRun["tier"], usd: number, i: number): CompletedRun => ({ taskId: `T-${String(i)}`, tier, usd, at: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00Z` });

  it("keeps the initial budget until a run, then observed max × multiplier, never below the initial value", () => {
    const b = calibrate(policy, [run("R1", 10, 1), run("R1", 4, 2), run("R0", 1, 3)]);
    expect(b.R2).toMatchObject({ budget: 30, source: "initial", runs: 0, observedMaxUsd: null });
    expect(b.R1).toMatchObject({ budget: 15, source: "calibrating", runs: 2, observedMaxUsd: 10 });
    expect(b.R0).toMatchObject({ budget: 3, source: "calibrating", runs: 1, observedMaxUsd: 1 });
  });

  it("freezes at the value its first runs set", () => {
    const b = calibrate(policy, [run("R1", 2, 1), run("R1", 9, 2), run("R1", 4, 3), run("R1", 20, 4)]);
    expect(b.R1).toMatchObject({ budget: 13.5, source: "frozen", runs: 4, observedMaxUsd: 20 });
  });

  it("calibrates from live runs that reached the merge gate, at their tier", () => {
    const merged = (task: string, tier: string, runner = "sdk") => [
      ev(task, "task_created", {}),
      started(task, "build", 6, runner),
      completed(task, "build", 2.5),
      ev(task, "state_changed", { gate: "merge", tier }, "2026-10-13T11:00:00.000Z", { from: "POLICY", to: "NEEDS_HUMAN" }),
    ];
    const failed = [ev("T-9", "task_created", {}), started("T-9", "build", 6), completed("T-9", "build", 40), ev("T-9", "state_changed", { category: "budget_exceeded" }, undefined, { from: "BUILDING", to: "FAILED" })];
    const runs = completedRuns(new Map([["T-1", merged("T-1", "R1")], ["T-2", merged("T-2", "R0", "replay")], ["T-9", failed]]));
    expect(runs).toEqual([{ taskId: "T-1", tier: "R1", usd: 2.5, at: "2026-10-13T11:00:00.000Z" }]);
  });
});

describe("the wall clock", () => {
  const run = (cmd: "run_started" | "run_ended", at: string) => ev("T-1", "command", { command: cmd, at });

  it("counts each run from start to end and the current run so far, never the waits between runs", () => {
    const events = [run("run_started", "2026-10-13T10:00:00Z"), run("run_ended", "2026-10-13T10:10:00Z"), run("run_started", "2026-10-13T14:00:00Z")];
    const current = events[2]?.seq ?? null;
    expect(activeMs(events, new Date("2026-10-13T14:05:00Z"), current)).toBe(15 * 60_000);
    // A run that is not the current one and never ended counts nothing (the pipeline reconstructs its end from the heartbeat first).
    expect(activeMs(events, new Date("2026-10-13T14:05:00Z"), null)).toBe(10 * 60_000);
  });
});
