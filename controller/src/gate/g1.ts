// `factoryctl gate G1` (ROADMAP §5, Gate G1): runs the gate's automated criteria and drafts the
// evidence PR the operator signs. Like G0, around a window:
//
//   gate G1 --begin   snapshots each operator checkout and opens the evidence window;
//   gate G1           checks G1-1 to G1-5 and writes $FACTORY_HOME/gates/G1/evidence.json and
//                     evidence.md (the PR body).
//
// The evidence reads only the event store, the run directories, the release and GitHub's check
// runs, never what an agent wrote about its own work. evidence.md holds IDs, links and
// aggregates only: it goes into the public repository.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { calibrate, completedRuns, TIERS } from "../budget/budget.ts";
import type { CommitChecks } from "../github/client.ts";
import { runDir, type Home } from "../home.ts";
import type { Release } from "../release.ts";
import { verifyRelease } from "../release/install.ts";
import { taskReport, type TaskReport } from "../report/report.ts";
import type { Validator } from "../schemas/validate.ts";
import { allowedEnvKeys } from "../session/env.ts";
import { latestRound, roundPath } from "../stages/rounds.ts";
import type { EventStore, FactoryEvent } from "../store/events.ts";
import { currentState } from "../task/lifecycle.ts";
import { readTask } from "../task/task.ts";
import { checkoutDigest, readBegin, sessionsOf, type Begin, type Criterion, type Evidence } from "./g0.ts";

export interface G1Deps {
  checks: CommitChecks;
  /** The factory repository on GitHub; defaults to the release's own. */
  repository: string | null;
}

export interface G1Inputs {
  home: Home;
  store: EventStore;
  validator: Validator;
  release: Release;
  deps: G1Deps;
  now?: Date;
}

/** G1-1's floor, and G1-2's: counted tasks, their tiers and their targets. */
export const MIN_KILL_POINTS = 10;
export const MIN_COUNTED = 5;
export const MIN_TARGETS = 2;
const COUNTED_TIERS = new Set(["R0", "R1"]);

/** The named kill points in the release's own suite (controller/src/cli/killpoints.test.ts). */
export function killPoints(source: string): string[] {
  const start = source.indexOf("const KILL_POINTS");
  const end = source.indexOf("\n];", start);
  if (start === -1 || end === -1) return [];
  return [...source.slice(start, end).matchAll(/^\s*\["([^"]+)",/gm)].map((m) => m[1] ?? "");
}

async function checkRun(i: G1Inputs, name: string): Promise<{ ok: boolean; detail: string }> {
  const info = i.release.info;
  const repo = i.deps.repository ?? info?.repository ?? null;
  if (info === null) return { ok: false, detail: "no installed release to check CI on" };
  if (repo === null) return { ok: false, detail: "the release records no GitHub repository; pass --repo OWNER/NAME" };
  try {
    const run = (await i.deps.checks.checkRuns(repo, info.sha)).find((r) => r.name === name);
    if (run?.status === "completed" && run.conclusion === "success") return { ok: true, detail: `\`${name}\` passed on ${info.tag} (${info.sha.slice(0, 12)})` };
    return { ok: false, detail: `\`${name}\` on ${info.sha.slice(0, 12)} is ${run === undefined ? "missing" : `${run.status}/${run.conclusion ?? "pending"}`}` };
  } catch (e) {
    return { ok: false, detail: `\`${name}\`: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function g11(i: G1Inputs): Promise<Criterion> {
  const file = join(i.release.root, "controller/src/cli/killpoints.test.ts");
  const points = existsSync(file) ? killPoints(readFileSync(file, "utf8")) : [];
  const ci = await checkRun(i, "ci");
  const failures = [
    ...(points.length >= MIN_KILL_POINTS ? [] : [`${String(points.length)} kill points in the release's suite, fewer than ${String(MIN_KILL_POINTS)}`]),
    ...(ci.ok ? [] : [`factory CI: ${ci.detail}`]),
  ];
  return {
    id: "G1-1",
    criterion: `At least ${String(MIN_KILL_POINTS)} kill points (SIGKILL in every stage) re-run 0 finished stages and create 0 duplicate GitHub side effects`,
    status: failures.length === 0 ? "pass" : "fail",
    detail: failures.length === 0 ? `${String(points.length)} kill points, each asserting no re-run stage and no duplicate push or PR, pass in factory CI on the release commit` : failures.join(" | "),
    evidence: [`controller/src/cli/killpoints.test.ts in the release: ${String(points.length)} kill points (${[...new Set(points.map((p) => p.split(":")[0]?.replace(/-r[0-9]+$/, "")))].join(", ")})`, `factory CI: ${ci.detail}`],
  };
}

interface Counted {
  id: string;
  repo: string;
  pr: string;
  report: TaskReport;
}

/** The latest round's two reviews, for the findings G1-2 asks for. */
function reviews(home: Home, id: string): { findings: { severity: string }[] }[] {
  const dir = runDir(home, id);
  const n = latestRound(dir);
  return ["review-code.json", "review-security.json"].flatMap((f) => {
    const path = join(dir, roundPath(f, n));
    return existsSync(path) ? [JSON.parse(readFileSync(path, "utf8")) as { findings: { severity: string }[] }] : [];
  });
}

/** Why a merged task does not count toward G1-2; empty when it does. */
function countProblems(i: G1Inputs, id: string, events: readonly FactoryEvent[], report: TaskReport): string[] {
  const problems: string[] = [];
  if (!COUNTED_TIERS.has(report.tier ?? "")) problems.push(`tier ${report.tier ?? "unknown"}, not R0–R1`);
  if (!report.live) problems.push("replayed sessions");
  const manifest = join(runDir(i.home, id), "manifest.json");
  const commit = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { versions?: { factory_commit?: string } }).versions?.factory_commit : undefined;
  if (commit === undefined) problems.push("not run on an installed release");
  const sessions = report.stages.filter((s) => s.runner === "sdk");
  if (sessions.some((s) => s.inputTokens === null || s.outputTokens === null || s.durationMs === null || s.numTurns === null)) problems.push("a session without tokens, minutes or turns");
  if (report.findings === null) problems.push("no review findings recorded");
  if (!events.some((e) => e.type === "state_changed" && e.to === "MERGED")) problems.push("no merge recorded");
  return problems;
}

function g12(i: G1Inputs): { criterion: Criterion; counted: Counted[] } {
  const counted: Counted[] = [];
  const excluded: string[] = [];
  for (const id of i.store.taskIds()) {
    const events = i.store.events(id);
    if (currentState(events) !== "DONE") continue;
    const report = taskReport(events, reviews(i.home, id));
    const problems = countProblems(i, id, events, report);
    const merged = events.findLast((e) => e.type === "state_changed" && e.to === "MERGED");
    if (problems.length > 0) excluded.push(`${id}: ${problems.join("; ")}`);
    else counted.push({ id, repo: readTask(i.home, id).target.repo, pr: typeof merged?.payload["pr_url"] === "string" ? merged.payload["pr_url"] : "", report });
  }
  const targets = new Set(counted.map((c) => c.repo));
  const ok = counted.length >= MIN_COUNTED && targets.size >= MIN_TARGETS;
  const total = counted.reduce((a, c) => ({ usd: a.usd + c.report.totals.costUsd, ms: a.ms + c.report.totals.durationMs }), { usd: 0, ms: 0 });
  const line = (c: Counted): string => {
    const t = c.report.totals;
    const f = c.report.findings ?? { blocking: 0, major: 0, minor: 0, nit: 0 };
    return `${c.id} (${c.report.tier ?? "?"}) → <${c.pr}>: ${String(c.report.rounds)} round(s), ${String(c.report.sessions)} sessions, ${String(t.inputTokens + t.outputTokens)} tokens, ${(t.durationMs / 60_000).toFixed(1)} min, $${t.costUsd.toFixed(2)}; findings ${String(f.blocking)} blocking, ${String(f.major)} major, ${String(f.minor)} minor, ${String(f.nit)} nit`;
  };
  return {
    counted,
    criterion: {
      id: "G1-2",
      criterion: `At least ${String(MIN_COUNTED)} R0–R1 tasks are merged by the operator across ${String(MIN_TARGETS)} or more targets, with per-stage tokens, minutes, cost, rework rounds and findings`,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${String(counted.length)} R0–R1 tasks merged across ${String(targets.size)} targets, every live session with its tokens, minutes and cost; $${total.usd.toFixed(2)} and ${(total.ms / 60_000).toFixed(0)} min in all`
        : `${String(counted.length)} counted task(s) across ${String(targets.size)} target(s); G1-2 needs ${String(MIN_COUNTED)} across ${String(MIN_TARGETS)}`,
      evidence: [...counted.map(line), ...excluded.map((x) => `not counted: ${x}`)],
    },
  };
}

function g13(i: G1Inputs, begin: Begin | null, counted: Counted[]): Criterion {
  const failures: string[] = [];
  const evidence: string[] = [];
  if (begin === null) failures.push("no snapshot: run `factoryctl gate G1 --begin` before the last counted task");
  else {
    const changed = begin.checkouts.filter((c) => !existsSync(c.path) || checkoutDigest(c.path).digest !== c.digest);
    if (changed.length > 0) failures.push(`${String(changed.length)} of ${String(begin.checkouts.length)} operator checkouts changed`);
    else evidence.push(`${String(begin.checkouts.length)} operator checkout(s), ${String(begin.checkouts.reduce((n, c) => n + c.files, 0))} files, byte-identical since ${begin.started_at}`);
    const after = counted.filter((c) => c.report.createdAt >= begin.started_at);
    if (after.length === 0) failures.push("no counted task ran after the snapshot");
    else evidence.push(`counted task(s) run inside the window: ${after.map((c) => c.id).join(", ")}`);
  }
  if (i.release.info === null) failures.push("factoryctl is not running from an installed release");
  else {
    const v = verifyRelease(i.release.root, i.validator);
    if (v.ok) evidence.push(`release ${v.info.tag} unchanged since install (${v.detail})`);
    else failures.push(`the installed release was modified: ${v.detail}`);
  }
  // Every session of every counted task, and of every task since the snapshot.
  const ids = new Set([...counted.map((c) => c.id), ...(begin === null ? [] : i.store.taskIds().filter((id) => readTask(i.home, id).created_at >= begin.started_at))]);
  const sessions = [...ids].flatMap((id) => sessionsOf(i.store.events(id)));
  const leaky = sessions.filter((e) => !allowedEnvKeys(e.payload["env_keys"]));
  if (sessions.length === 0) failures.push("no sessions to check");
  else if (leaky.length > 0) failures.push(`${String(leaky.length)} of ${String(sessions.length)} sessions had an env other than the allowlist`);
  else evidence.push(`${String(sessions.length)} sessions across ${String(ids.size)} tasks, each env exactly the allowlist (plus the telemetry names when telemetry is on)`);
  return {
    id: "G1-3",
    criterion: "Zero writes to operator checkouts; the env allowlist holds in every session",
    status: failures.length === 0 ? "pass" : "fail",
    detail: failures.length === 0 ? "checkouts and release unchanged; every session env equals the allowlist" : failures.join(" | "),
    evidence,
  };
}

async function g14(i: G1Inputs): Promise<Criterion> {
  const evals = await checkRun(i, "evals");
  return {
    id: "G1-4",
    criterion: "The component eval suite passes at its stated threshold in CI",
    status: evals.ok ? "pass" : "fail",
    detail: evals.ok ? "the `factory-evals` visible suite passed at threshold 0.8 on the release commit" : `factory-evals: ${evals.detail}`,
    evidence: [`factory-evals: ${evals.detail}`],
  };
}

interface Calibration {
  computed_at: string;
  runs: number;
  tiers: Record<string, { budget: number; source: string; runs: number }>;
}

function g15(i: G1Inputs): Criterion {
  const path = join(i.home.root, "budgets", "calibration.json");
  if (!existsSync(path)) {
    return { id: "G1-5", criterion: "Tier budgets are set by the P1-01 rule and recorded", status: "fail", detail: "no recorded calibration: run `factoryctl budgets`", evidence: [] };
  }
  const recorded = JSON.parse(readFileSync(path, "utf8")) as Calibration;
  const byTask = new Map<string, FactoryEvent[]>();
  for (const e of i.store.allEvents()) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
  const now = calibrate(i.release.budgets, completedRuns(byTask));
  const stale = TIERS.filter((t) => Math.abs((recorded.tiers[t]?.budget ?? Number.NaN) - now[t].budget) > 0.005 || recorded.tiers[t]?.runs !== now[t].runs);
  return {
    id: "G1-5",
    criterion: "Tier budgets are set by the P1-01 rule and recorded",
    status: stale.length === 0 ? "pass" : "fail",
    detail: stale.length === 0 ? `recorded ${recorded.computed_at} from ${String(recorded.runs)} completed runs, and equal to the rule applied to the event store now` : `the recorded budgets for ${stale.join(", ")} differ from the rule applied now: run \`factoryctl budgets\` again`,
    evidence: TIERS.map((t) => `${t}: $${now[t].budget.toFixed(2)} (${now[t].source}, ${String(now[t].runs)} runs)`),
  };
}

function g16(): Criterion {
  return {
    id: "G1-6",
    criterion: "Human: the operator signs and enables R0–R1 auto-merge for P2",
    status: "human",
    detail: "the operator signs by approving the gates/G1 evidence PR; R0–R1 auto-merge is enabled for Phase 2 only after that",
    evidence: [],
  };
}

export async function evaluateG1(i: G1Inputs): Promise<Evidence> {
  const begin = readBegin(i.home, "G1");
  const { criterion: c12, counted } = g12(i);
  const criteria = [await g11(i), c12, g13(i, begin, counted), await g14(i), g15(i), g16()];
  const info = i.release.info;
  const evidence: Evidence = {
    schema_version: 1,
    gate: "G1",
    generated_at: (i.now ?? new Date()).toISOString(),
    release: info === null ? null : { sha: info.sha, tag: info.tag, files_digest: info.files_digest },
    passed: criteria.every((c) => c.status !== "fail"),
    criteria,
  };
  const check = i.validator.validate("gate-evidence.schema.json", evidence);
  if (!check.valid) throw new Error(`gate evidence: ${check.errors.join("; ")}`);
  return evidence;
}
