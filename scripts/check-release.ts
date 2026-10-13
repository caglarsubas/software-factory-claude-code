// Repository check for releases (ROADMAP P1-09), run by `pnpm check` and by the release workflow.
//
//   node scripts/check-release.ts                       CHANGELOG.md and plugin.json agree
//   node scripts/check-release.ts --tag v0.2.0 --notes FILE   …and the tag matches; write its notes
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkRelease, readRelease, releaseNotes } from "./lib/release.ts";

// No dependencies: the release workflow runs this without installing any.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const { values } = parseArgs({ options: { tag: { type: "string" }, notes: { type: "string" } } });
const release = readRelease(REPO_ROOT);
const problems = checkRelease({ ...release, ...(values.tag === undefined ? {} : { tag: values.tag }) });
for (const p of problems) process.stdout.write(`${p}\n`);
if (problems.length === 0 && values.notes !== undefined) writeFileSync(values.notes, releaseNotes(release.changelog, release.pluginVersion));
process.stdout.write(`check-release: plugin ${release.pluginVersion}${values.tag === undefined ? "" : `, tag ${values.tag}`}, ${String(problems.length)} finding(s)\n`);
process.exitCode = problems.length === 0 ? 0 : 1;
