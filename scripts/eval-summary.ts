// One row of the factory-evals job summary (P1-05), from a `claude plugin eval --json` result.
//
//   node scripts/eval-summary.ts RESULT.json SUITE
import { readFileSync } from "node:fs";

interface EvalResult {
  costUsd: number;
  partial: boolean;
  aggregates: { casesTotal: number; casesPassed: number; overallScore: number };
}

export function summaryRow(result: EvalResult, suite: string): string {
  const a = result.aggregates;
  return `| ${suite} | ${String(a.casesPassed)} of ${String(a.casesTotal)} | ${a.overallScore.toFixed(2)} | $${result.costUsd.toFixed(2)}${result.partial ? " (partial)" : ""} |`;
}

const [path, suite] = process.argv.slice(2);
if (path !== undefined && suite !== undefined) process.stdout.write(`${summaryRow(JSON.parse(readFileSync(path, "utf8")) as EvalResult, suite)}\n`);
