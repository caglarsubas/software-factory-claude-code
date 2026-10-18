// policy-check's entry point in a target's pull_request_target workflow (P2-05). It runs from a
// checkout of the pinned factory release, never of the PR, with the workflow's read-only token:
//
//   node controller/src/governance/policy-check-cli.ts
//
// GITHUB_REPOSITORY, GITHUB_EVENT_PATH and GITHUB_TOKEN come from Actions. The result goes to
// the job summary, and the exit code is the check's: 0 passes, anything else fails.
import { appendFileSync, readFileSync } from "node:fs";
import { ensureImage } from "../../../gates/src/image.ts";
import { loadRiskPolicy } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { policyCheck, type PolicyCheckResult } from "./policy-check.ts";
import { restPolicyReads } from "./reads.ts";
import { containerSinkScanner } from "./sinks.ts";

/** The PR number of a pull_request or pull_request_target event; anything else is refused. */
export function prFromEvent(event: unknown): number {
  const n = (event as { pull_request?: { number?: unknown } } | null)?.pull_request?.number;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new Error("policy-check runs on pull_request_target events only");
  return n;
}

export function summaryMarkdown(repo: string, pr: number, r: PolicyCheckResult): string {
  return [
    `## policy-check: ${r.conclusion === "success" ? "passed" : "failed"}: ${r.title}`,
    "",
    `${repo}#${String(pr)}: computed tier ${r.computedTier ?? "—"}, verdict tier ${r.verdictTier ?? "—"}.`,
    "",
    ...r.reasons.map((x) => `- ${x}`),
    "",
  ].join("\n");
}

async function main(): Promise<number> {
  const env = process.env;
  const repo = env["GITHUB_REPOSITORY"];
  const eventPath = env["GITHUB_EVENT_PATH"];
  if (repo === undefined || eventPath === undefined) throw new Error("GITHUB_REPOSITORY and GITHUB_EVENT_PATH must be set (run it in GitHub Actions)");
  const pr = prFromEvent(JSON.parse(readFileSync(eventPath, "utf8")));
  const result = await policyCheck({
    repo,
    pr,
    reads: restPolicyReads(env["GITHUB_TOKEN"] ?? null, env["GITHUB_API_URL"] ?? "https://api.github.com"),
    risk: loadRiskPolicy(),
    validator: createValidator(),
    scanSinks: containerSinkScanner(ensureImage()),
  });
  const summary = summaryMarkdown(repo, pr, result);
  process.stdout.write(summary);
  const stepSummary = env["GITHUB_STEP_SUMMARY"];
  if (stepSummary !== undefined) appendFileSync(stepSummary, summary);
  return result.conclusion === "success" ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`policy-check: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}
