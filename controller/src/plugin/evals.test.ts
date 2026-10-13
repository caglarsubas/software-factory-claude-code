// The eval suite's own checks (P1-05): the real suite passes, and each rule fails on what it guards.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../policy/load.ts";
import { checkChange, checkSuite, EVAL_DIRS, JUDGMENT_ROLES, loadSuite, MIN_CASES, type EvalCase } from "./evals.ts";

const suite = loadSuite();

describe("the eval suite", () => {
  it("passes its checks: a pass and a block case per judgment role, targets, dispatch graders, a holdout share", () => {
    expect(checkSuite(suite)).toEqual([]);
    expect(suite.length).toBeGreaterThanOrEqual(MIN_CASES);
    for (const role of JUDGMENT_ROLES) expect(suite.some((c) => c.tags.includes(`role:${role}`)), role).toBe(true);
    expect(suite.some((c) => c.tags.includes("target:self"))).toBe(true);
    expect(suite.some((c) => c.tags.includes("target:fixture"))).toBe(true);
  });

  it("keeps run results out of the repository", () => {
    const ignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split("\n");
    for (const dir of Object.values(EVAL_DIRS)) expect(ignore).toContain(`plugin/${dir}/results/`);
  });
});

describe("the checks", () => {
  const first = suite[0];
  if (first === undefined) throw new Error("no cases");
  const variant = (over: Partial<EvalCase>): EvalCase[] => [{ ...first, ...over }, ...suite.slice(1)];
  const has = (problems: string[], text: string): boolean => problems.some((p) => p.includes(text));

  it("fail a case without a target, role or expectation, or with an unknown frontmatter key", () => {
    expect(has(checkSuite(variant({ tags: first.tags.filter((t) => !t.startsWith("target:")) })), "target:self or target:fixture")).toBe(true);
    expect(has(checkSuite(variant({ tags: [...first.tags.filter((t) => !t.startsWith("role:")), "role:nobody"] })), "role:<agent>")).toBe(true);
    expect(has(checkSuite(variant({ tags: first.tags.filter((t) => !t.startsWith("expect:")) })), "expect:pass or expect:block")).toBe(true);
    expect(has(checkSuite(variant({ frontmatter: { ...first.frontmatter, agent: "code-reviewer" } })), "unknown frontmatter key agent")).toBe(true);
  });

  it("fail a case that does not check it dispatched the plugin's agent", () => {
    const graders = first.graders.filter((g) => g.frontmatter["tool"] !== "Agent");
    expect(has(checkSuite(variant({ graders })), "no tool_used grader checks that it dispatched")).toBe(true);
  });

  it("fail a holdout tag outside the holdout directory, a missing role case, a small suite and a skewed holdout share", () => {
    expect(has(checkSuite(variant({ tags: [...first.tags, "holdout"] })), "holdout tag must match")).toBe(true);
    expect(has(checkSuite(suite.filter((c) => !(c.tags.includes("role:refuter") && c.tags.includes("expect:block")))), "no block case for the refuter")).toBe(true);
    expect(has(checkSuite(suite.slice(0, 10)), "needs at least")).toBe(true);
    expect(has(checkSuite(suite.filter((c) => !c.holdout)), "held out")).toBe(true);
  });

  it("refuse a change to an agent or rubric together with the evals that judge it", () => {
    expect(checkChange(["plugin/agents/code-reviewer.md", "plugin/evals/review-code-clean/prompt.md"])).toHaveLength(1);
    expect(checkChange(["plugin/rubrics/review.md", "plugin/evals-holdout/approve-red-gates/graders/result.md"])).toHaveLength(1);
    expect(checkChange(["plugin/agents/code-reviewer.md", "controller/src/stages/pipeline.ts"])).toEqual([]);
    expect(checkChange(["plugin/evals/review-code-clean/prompt.md", "docs/factory/STATUS.md"])).toEqual([]);
  });
});
