// Repository check for the eval suite (ROADMAP P1-05): the suite's own rules, and, given the
// base of a pull request, that the change does not edit an agent or rubric together with the
// evals that judge it.
//
//   node scripts/check-evals.ts [--base REF]
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { checkChange, checkSuite, loadSuite } from "../controller/src/plugin/evals.ts";

const { values } = parseArgs({ options: { base: { type: "string" } } });
const problems = checkSuite(loadSuite());
if (values.base !== undefined) {
  const diff = spawnSync("git", ["diff", "--name-only", `${values.base}...HEAD`], { encoding: "utf8" });
  if (diff.status !== 0) {
    process.stderr.write(`check-evals: git diff against ${values.base} failed: ${diff.stderr.trim()}\n`);
    process.exit(2);
  }
  problems.push(...checkChange(diff.stdout.split("\n").filter((l) => l !== "")));
}
for (const p of problems) process.stdout.write(`${p}\n`);
process.stdout.write(`check-evals: ${String(loadSuite().length)} cases, ${String(problems.length)} finding(s)\n`);
process.exitCode = problems.length === 0 ? 0 : 1;
