// The SLO panel (P2-08): each SLO measured over live tasks created in the window, with what it
// was measured on, and "no data" or "not measured" rather than a number the store does not hold.
import { describe, expect, it } from "vitest";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import type { FactoryEvent } from "../store/events.ts";
import { measureSlos, percentile, type SloRow } from "./slo.ts";

const budgets = loadRelease(createValidator()).budgets;
const start = new Date("2026-10-01T00:00:00Z");
const end = new Date("2026-10-29T00:00:00Z");

let seq = 0;
function ev(task: string, type: FactoryEvent["type"], payload: Record<string, unknown> = {}, extra: Partial<FactoryEvent> = {}, ts = "2026-10-10T00:00:00Z"): FactoryEvent {
  return { schema_version: 1, seq: ++seq, task_id: task, ts, epoch: 0, actor: { kind: "factoryctl", id: "factoryctl" }, type, payload, ...extra };
}

/** A live task: created, one session costing `usd` at `tier`, then its end. */
function task(id: string, o: { tier: string; usd: number; end: "merged" | "failed" | "open"; takeover?: boolean; replayed?: boolean; created?: string }): FactoryEvent[] {
  const runner = o.replayed === true ? "replay" : "sdk";
  const events = [
    ev(id, "task_created", { remote: "/r", commit_protocol: 1 }, { actor: { kind: "operator", id: "op" } }, o.created ?? "2026-10-10T00:00:00Z"),
    ev(id, "stage_started", { stage: "build", label: "build", runner, env_keys: [], cap_usd: 5, tier: o.tier, round: 1 }),
    ev(id, "stage_completed", { stage: "build", label: "build", runner, cost_usd: o.usd, ok: true }),
  ];
  if (o.takeover === true) events.push(ev(id, "command", { command: "takeover", round: 1, from_commit: "a", to_commit: "b" }, { actor: { kind: "operator", id: "op" } }));
  if (o.end === "merged") events.push(ev(id, "state_changed", { gate: "merge", tier: o.tier }, { from: "POLICY", to: "NEEDS_HUMAN" }), ev(id, "state_changed", {}, { from: "NEEDS_HUMAN", to: "MERGED" }));
  if (o.end === "failed") events.push(ev(id, "state_changed", { category: "gate_fail" }, { from: "VERIFYING", to: "FAILED" }));
  return events;
}

const row = (rows: SloRow[], id: SloRow["id"]): SloRow | undefined => rows.find((r) => r.id === id);

describe("the SLO panel", () => {
  it("measures every SLO it can, and says which it cannot", () => {
    const tasks = [
      task("T-0001", { tier: "R1", usd: 2, end: "merged" }),
      task("T-0002", { tier: "R1", usd: 3, end: "merged" }),
      task("T-0003", { tier: "R0", usd: 1, end: "merged", takeover: true }),
      task("T-0004", { tier: "R1", usd: 4, end: "failed" }),
      task("T-0005", { tier: "R1", usd: 9, end: "open" }),
      task("T-0006", { tier: "R1", usd: 1, end: "merged", replayed: true }),
      task("T-0007", { tier: "R1", usd: 1, end: "merged", created: "2026-09-01T00:00:00Z" }),
    ];
    const byTask = new Map(tasks.map((t) => [t[0]?.task_id ?? "", t]));
    const files: Record<string, string> = {
      "T-0001/refutations.json": JSON.stringify({ refutations: [{ decision: "upheld" }, { decision: "refuted" }] }),
      "T-0002/refutations.json": JSON.stringify({ refutations: [{ decision: "upheld" }] }),
      "T-0002/rounds/2/build.json": "{}",
      "T-0002/rounds/2/refutations.json": JSON.stringify({ refutations: [{ decision: "upheld" }, { decision: "upheld" }] }),
      "T-0004/gates.json": JSON.stringify({ signals: { secret_material: true } }),
    };
    const rows = measureSlos({ byTask, read: (t, p) => files[`${t}/${p}`] ?? null, budgets, start, end });
    // Four R0–R1 attempts ended (the open, replayed and out-of-window ones do not count); two merged untouched.
    expect(row(rows, "auto_merge_ready")).toMatchObject({ value: "50.0%", basis: "2 of 4 R0–R1 attempts", status: "missed" });
    expect(row(rows, "escaped_defects")).toMatchObject({ status: "not_measured" });
    expect(row(rows, "reviewer_precision")).toMatchObject({ value: "80.0%", basis: "4 of 5 blocking findings upheld", status: "met" });
    expect(row(rows, "p90_cost")).toMatchObject({ status: "met", basis: "failed attempts cost $13.00 more" });
    expect(row(rows, "p90_cost")?.value).toContain("R1 $3.00 of $12.00 (2 merged)");
    expect(row(rows, "safety")).toMatchObject({ value: "1", status: "missed" });
  });

  it("reports no data for an empty window", () => {
    const rows = measureSlos({ byTask: new Map(), read: () => null, budgets, start, end });
    expect(rows.map((r) => r.status)).toEqual(["no_data", "not_measured", "no_data", "no_data", "no_data"]);
  });

  it("takes the nearest-rank percentile", () => {
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([10, 1, 2], 90)).toBe(10);
  });
});
