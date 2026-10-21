// The SLOs (ROADMAP §6, P2-08; approved at G2, met at G3), measured from the event store and the
// run directories over a window. Each SLO says how many tasks it was measured on, and an SLO the
// store cannot measure yet says so and why, rather than reporting a number it does not have.
// Definitions, windows and data sources are in docs/factory/slo.md; `factoryctl slo` prints this.
import { calibrate, completedRuns, taskSpend } from "../budget/budget.ts";
import type { BudgetsPolicy, BudgetTier } from "../release.ts";
import type { FactoryEvent, State } from "../store/events.ts";
import { roundPath } from "../stages/rounds.ts";
import { taskReport } from "./report.ts";

export type SloStatus = "met" | "missed" | "no_data" | "not_measured";

export interface SloRow {
  id: "auto_merge_ready" | "escaped_defects" | "reviewer_precision" | "p90_cost" | "safety";
  name: string;
  target: string;
  value: string;
  /** What it was measured on. */
  basis: string;
  status: SloStatus;
}

export interface SloInputs {
  byTask: ReadonlyMap<string, readonly FactoryEvent[]>;
  /** A committed file of a task's run directory, or null. */
  read: (taskId: string, path: string) => string | null;
  budgets: Pick<BudgetsPolicy, "task_usd" | "calibration">;
  start: Date;
  end: Date;
}

const MERGED: readonly State[] = ["MERGED", "DEPLOYING", "OBSERVING", "DONE"];
const ENDED: readonly State[] = [...MERGED, "FAILED", "CANCELLED", "SUPERSEDED", "ROLLED_BACK"];
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** The tier a task ran at: its merge verdict's tier, else the budget tier of its last session. */
export function tierOf(events: readonly FactoryEvent[]): string | null {
  const verdict = events.findLast((e) => e.type === "state_changed" && typeof e.payload["tier"] === "string")?.payload["tier"];
  if (typeof verdict === "string") return verdict;
  const session = events.findLast((e) => e.type === "stage_started" && typeof e.payload["tier"] === "string")?.payload["tier"];
  return typeof session === "string" ? session : null;
}

export const merged = (events: readonly FactoryEvent[]): boolean => events.some((e) => e.type === "state_changed" && e.to !== undefined && MERGED.includes(e.to));
/** Human commits on the factory's branch: an operator takeover that changed the candidate. */
export const humanEdited = (events: readonly FactoryEvent[]): boolean => events.some((e) => e.type === "command" && e.payload["command"] === "takeover" && typeof e.payload["to_commit"] === "string");

/** The p-th percentile (nearest rank) of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function json(read: SloInputs["read"], task: string, path: string): unknown {
  const raw = read(task, path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Every round's copy of a run file: `name` and `rounds/<n>/name`, as far as builds went. */
function rounds<T>(read: SloInputs["read"], task: string, name: string): T[] {
  const out: T[] = [];
  for (let n = 1; n <= 20; n++) {
    if (n > 1 && read(task, roundPath("build.json", n)) === null) break;
    const v = json(read, task, roundPath(name, n));
    if (v !== null) out.push(v as T);
  }
  return out;
}

export function measureSlos(i: SloInputs): SloRow[] {
  // Live tasks created in the window; replayed ones never count.
  const tasks = [...i.byTask.entries()].filter(([, events]) => {
    const created = events.find((e) => e.type === "task_created");
    if (created === undefined) return false;
    const at = Date.parse(created.ts);
    const r = taskReport(events);
    return at >= i.start.getTime() && at < i.end.getTime() && r.sessions > 0 && r.live;
  });

  // Auto-merge-ready rate: R0–R1 attempts that ended, merged with no human commit.
  const attempts = tasks.filter(([, e]) => (tierOf(e) === "R0" || tierOf(e) === "R1") && ENDED.includes(taskReport(e).state) && taskReport(e).state !== "CANCELLED");
  const ready = attempts.filter(([, e]) => merged(e) && !humanEdited(e));
  const amr: SloRow = attempts.length === 0
    ? { id: "auto_merge_ready", name: "Auto-merge-ready rate", target: "≥ 70%", value: "—", basis: "no R0–R1 attempt ended in the window", status: "no_data" }
    : { id: "auto_merge_ready", name: "Auto-merge-ready rate", target: "≥ 70%", value: pct(ready.length / attempts.length), basis: `${String(ready.length)} of ${String(attempts.length)} R0–R1 attempts`, status: ready.length / attempts.length >= 0.7 ? "met" : "missed" };

  // Escaped defects need each merged PR's reverts and linked regressions, which the store does not hold yet.
  const escaped: SloRow = { id: "escaped_defects", name: "Escaped defects", target: "≤ 3%", value: "—", basis: "not measured: needs merged PRs' reverts and linked regressions from GitHub (P2-06's client)", status: "not_measured" };

  // Reviewer precision: blocking findings the refuter upheld, of every blocking finding it answered.
  let upheld = 0;
  let answered = 0;
  for (const [id] of tasks) {
    for (const r of rounds<{ refutations: { decision: string }[] }>(i.read, id, "refutations.json")) {
      for (const x of r.refutations) {
        answered++;
        if (x.decision === "upheld") upheld++;
      }
    }
  }
  const precision: SloRow = answered === 0
    ? { id: "reviewer_precision", name: "Reviewer precision", target: "≥ 80%", value: "—", basis: "no blocking finding was answered in the window", status: "no_data" }
    : { id: "reviewer_precision", name: "Reviewer precision", target: "≥ 80%", value: pct(upheld / answered), basis: `${String(upheld)} of ${String(answered)} blocking findings upheld`, status: upheld / answered >= 0.8 ? "met" : "missed" };

  // p90 cost per merged PR, by tier, against that tier's budget; every attempt's cost counts toward the window's total.
  const budgets = calibrate(i.budgets, completedRuns(i.byTask));
  const byTier = new Map<string, number[]>();
  for (const [, e] of tasks.filter(([, e]) => merged(e))) {
    const tier = tierOf(e);
    if (tier !== null) byTier.set(tier, [...(byTier.get(tier) ?? []), taskSpend(e)]);
  }
  const over: string[] = [];
  const parts: string[] = [];
  for (const [tier, costs] of [...byTier.entries()].sort()) {
    const p90 = percentile(costs, 90);
    const budget = budgets[tier as BudgetTier].budget;
    parts.push(`${tier} $${p90.toFixed(2)} of $${budget.toFixed(2)} (${String(costs.length)} merged)`);
    if (p90 > budget) over.push(tier);
  }
  const cost: SloRow = byTier.size === 0
    ? { id: "p90_cost", name: "p90 cost per merged PR", target: "within the tier budget", value: "—", basis: "no merged task in the window", status: "no_data" }
    : { id: "p90_cost", name: "p90 cost per merged PR", target: "within the tier budget", value: parts.join("; "), basis: `failed attempts cost $${tasks.filter(([, e]) => !merged(e)).reduce((a, [, e]) => a + taskSpend(e), 0).toFixed(2)} more`, status: over.length === 0 ? "met" : "missed" };

  // Safety counters: secret material that reached a candidate (the secret-scan gate's signal).
  let secrets = 0;
  for (const [id] of tasks) {
    const gates = rounds<{ signals?: { secret_material?: boolean } }>(i.read, id, "gates.json");
    if (gates.some((g) => g.signals?.secret_material === true)) secrets++;
  }
  const denied = tasks.reduce((a, [, e]) => a + taskReport(e).stages.reduce((b, s) => b + s.denied, 0), 0);
  const safety: SloRow = { id: "safety", name: "Safety counters", target: "0", value: String(secrets), basis: `${String(secrets)} task(s) with secret material in a candidate; ${String(denied)} tool call(s) denied (blocked, not counted)`, status: tasks.length === 0 ? "no_data" : secrets === 0 ? "met" : "missed" };

  return [amr, escaped, precision, cost, safety];
}

/** Live tasks created in the window: what the SLOs were measured on. */
export function windowTasks(byTask: ReadonlyMap<string, readonly FactoryEvent[]>, start: Date, end: Date): number {
  let n = 0;
  for (const events of byTask.values()) {
    const created = events.find((e) => e.type === "task_created");
    if (created === undefined) continue;
    const at = Date.parse(created.ts);
    const r = taskReport(events);
    if (at >= start.getTime() && at < end.getTime() && r.sessions > 0 && r.live) n++;
  }
  return n;
}


// --- the telemetry panel -------------------------------------------------------------------
export interface OtelTaskPanel {
  task: string;
  exports: number;
  api_requests: number;
  api_errors: number;
  tool_decisions: { accept: number; reject: number };
}

interface KeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string | number };
}

const attrs = (list: unknown): Map<string, string> => new Map(((Array.isArray(list) ? list : []) as KeyValue[]).map((a) => [a.key, String(a.value.stringValue ?? a.value.intValue ?? "")]));

/** Per task, from the collector's files: what its sessions exported (OTLP JSON logs and metrics). */
export function otelPanel(records: readonly { signal: string; body: unknown }[]): OtelTaskPanel[] {
  const by = new Map<string, OtelTaskPanel>();
  const panel = (task: string): OtelTaskPanel => {
    let p = by.get(task);
    if (p === undefined) {
      p = { task, exports: 0, api_requests: 0, api_errors: 0, tool_decisions: { accept: 0, reject: 0 } };
      by.set(task, p);
    }
    return p;
  };
  for (const r of records) {
    const body = r.body as { resourceLogs?: unknown[]; resourceMetrics?: unknown[] };
    for (const res of [...(body.resourceLogs ?? []), ...(body.resourceMetrics ?? [])] as { resource?: { attributes?: unknown }; scopeLogs?: { logRecords?: { attributes?: unknown }[] }[] }[]) {
      const task = attrs(res.resource?.attributes).get("factory.task_id") ?? "(untagged)";
      const p = panel(task);
      p.exports++;
      for (const scope of res.scopeLogs ?? []) {
        for (const rec of scope.logRecords ?? []) {
          const a = attrs(rec.attributes);
          const name = (a.get("event.name") ?? "").replace(/^claude_code\./, "");
          if (name === "api_request") p.api_requests++;
          else if (name === "api_error") p.api_errors++;
          else if (name === "tool_decision") {
            if (a.get("decision") === "reject") p.tool_decisions.reject++;
            else p.tool_decisions.accept++;
          }
        }
      }
    }
  }
  return [...by.values()].sort((a, b) => a.task.localeCompare(b.task));
}
