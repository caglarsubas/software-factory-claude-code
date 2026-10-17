// Budgets and limits (ROADMAP P1-01), as pure functions over events. The controller holds the
// hard limits: a per-task budget for the task's tier, a monthly cap per target and a wall
// clock of active time. Each session also gets a soft cap (the SDK's maxBudgetUsd), and the
// Console spend limit is the backstop behind all of them.
import type { BudgetsPolicy, BudgetTier } from "../release.ts";
import type { FactoryEvent } from "../store/events.ts";

export const TIERS: readonly BudgetTier[] = ["R0", "R1", "R2", "R3", "Restricted"];

const rankOf = (t: BudgetTier): number => TIERS.indexOf(t);
const cents = (usd: number): number => Math.round(usd * 100) / 100;

export function maxTier(...tiers: readonly BudgetTier[]): BudgetTier {
  return tiers.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a), "R0");
}

/** One tier up, for a classification the triager was unsure of. */
export function raise(t: BudgetTier): BudgetTier {
  return TIERS[Math.min(rankOf(t) + 1, TIERS.length - 1)] ?? "Restricted";
}

/**
 * The tier a task is budgeted at, ratcheting up as the pipeline learns more: the highest
 * tier before triage, then triage's tier (one up when it is unsure), then the higher of
 * that, the spec's provisional tier and the policy engine's decision. It never goes down.
 */
export function budgetTier(facts: { triage?: { proposed_tier: BudgetTier; uncertain: boolean }; provisional?: BudgetTier; policy?: BudgetTier }): BudgetTier {
  if (facts.triage === undefined) return "Restricted";
  const t = facts.triage.uncertain ? raise(facts.triage.proposed_tier) : facts.triage.proposed_tier;
  return maxTier(t, facts.provisional ?? "R0", facts.policy ?? "R0");
}

export interface Charge {
  label: string;
  runner: string;
  usd: number;
  /** When the session started. */
  at: string;
  /** Started but never completed: charged its recorded cap (D4), or what the gateway metered. */
  killed: boolean;
}

/** What the credential gateway metered for each of its sessions (P2-02): the sum of their usage events. */
export function meteredSpend(events: readonly FactoryEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const session = e.payload["session"];
    const usd = e.payload["usd"];
    if (e.type === "usage" && typeof session === "string" && typeof usd === "number") out.set(session, (out.get(session) ?? 0) + usd);
  }
  return out;
}

/**
 * What a session that started and never completed is charged: what the gateway metered for it,
 * or, for a session the gateway did not meter, its cap (a killed process reports nothing, so the
 * cap keeps the hard limit an upper bound).
 */
export function unreportedCharge(started: FactoryEvent, metered: ReadonlyMap<string, number>): number {
  const session = started.payload["gateway_session"];
  if (typeof session === "string") return metered.get(session) ?? 0;
  return typeof started.payload["cap_usd"] === "number" ? started.payload["cap_usd"] : 0;
}

/**
 * What each session cost: its recorded cost (metered by the gateway from P2-02, else the
 * session's own report), or, for one that started and never completed, its unreported charge.
 */
export function charges(events: readonly FactoryEvent[]): Charge[] {
  const out: Charge[] = [];
  const open = new Map<string, Charge>();
  const metered = meteredSpend(events);
  for (const e of events) {
    const label = typeof e.payload["label"] === "string" ? e.payload["label"] : "";
    const runner = e.payload["runner"];
    if (e.type === "stage_started" && typeof runner === "string") {
      const previous = open.get(label);
      if (previous !== undefined) out.push(previous);
      open.set(label, { label, runner, usd: unreportedCharge(e, metered), at: e.ts, killed: true });
    } else if (e.type === "stage_completed" && typeof e.payload["cost_usd"] === "number") {
      const started = open.get(label);
      open.delete(label);
      out.push({ label, runner: started?.runner ?? (typeof runner === "string" ? runner : "sdk"), usd: e.payload["cost_usd"], at: started?.at ?? e.ts, killed: false });
    }
  }
  return [...out, ...open.values()];
}

export function taskSpend(events: readonly FactoryEvent[]): number {
  return charges(events).reduce((a, c) => a + c.usd, 0);
}

/** A target's live spend in a calendar month (UTC, YYYY-MM): replayed sessions cost nothing. */
export function monthSpend(byTask: ReadonlyMap<string, readonly FactoryEvent[]>, taskIds: ReadonlySet<string>, month: string): number {
  let usd = 0;
  for (const [id, events] of byTask) {
    if (!taskIds.has(id)) continue;
    for (const c of charges(events)) if (c.runner === "sdk" && c.at.startsWith(month)) usd += c.usd;
  }
  return usd;
}

export const monthOf = (at: Date): string => at.toISOString().slice(0, 7);

/** The soft cap for one session (D2): its stage's share of the task budget, never more than what remains. */
export function sessionCap(budget: number, spent: number, fraction: number): number {
  return Math.max(0, Math.min(fraction * budget, budget - spent));
}

// --- calibration (D1) --------------------------------------------------------------------
export interface CompletedRun {
  taskId: string;
  tier: BudgetTier;
  usd: number;
  at: string;
}

/** Live tasks that reached the merge gate: what a successful run of each tier cost. */
export function completedRuns(byTask: ReadonlyMap<string, readonly FactoryEvent[]>): CompletedRun[] {
  const runs: CompletedRun[] = [];
  for (const [taskId, events] of byTask) {
    const sessions = events.filter((e) => e.type === "stage_started" && typeof e.payload["runner"] === "string");
    if (sessions.length === 0 || sessions.some((e) => e.payload["runner"] !== "sdk")) continue;
    const done = events.find((e) => e.type === "state_changed" && ((e.to === "NEEDS_HUMAN" && e.payload["gate"] === "merge") || e.to === "MERGED"));
    const tier = events.findLast((e) => e.type === "state_changed" && e.to === "NEEDS_HUMAN" && e.payload["gate"] === "merge")?.payload["tier"];
    if (done === undefined || typeof tier !== "string" || !(TIERS as readonly string[]).includes(tier)) continue;
    runs.push({ taskId, tier: tier as BudgetTier, usd: taskSpend(events), at: done.ts });
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at));
}

export interface TierBudget {
  tier: BudgetTier;
  initial: number;
  budget: number;
  /** initial: no run yet; calibrating: fewer runs than the policy's minimum; frozen: set by the first minimum runs. */
  source: "initial" | "calibrating" | "frozen";
  runs: number;
  observedMaxUsd: number | null;
}

/**
 * A tier's budget is its observed maximum × the multiplier, never below the initial value,
 * while it has fewer runs than the minimum; then it freezes at the value its first runs set.
 */
export function calibrate(policy: Pick<BudgetsPolicy, "task_usd" | "calibration">, runs: readonly CompletedRun[]): Record<BudgetTier, TierBudget> {
  const { multiplier, min_runs_per_tier: min } = policy.calibration;
  const out = {} as Record<BudgetTier, TierBudget>;
  for (const tier of TIERS) {
    const mine = runs.filter((r) => r.tier === tier);
    const initial = policy.task_usd[tier];
    const observedMaxUsd = mine.length === 0 ? null : cents(Math.max(...mine.map((r) => r.usd)));
    const basis = mine.slice(0, min);
    const budget = basis.length === 0 ? initial : Math.max(initial, cents(Math.max(...basis.map((r) => r.usd)) * multiplier));
    out[tier] = { tier, initial, budget, source: mine.length === 0 ? "initial" : mine.length < min ? "calibrating" : "frozen", runs: mine.length, observedMaxUsd };
  }
  return out;
}

// --- the wall clock ----------------------------------------------------------------------
/**
 * Active time: the sum of every run's span, from its run_started to its run_ended (a killed
 * run's end is reconstructed from its heartbeat), plus the current run so far. Time a task
 * spends waiting for a human, between runs, does not count.
 */
export function activeMs(events: readonly FactoryEvent[], now: Date, currentSeq: number | null): number {
  let total = 0;
  let start: { seq: number; at: number } | null = null;
  for (const e of events) {
    const at = typeof e.payload["at"] === "string" ? Date.parse(e.payload["at"]) : Number.NaN;
    if (e.type === "command" && e.payload["command"] === "run_started" && Number.isFinite(at)) start = { seq: e.seq, at };
    else if (e.type === "command" && e.payload["command"] === "run_ended" && start !== null && Number.isFinite(at)) {
      total += Math.max(0, at - start.at);
      start = null;
    }
  }
  if (start !== null && start.seq === currentSeq) total += Math.max(0, now.getTime() - start.at);
  return total;
}
