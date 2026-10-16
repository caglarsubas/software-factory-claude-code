// The factory-evals job's report (P1-05), from a `claude plugin eval --json` result.
//
//   node scripts/eval-summary.ts RESULT.json SUITE              one row of the job summary's table
//   node scripts/eval-summary.ts RESULT.json SUITE --failures   one ::error annotation per failing case
//
// The annotations name each failing case, the graders it failed and why, so a red run says what
// failed in its log and on the check run. Cases are fixture or self cases only (check-evals), so
// what they print may be public.
import { readFileSync } from "node:fs";

interface GraderResult {
  name: string;
  passed: boolean;
  explanation?: string;
}

interface Run {
  passed: boolean;
  score: number;
  error?: string | null;
  graders?: GraderResult[];
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

export function summaryRow(result: EvalResult, suite: string): string {
  const a = result.aggregates;
  return `| ${suite} | ${String(a.casesPassed)} of ${String(a.casesTotal)} | ${a.overallScore.toFixed(2)} | $${result.costUsd.toFixed(2)}${result.partial ? " (partial)" : ""} |`;
}

// Workflow-command escaping: data loses %, CR and LF; a property value also loses : and ,.
const data = (s: string): string => s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const property = (s: string): string => data(s).replaceAll(":", "%3A").replaceAll(",", "%2C");
const clip = (s: string): string => (s.length <= DETAIL ? s : `${s.slice(0, DETAIL)}…`);

/** One annotation per case that did not pass every run, with the graders each failing run failed. */
export function failureAnnotations(result: EvalResult, suite: string): string[] {
  return (result.cases ?? []).flatMap((c) => {
    const runs = c.arms?.with ?? [];
    const failed = runs.filter((r) => !r.passed);
    if (failed.length === 0 && runs.length > 0) return [];
    const details = failed.length === 0
      ? ["no run completed"]
      : failed.flatMap((r) => [
          ...(r.error ? [`error: ${clip(r.error)}`] : []),
          ...(r.graders ?? []).filter((g) => !g.passed).map((g) => `${g.name}: ${clip(g.explanation ?? "failed")}`),
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
