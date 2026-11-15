// The factory-evals job's report (P1-05), from a `claude plugin eval --json` result.
//
//   node scripts/eval-summary.ts RESULT.json SUITE              one row of the job summary's table
//   node scripts/eval-summary.ts RESULT.json SUITE --failures   one ::error annotation per failing case
//
// The annotations name each failing case, the graders it failed and why (for a judge, the reply
// it judged), and the end of each failing run's reply, so a red run says what failed in its log and
// on the check run. The reply comes from the run's trace, which `plugin eval` keeps only with
// --keep-temp. Cases are fixture or self cases only (check-evals), so what they print may be public.
import { existsSync, readFileSync } from "node:fs";

interface GraderResult {
  name: string;
  passed: boolean;
  explanation?: string;
  /** For an llm grader: what the judge was shown. */
  evidence?: string;
}

interface Run {
  passed: boolean;
  score: number;
  error?: string | null;
  graders?: GraderResult[];
  /** The run's stream-json trace, which is gone unless the eval ran with --keep-temp. */
  tracePath?: string;
}

interface Case {
  name: string;
  arms?: { with?: Run[] };
  aggregates?: { score: number; passRate: number };
}

interface EvalResult {
  costUsd: number;
  partial: boolean;
  cases?: Case[];
  aggregates: { casesTotal: number; casesPassed: number; overallScore: number };
}

const DETAIL = 300;
/** A reply's closing characters, where a case's RESULT line is. */
const REPLY_TAIL = 600;

export function summaryRow(result: EvalResult, suite: string): string {
  const a = result.aggregates;
  return `| ${suite} | ${String(a.casesPassed)} of ${String(a.casesTotal)} | ${a.overallScore.toFixed(2)} | $${result.costUsd.toFixed(2)}${result.partial ? " (partial)" : ""} |`;
}

// Workflow-command escaping: data loses %, CR and LF; a property value also loses : and ,.
const data = (s: string): string => s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const property = (s: string): string => data(s).replaceAll(":", "%3A").replaceAll(",", "%2C");
const clip = (s: string): string => (s.length <= DETAIL ? s : `${s.slice(0, DETAIL)}…`);
const tail = (s: string): string => (s.length <= REPLY_TAIL ? s : `…${s.slice(-REPLY_TAIL)}`);
const indent = (s: string): string => s.split("\n").map((l) => `    ${l}`).join("\n");

interface TraceEvent {
  type?: unknown;
  parent_tool_use_id?: unknown;
  message?: { content?: unknown };
}

export interface Replies {
  /** What the graders read as `last_message`: the text of the trace's last assistant event that
   *  has any, as `plugin eval` takes it, a subagent's events included. */
  graded?: { text: string; subagent: boolean };
  /** The last such text from the session itself, not a subagent. */
  topLevel?: string;
}

/** The replies in a `plugin eval` trace (stream-json, one event per line). */
export function replies(trace: string): Replies {
  const found: Replies = {};
  for (const line of trace.split("\n")) {
    let event: TraceEvent;
    try {
      event = JSON.parse(line) as TraceEvent;
    } catch {
      continue;
    }
    const content = event.type === "assistant" ? event.message?.content : undefined;
    if (!Array.isArray(content)) continue;
    const texts = content.flatMap((b: unknown) => {
      const block = b as { type?: unknown; text?: unknown } | null;
      return block?.type === "text" ? [typeof block.text === "string" ? block.text : ""] : [];
    });
    if (texts.length === 0) continue;
    const text = texts.join("\n");
    const subagent = event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null;
    found.graded = { text, subagent };
    if (!subagent) found.topLevel = text;
  }
  return found;
}

const readTraceFile = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** The end of a failing run's reply, or why it cannot be shown. */
function replyLines(run: Run, readTrace: (path: string) => string | undefined): string[] {
  if (run.tracePath === undefined) return [];
  const trace = readTrace(run.tracePath);
  if (trace === undefined) return ["reply: not kept (the eval ran without --keep-temp)"];
  const { graded, topLevel } = replies(trace);
  if (graded === undefined) return ["reply: none (the trace has no assistant text)"];
  if (!graded.subagent) return [`reply:\n${indent(tail(graded.text))}`];
  return [
    `reply, as graded: a subagent's, not the session's\n${indent(tail(graded.text))}`,
    topLevel === undefined ? "the session's own reply: none" : `the session's own reply, before it:\n${indent(tail(topLevel))}`,
  ];
}

/** One annotation per case that did not pass every run, with the graders each failing run failed
 *  and the end of its reply. */
export function failureAnnotations(result: EvalResult, suite: string, readTrace: (path: string) => string | undefined = readTraceFile): string[] {
  return (result.cases ?? []).flatMap((c) => {
    const runs = c.arms?.with ?? [];
    const failed = runs.filter((r) => !r.passed);
    if (failed.length === 0 && runs.length > 0) return [];
    const details = failed.length === 0
      ? ["no run completed"]
      : failed.flatMap((r) => [
          ...(r.error ? [`error: ${clip(r.error)}`] : []),
          ...(r.graders ?? []).filter((g) => !g.passed).flatMap((g) => [`${g.name}: ${clip(g.explanation ?? "failed")}`, ...(g.evidence === undefined ? [] : [`  judged: ${clip(g.evidence)}`])]),
          ...replyLines(r, readTrace),
        ]);
    const score = c.aggregates === undefined ? "" : ` (score ${c.aggregates.score.toFixed(2)})`;
    return [`::error title=${property(`${suite}/${c.name}`)}::${data(`${suite}/${c.name} failed${score}\n${details.join("\n")}`)}`];
  });
}

const [path, suite, mode] = process.argv.slice(2);
if (path !== undefined && suite !== undefined) {
  const result = JSON.parse(readFileSync(path, "utf8")) as EvalResult;
  const lines = mode === "--failures" ? failureAnnotations(result, suite) : [summaryRow(result, suite)];
  for (const l of lines) process.stdout.write(`${l}\n`);
}
