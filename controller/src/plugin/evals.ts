// The component eval suite (ROADMAP P1-05): `claude plugin eval` cases under plugin/evals (run on
// every push to main) and plugin/evals-holdout (run nightly only). Claude Code rejects unknown
// frontmatter keys in a case, but not a case that tests nothing useful; these checks keep the
// suite honest: every judgment role has a pass and a block case, every case names its target
// and dispatches the plugin's own agent, and a change never edits an agent and its evals at once.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { agentFiles, agentName, PLUGIN_DIR } from "./agents.ts";

export const EVAL_DIRS = { push: "evals", holdout: "evals-holdout" } as const;
/** The agents that judge rather than build: each needs a case that passes and one that blocks. */
export const JUDGMENT_ROLES = ["triager", "spec-writer", "code-reviewer", "security-reviewer", "dependency-reviewer", "migration-reviewer", "refuter", "approver", "summarizer"] as const;
/** prompt.md frontmatter keys the eval runner documents; it rejects any other. */
const CASE_KEYS = new Set(["schema_version", "name", "description", "tags", "plugins", "runs", "expected_outcome", "model", "max_turns", "timeout_seconds", "allowed_tools", "append_system_prompt", "env"]);
const GRADER_TYPES = new Set(["regex", "tool_used", "tool_order", "file_exists", "llm", "baseline"]);
export const MIN_CASES = 20;
/** The share of cases held out of push runs. */
export const HOLDOUT_SHARE = { min: 0.15, max: 0.3 };

export interface EvalCase {
  name: string;
  dir: string;
  holdout: boolean;
  frontmatter: Record<string, unknown>;
  tags: string[];
  graders: { name: string; frontmatter: Record<string, unknown> }[];
}

function frontmatter(path: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"));
  if (m === null) throw new Error(`${path}: missing frontmatter`);
  const data: unknown = parse(m[1] ?? "");
  if (typeof data !== "object" || data === null) throw new Error(`${path}: frontmatter is not a mapping`);
  return data as Record<string, unknown>;
}

export function loadSuite(pluginDir: string = PLUGIN_DIR): EvalCase[] {
  return Object.entries(EVAL_DIRS).flatMap(([kind, sub]) => {
    const root = join(pluginDir, sub);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "results" && d.name !== "mocks")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => {
        const dir = join(root, d.name);
        const fm = existsSync(join(dir, "prompt.md")) ? frontmatter(join(dir, "prompt.md")) : {};
        const gradersDir = join(dir, "graders");
        const graders = existsSync(gradersDir)
          ? readdirSync(gradersDir).filter((f) => f.endsWith(".md")).sort().map((f) => ({ name: f.slice(0, -3), frontmatter: frontmatter(join(gradersDir, f)) }))
          : [];
        const tags = Array.isArray(fm["tags"]) ? fm["tags"].map(String) : [];
        return { name: d.name, dir, holdout: kind === "holdout", frontmatter: fm, tags, graders };
      });
  });
}

const tagValue = (c: EvalCase, key: string): string[] => c.tags.filter((t) => t.startsWith(`${key}:`)).map((t) => t.slice(key.length + 1));

/** What is wrong with the suite; empty when it holds. */
export function checkSuite(cases: readonly EvalCase[], agents: ReadonlySet<string> = new Set(agentFiles().map(agentName))): string[] {
  const problems: string[] = [];
  for (const c of cases) {
    const where = `${c.holdout ? EVAL_DIRS.holdout : EVAL_DIRS.push}/${c.name}`;
    if (Object.keys(c.frontmatter).length === 0) problems.push(`${where}: no prompt.md frontmatter`);
    for (const k of Object.keys(c.frontmatter)) if (!CASE_KEYS.has(k)) problems.push(`${where}: unknown frontmatter key ${k}`);
    const targets = tagValue(c, "target");
    if (targets.length !== 1 || !["self", "fixture"].includes(targets[0] ?? "")) problems.push(`${where}: needs exactly one tag target:self or target:fixture`);
    const roles = tagValue(c, "role");
    const role = roles[0] ?? "";
    if (roles.length !== 1 || !agents.has(role)) problems.push(`${where}: needs exactly one tag role:<agent> naming a plugin agent`);
    const expects = tagValue(c, "expect");
    if (expects.length !== 1 || !["pass", "block"].includes(expects[0] ?? "")) problems.push(`${where}: needs exactly one tag expect:pass or expect:block`);
    if (c.holdout !== c.tags.includes("holdout")) problems.push(`${where}: the holdout tag must match the directory (${EVAL_DIRS.holdout}/ only)`);
    if (c.graders.length === 0) problems.push(`${where}: no graders`);
    for (const g of c.graders) if (!GRADER_TYPES.has(String(g.frontmatter["type"]))) problems.push(`${where}: grader ${g.name} has no known type`);
    // The case must exercise the plugin's agent, not a session that answers on its own.
    const dispatch = c.graders.some((g) => g.frontmatter["type"] === "tool_used" && g.frontmatter["tool"] === "Agent" && typeof g.frontmatter["input_match"] === "string" && g.frontmatter["input_match"].includes(`software-factory:${role}`));
    if (role !== "" && !dispatch) problems.push(`${where}: no tool_used grader checks that it dispatched software-factory:${role}`);
  }
  for (const role of JUDGMENT_ROLES) {
    for (const expect of ["pass", "block"]) {
      if (!cases.some((c) => tagValue(c, "role").includes(role) && tagValue(c, "expect").includes(expect))) problems.push(`no ${expect} case for the ${role}`);
    }
  }
  if (cases.length < MIN_CASES) problems.push(`${String(cases.length)} cases; the suite needs at least ${String(MIN_CASES)}`);
  const share = cases.length === 0 ? 0 : cases.filter((c) => c.holdout).length / cases.length;
  if (share < HOLDOUT_SHARE.min || share > HOLDOUT_SHARE.max) problems.push(`${String(Math.round(share * 100))}% of cases are held out; keep it between ${String(HOLDOUT_SHARE.min * 100)}% and ${String(HOLDOUT_SHARE.max * 100)}%`);
  return problems;
}

/** A change may edit the agents and rubrics or the evals that judge them, never both. */
export function checkChange(changed: readonly string[]): string[] {
  const evals = changed.filter((f) => f.startsWith(`plugin/${EVAL_DIRS.push}/`) || f.startsWith(`plugin/${EVAL_DIRS.holdout}/`));
  const judged = changed.filter((f) => f.startsWith("plugin/agents/") || f.startsWith("plugin/rubrics/"));
  if (evals.length === 0 || judged.length === 0) return [];
  return [`this change edits ${judged.join(", ")} and the evals that judge them (${String(evals.length)} file(s) under plugin/${EVAL_DIRS.push}*/); land them in separate PRs`];
}
