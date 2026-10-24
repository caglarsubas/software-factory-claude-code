// The dashboard's projections (ROADMAP P2-10, §7 E2): the board and the evidence drawer, read
// from the event store and the run directories' committed files. Nothing here writes anything;
// the dashboard reads the store through a read-only connection (EventStore.openReadOnly).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { calibrate, completedRuns } from "../budget/budget.ts";
import { describeBlast, readBlasts } from "../graph/blast.ts";
import { runDir, type Home } from "../home.ts";
import type { BudgetsPolicy, BudgetTier } from "../release.ts";
import { taskReport } from "../report/report.ts";
import { tierOf } from "../report/slo.ts";
import { REVIEWERS } from "../stages/reviewers.ts";
import { latestRound, roundPath } from "../stages/rounds.ts";
import type { EventReader, FactoryEvent, State } from "../store/events.ts";
import { currentPriority, isPaused, type Priority } from "../task/lifecycle.ts";
import { readTask } from "../task/task.ts";

/** The board's columns, in lifecycle order (ROADMAP §2.1): every durable state has one. */
export const COLUMNS: readonly { name: string; states: readonly State[] }[] = [
  { name: "Received", states: ["RECEIVED", "TRIAGED", "SPECIFIED"] },
  { name: "Building", states: ["BUILDING", "VERIFYING", "REMEDIATING"] },
  { name: "Reviewing", states: ["REVIEWING", "POLICY"] },
  { name: "Needs human", states: ["NEEDS_HUMAN", "BLOCKED"] },
  { name: "Merging", states: ["AUTO_APPROVED", "MERGE_QUEUED"] },
  { name: "Merged", states: ["MERGED", "DEPLOYING", "OBSERVING", "DONE"] },
  { name: "Ended", states: ["FAILED", "CANCELLED", "SUPERSEDED", "ROLLED_BACK"] },
];

export interface Card {
  id: string;
  title: string;
  repo: string;
  state: State;
  gate: string | null;
  tier: string | null;
  paused: boolean;
  priority: Priority;
  costUsd: number;
  /** The newest event's time and sequence number: what changed last. */
  updatedAt: string;
  seq: number;
}

export interface Board {
  columns: { name: string; cards: Card[] }[];
  /** The store-wide position of the newest event, for the live stream to start from. */
  cursor: number;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function card(home: Home, id: string, events: readonly FactoryEvent[]): Card {
  const task = readTask(home, id);
  const report = taskReport(events);
  const last = events.at(-1);
  return {
    id,
    title: task.title,
    repo: task.target.repo,
    state: report.state,
    gate: report.gate,
    tier: report.tier,
    paused: isPaused(events),
    priority: currentPriority(task.priority, events),
    costUsd: Math.round(report.totals.costUsd * 100) / 100,
    updatedAt: last?.ts ?? task.created_at,
    seq: last?.seq ?? 0,
  };
}

/** Every task in its column, the most recently changed first. */
export function board(home: Home, store: EventReader): Board {
  const cards = store.taskIds().flatMap((id) => {
    const events = store.events(id);
    return events.length === 0 ? [] : [card(home, id, events)];
  });
  const cursor = store.cursor();
  return {
    columns: COLUMNS.map((c) => ({ name: c.name, cards: cards.filter((x) => c.states.includes(x.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) })),
    cursor,
  };
}

function readJson(dir: string, path: string): unknown {
  const file = join(dir, path);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** The evidence drawer (§7 E2): everything the operator weighs before deciding, from committed files and events. */
export interface Drawer {
  card: Card;
  spec: { objective: string; acceptance: { id: string; statement: string }[] } | null;
  /** The tier, and the rules that matched to set it. */
  tier: { tier: string; rules: string[] } | null;
  commits: { base: string | null; candidate: string | null };
  stages: { label: string; runner: string; model: string | null; costUsd: number; capUsd: number | null }[];
  budget: { tier: string; usd: number; spentUsd: number } | null;
  gates: { name: string; status: string; summary: string }[];
  findings: { reviewer: string; id: string; severity: string; title: string; file: string | null }[];
  verdict: { decision: string; confidence: number | null; rationale: string } | null;
  /** What people decided: the spec gate, rejection, cancellation, merges. */
  decisions: { at: string; by: string; what: string }[];
  /** The code graph's shadow decisions (P2-13). */
  blast: string[];
  timeline: { seq: number; at: string; type: string; summary: string }[];
}

function timelineEntry(e: FactoryEvent): { seq: number; at: string; type: string; summary: string } {
  const p = e.payload;
  const summary =
    e.type === "state_changed" ? `${e.from ?? "?"} → ${e.to ?? "?"}${str(p["gate"]) === null ? "" : ` (${String(p["gate"])} gate)`}`
    : e.type === "stage_started" || e.type === "stage_completed" ? `${str(p["label"]) ?? str(p["stage"]) ?? "?"}${e.type === "stage_completed" ? (p["ok"] === true ? ": ok" : ": not ok") : ""}`
    : e.type === "stage_failed" ? `${str(p["stage"]) ?? "?"}: ${str(p["category"]) ?? "?"}`
    : e.type === "command" ? str(p["command"]) ?? "command"
    : e.type === "side_effect_done" ? `${str(p["kind"]) ?? "?"}: ${str(p["outcome"]) ?? "?"}`
    : e.type === "artifact_committed" ? str(p["label"]) ?? "artifact"
    : e.type === "usage" ? `${str(p["label"]) ?? "?"}: $${typeof p["usd"] === "number" ? p["usd"].toFixed(4) : "?"}`
    : "";
  return { seq: e.seq, at: e.ts, type: e.type, summary };
}

const DECISIONS = new Set(["approve", "reject", "cancel", "takeover", "pause", "unpause", "priority"]);

export function drawer(home: Home, store: EventReader, budgets: Pick<BudgetsPolicy, "task_usd" | "calibration">, id: string): Drawer | null {
  const events = store.events(id);
  if (events.length === 0) return null;
  const dir = runDir(home, id);
  const n = latestRound(dir);
  const report = taskReport(events);

  const specFile = join(dir, "spec.yaml");
  let spec: Drawer["spec"] = null;
  if (existsSync(specFile)) {
    try {
      const s = parse(readFileSync(specFile, "utf8")) as { objective?: string; acceptance_criteria?: { id: string; statement: string }[] };
      spec = { objective: s.objective ?? "", acceptance: (s.acceptance_criteria ?? []).map((a) => ({ id: a.id, statement: a.statement })) };
    } catch {
      spec = null;
    }
  }

  const policy = readJson(dir, "policy.json") as { tier?: string; trace?: { matched: boolean; shadow: boolean; note?: string; source: string; tierAfter: string }[] } | null;
  const tier = policy?.tier === undefined ? null : {
    tier: policy.tier,
    rules: (policy.trace ?? []).filter((t) => t.matched && !t.shadow && t.source !== "baseline").map((t) => `${t.note ?? t.source} → ${t.tierAfter}`),
  };

  const checkout = readJson(dir, "checkout.json") as { base_commit?: string } | null;
  const build = readJson(dir, roundPath("build.json", n)) as { candidate_commit?: string } | null;

  const started = new Map(events.filter((e) => e.type === "stage_started" && typeof e.payload["runner"] === "string").map((e) => [str(e.payload["label"]) ?? "", e]));
  const stages = report.stages.filter((s) => s.runner !== "gates").map((s) => {
    const completed = events.findLast((e) => e.type === "stage_completed" && e.payload["label"] === s.label);
    const models = completed?.payload["models"];
    const cap = started.get(s.label)?.payload["cap_usd"];
    return { label: s.label, runner: s.runner, model: Array.isArray(models) && typeof models[0] === "string" ? models[0] : null, costUsd: Math.round(s.costUsd * 1e4) / 1e4, capUsd: typeof cap === "number" ? cap : null };
  });

  const byTask = new Map<string, FactoryEvent[]>();
  for (const e of store.allEvents()) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
  const tierNow = tierOf(events) as BudgetTier | null;
  const budget = tierNow === null ? null : { tier: tierNow, usd: calibrate(budgets, completedRuns(byTask))[tierNow].budget, spentUsd: Math.round(report.totals.costUsd * 100) / 100 };

  const gatesFile = readJson(dir, roundPath("gates.json", n)) as { gates?: { name: string; status: string; summary: string }[] } | null;
  const gates = (gatesFile?.gates ?? []).map((g) => ({ name: g.name, status: g.status, summary: g.summary }));

  const findings = REVIEWERS.flatMap((r) => {
    const review = readJson(dir, roundPath(`${r.label}.json`, n)) as { findings?: { id: string; severity: string; title: string; file?: string }[] } | null;
    return (review?.findings ?? []).map((f) => ({ reviewer: r.label, id: f.id, severity: f.severity, title: f.title, file: f.file ?? null }));
  });

  const v = readJson(dir, "verdict.json") as { decision?: string; confidence?: number; rationale?: string } | null;
  const verdict = v?.decision === undefined ? null : { decision: v.decision, confidence: typeof v.confidence === "number" ? v.confidence : null, rationale: v.rationale ?? "" };

  const decisions = events.flatMap((e) => {
    if (e.type === "command" && e.actor.kind === "operator" && DECISIONS.has(String(e.payload["command"]))) {
      const reason = str(e.payload["reason"]);
      const detail = str(e.payload["gate"]) !== null ? ` (${String(e.payload["gate"])} gate)` : str(e.payload["priority"]) !== null ? ` ${str(e.payload["from"]) ?? "?"} → ${String(e.payload["priority"])}` : "";
      return [{ at: e.ts, by: e.actor.id, what: `${String(e.payload["command"])}${detail}${reason === null ? "" : `: ${reason}`}` }];
    }
    if (e.type === "state_changed" && e.to === "MERGED") return [{ at: e.ts, by: e.actor.id, what: "merged" }];
    return [];
  });

  return {
    card: card(home, id, events),
    spec,
    tier,
    commits: { base: checkout?.base_commit ?? null, candidate: build?.candidate_commit ?? null },
    stages,
    budget,
    gates,
    findings,
    verdict,
    decisions,
    blast: readBlasts(dir).map(describeBlast),
    timeline: events.map(timelineEntry),
  };
}

/** Events after a store-wide position, for the live stream: their position, task, type and a one-line summary. */
export function eventsAfter(store: EventReader, cursor: number, limit = 200): { cursor: number; task: string; seq: number; at: string; type: string; summary: string; state: State | null }[] {
  return store.eventsAfter(cursor, limit).map(({ cursor: c, event: e }) => ({ cursor: c, task: e.task_id, ...timelineEntry(e), state: e.type === "state_changed" ? (e.to ?? null) : null }));
}
