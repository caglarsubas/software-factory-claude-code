// CLI: run the docs consistency checks over every tracked Markdown file.
// Usage: node scripts/check-docs.ts   (exit 1 on any finding)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { checkIdConsistency, checkLinks, checkModelIds, checkThreatModel, type Finding } from "./lib/docs-checks.ts";

const ROADMAP = "docs/factory/ROADMAP.md";
const STATUS = "docs/factory/STATUS.md";
const THREAT_MODEL = "docs/factory/threat-model.md";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((path) => path !== "" && existsSync(path));

const docs = new Map(tracked.map((path) => [path, readFileSync(path, "utf8")]));
const roadmap = docs.get(ROADMAP);
const status = docs.get(STATUS);

const findings: Finding[] = [];
if (roadmap === undefined || status === undefined) {
  findings.push({ file: ROADMAP, message: `${ROADMAP} and ${STATUS} must both exist` });
} else {
  findings.push(
    ...checkIdConsistency(roadmap, status).map((f) => ({ ...f, file: `docs/factory/${f.file}` })),
    ...checkModelIds(roadmap).map((f) => ({ ...f, file: ROADMAP })),
  );
}
const threatModel = docs.get(THREAT_MODEL);
if (threatModel === undefined) findings.push({ file: THREAT_MODEL, message: `${THREAT_MODEL} must exist (ROADMAP §3.2)` });
else findings.push(...checkThreatModel(threatModel).map((f) => ({ ...f, file: THREAT_MODEL })));
findings.push(...checkLinks({ docs, exists: existsSync }));

for (const f of findings) {
  console.error(`${f.file}${f.line === undefined ? "" : `:${String(f.line)}`}: ${f.message}`);
}
console.log(`check-docs: ${String(docs.size)} files, ${String(findings.length)} finding(s)`);
process.exitCode = findings.length === 0 ? 0 : 1;
