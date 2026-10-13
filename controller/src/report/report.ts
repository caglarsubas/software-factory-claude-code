// Run metrics and the weekly failure-taxonomy row (ROADMAP P1-07), folded from the event store.
// A task report lists each stage's runner, round, turns, tokens, minutes and cost; a week row
// counts the tasks created that week by outcome, in the columns of STATUS's weekly table, so it
// holds aggregates only and can go into the public repository as it is.
import type { FactoryEvent, State } from "../store/events.ts";
import { currentState, currentStatePayload } from "../task/lifecycle.ts";
import { buildCategory, CATEGORIES, isCategory, type Category } from "../task/taxonomy.ts";

export interface StageMetrics {
  stage: string;
  label: string;
  round: number;
  runner: string;
  ok: boolean;
  numTurns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** null for events recorded before durations were (v0.1.x). */
  durationMs: number | null;
  costUsd: number;
  denied: number;
}

export interface Findings {
  blocking: number;
  major: number;
  minor: number;
  nit: number;
}

export interface TaskReport {
  taskId: string;
  createdAt: string;
  state: State;
  gate: string | null;
  tier: string | null;
  /** The failure category, or null for a task that has not failed. */
  category: Category | null;
  /** What the pipeline saw, when it differs from the category (e.g. no_change). */
  cause: string | null;
  /** Sessions started, live or replayed. */
  sessions: number;
  /** Every session ran live; replayed tasks never count in a week row. */
  live: boolean;
  rounds: number;
  stages: StageMetrics[];
  totals: { costUsd: number; inputTokens: number; outputTokens: number; durationMs: number };
  findings: Findings | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * A failed task's category. Tasks failed by v0.1.x carry the pre-taxonomy causes
 * `build_failed` and `no_change`, which map as the pipeline maps them today.
 */
export function failureCategory(events: readonly FactoryEvent[]): { category: Category | null; cause: string | null } {
  const failed = events.findLast((e) => e.type === "state_changed" && e.to === "FAILED");
  if (failed === undefined) return { category: null, cause: null };
  const raw = failed.payload["category"];
  const cause = str(failed.payload["cause"]);
  if (isCategory(raw)) return { category: raw, cause };
  if (raw === "build_failed" || raw === "no_change") {
    const build = events.findLast((e) => e.type === "stage_completed" && e.payload["label"] === "build");
    const denied = Array.isArray(build?.payload["denied"]) ? build.payload["denied"].length : 0;
    return { category: buildCategory(denied), cause: raw };
  }
  return { category: "api_error", cause: typeof raw === "string" ? raw : "uncategorized" };
}

export function taskReport(events: readonly FactoryEvent[], reviews: readonly { findings: readonly { severity: string }[] }[] = []): TaskReport {
  const first = events[0];
  if (first === undefined) throw new Error("a task report needs the task's events");
  // Sessions record their runner on stage_started (since v0.1.0) and on stage_completed (since P1-07).
  const startedRunner = new Map<string, string>();
  const stages: StageMetrics[] = [];
  for (const e of events) {
    const label = str(e.payload["label"]) ?? "";
    const runner = str(e.payload["runner"]);
    if (e.type === "stage_started" && runner !== null) startedRunner.set(label, runner);
    if (e.type !== "stage_completed") continue;
    stages.push({
      stage: str(e.payload["stage"]) ?? "",
      label,
      round: num(e.payload["round"]) ?? 1,
      runner: runner ?? startedRunner.get(label) ?? (e.payload["stage"] === "gates" ? "gates" : "—"),
      ok: e.payload["ok"] === true,
      numTurns: num(e.payload["num_turns"]),
      inputTokens: num(e.payload["input_tokens"]),
      outputTokens: num(e.payload["output_tokens"]),
      durationMs: num(e.payload["duration_ms"]),
      costUsd: num(e.payload["cost_usd"]) ?? 0,
      denied: Array.isArray(e.payload["denied"]) ? e.payload["denied"].length : 0,
    });
  }
  const runners = events.flatMap((e) => (e.type === "stage_started" && typeof e.payload["runner"] === "string" ? [e.payload["runner"]] : []));
  const payload = currentStatePayload(events);
  const verdictTier = events.findLast((e) => e.type === "state_changed" && typeof e.payload["tier"] === "string")?.payload["tier"];
  let findings: Findings | null = null;
  if (reviews.length > 0) {
    findings = { blocking: 0, major: 0, minor: 0, nit: 0 };
    for (const r of reviews) for (const f of r.findings) if (f.severity in findings) findings[f.severity as keyof Findings]++;
  }
  return {
    taskId: first.task_id,
    createdAt: first.ts,
    state: currentState(events),
    gate: str(payload["gate"]),
    tier: str(verdictTier),
    ...failureCategory(events),
    sessions: runners.length,
    live: runners.length > 0 && runners.every((r) => r === "sdk"),
    rounds: stages.length === 0 ? 0 : Math.max(...stages.map((s) => s.round)),
    stages,
    totals: {
      costUsd: stages.reduce((a, s) => a + s.costUsd, 0),
      inputTokens: stages.reduce((a, s) => a + (s.inputTokens ?? 0), 0),
      outputTokens: stages.reduce((a, s) => a + (s.outputTokens ?? 0), 0),
      durationMs: stages.reduce((a, s) => a + (s.durationMs ?? 0), 0),
    },
    findings,
  };
}

// --- ISO weeks (UTC) -------------------------------------------------------------------------
const DAY = 86_400_000;
const WEEK = /^([0-9]{4})-W([0-9]{2})$/;

/** Monday 00:00 UTC of ISO week 1: the week that holds January 4. */
function weekOneMonday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
}

/** The ISO week of a time, as YYYY-Www. */
export function isoWeek(at: Date): string {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const thursday = day + (3 - ((new Date(day).getUTCDay() + 6) % 7)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - weekOneMonday(year)) / (7 * DAY)) + 1;
  return `${String(year)}-W${String(week).padStart(2, "0")}`;
}

/** [start, end) of an ISO week; throws on a malformed or non-existent week. */
export function weekRange(week: string): { start: Date; end: Date } {
  const m = WEEK.exec(week);
  if (m === null) throw new Error(`a week is YYYY-Www, like 2026-W42, not ${JSON.stringify(week)}`);
  const start = weekOneMonday(Number(m[1])) + (Number(m[2]) - 1) * 7 * DAY;
  if (Number(m[2]) < 1 || isoWeek(new Date(start)) !== week) throw new Error(`${week} does not exist`);
  return { start: new Date(start), end: new Date(start + 7 * DAY) };
}

// --- the weekly row --------------------------------------------------------------------------
export interface WeekRow {
  week: string;
  /** Live tasks created this week. */
  tasks: number;
  merged: number;
  counts: Record<Category, number>;
  /** Tasks still running or waiting for a human. */
  open: number;
  cancelled: number;
  /** Tasks created this week whose sessions were replayed; never counted. */
  replayed: number;
  costUsd: number;
}

const MERGED_STATES: readonly State[] = ["MERGED", "DEPLOYING", "OBSERVING", "DONE"];

export function weekRow(all: readonly FactoryEvent[], week: string): WeekRow {
  const { start, end } = weekRange(week);
  const byTask = new Map<string, FactoryEvent[]>();
  for (const e of all) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
  const row: WeekRow = { week, tasks: 0, merged: 0, counts: Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>, open: 0, cancelled: 0, replayed: 0, costUsd: 0 };
  for (const events of byTask.values()) {
    const created = events.find((e) => e.type === "task_created");
    if (created === undefined) continue;
    const at = Date.parse(created.ts);
    if (at < start.getTime() || at >= end.getTime()) continue;
    const r = taskReport(events);
    if (r.sessions > 0 && !r.live) {
      row.replayed++;
      continue;
    }
    row.tasks++;
    row.costUsd += r.totals.costUsd;
    if (events.some((e) => e.type === "state_changed" && e.to !== undefined && MERGED_STATES.includes(e.to))) row.merged++;
    else if (r.category !== null) row.counts[r.category]++;
    else if (r.state === "CANCELLED" || r.state === "SUPERSEDED") row.cancelled++;
    else row.open++;
  }
  return row;
}

/** The header of STATUS's weekly table. */
export const WEEK_HEADER = `| Week | Tasks | Merged | ${CATEGORIES.join(" | ")} | Notes |`;

/** The row for STATUS's weekly table: Week | Tasks | Merged | the ten categories | Notes. */
export function weekRowMarkdown(row: WeekRow): string {
  const notes = [
    `$${row.costUsd.toFixed(2)} in total`,
    ...(row.open > 0 ? [`${String(row.open)} open`] : []),
    ...(row.cancelled > 0 ? [`${String(row.cancelled)} cancelled`] : []),
    ...(row.replayed > 0 ? [`${String(row.replayed)} replayed, not counted`] : []),
  ].join("; ");
  return `| ${row.week} | ${String(row.tasks)} | ${String(row.merged)} | ${CATEGORIES.map((c) => String(row.counts[c])).join(" | ")} | ${notes} |`;
}
