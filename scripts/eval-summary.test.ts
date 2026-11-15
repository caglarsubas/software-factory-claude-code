import { describe, expect, it } from "vitest";
import { failureAnnotations, replies, summaryRow } from "./eval-summary.ts";

describe("eval-summary", () => {
  it("renders one table row per suite, flagging a partial run", () => {
    const result = { costUsd: 1.512, partial: false, aggregates: { casesTotal: 17, casesPassed: 17, overallScore: 1 } };
    expect(summaryRow(result, "evals")).toBe("| evals | 17 of 17 | 1.00 | $1.51 |");
    expect(summaryRow({ ...result, partial: true }, "evals-holdout")).toBe("| evals-holdout | 17 of 17 | 1.00 | $1.51 (partial) |");
  });

  it("annotates each failing case with the graders it failed, and nothing for a clean run", () => {
    const pass = { name: "triage-docs-r0", arms: { with: [{ passed: true, score: 1, graders: [{ name: "result", passed: true }] }] }, aggregates: { score: 1, passRate: 1 } };
    const fail = {
      name: "review-code-no-test",
      arms: { with: [{ passed: false, score: 0.33, error: null, graders: [{ name: "dispatch", passed: true }, { name: "result", passed: false, explanation: "expected RESULT: 1, saw RESULT: 0\nnothing blocking" }, { name: "judge", passed: false, explanation: "50% of the criteria, a: b", evidence: "RESULT: 0" }] }] },
      aggregates: { score: 0.33, passRate: 0 },
    };
    const result = { costUsd: 1, partial: false, cases: [pass, fail], aggregates: { casesTotal: 2, casesPassed: 1, overallScore: 0.67 } };
    expect(failureAnnotations(result, "evals")).toEqual([
      "::error title=evals/review-code-no-test::evals/review-code-no-test failed (score 0.33)%0Aresult: expected RESULT: 1, saw RESULT: 0%0Anothing blocking%0Ajudge: 50%25 of the criteria, a: b%0A  judged: RESULT: 0",
    ]);
    expect(failureAnnotations({ ...result, cases: [pass] }, "evals")).toEqual([]);
    // A case with no completed run is a failure too.
    expect(failureAnnotations({ ...result, cases: [{ name: "x" }] }, "evals-holdout")).toEqual(["::error title=evals-holdout/x::evals-holdout/x failed%0Ano run completed"]);
  });

  // A `plugin eval` trace: stream-json, one event per line, a subagent's events carrying the tool
  // call they answer as parent_tool_use_id.
  const event = (text: string | null, parent: string | null = null): string =>
    JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content: text === null ? [{ type: "tool_use", id: "t1", name: "Agent", input: {} }] : [{ type: "text", text }] } });
  const trace = (...lines: string[]): string => [JSON.stringify({ type: "system", subtype: "init" }), ...lines, JSON.stringify({ type: "result", result: "x" }), ""].join("\n");

  it("reads the reply the graders saw from a trace, as plugin eval does", () => {
    // The session dispatches, the subagent answers, the session replies last.
    expect(replies(trace(event(null), event('{"proposed_tier":"R3"}', "t1"), "not json", event("Done.\nRESULT: R3")))).toEqual({
      graded: { text: "Done.\nRESULT: R3", subagent: false },
      topLevel: "Done.\nRESULT: R3",
    });
    // A subagent's text after the session's reply is what the graders read.
    expect(replies(trace(event("RESULT: R3"), event('{"proposed_tier":"R3"}', "t1")))).toEqual({
      graded: { text: '{"proposed_tier":"R3"}', subagent: true },
      topLevel: "RESULT: R3",
    });
    expect(replies(trace(event(null)))).toEqual({});
  });

  it("adds the end of each failing run's reply, when its trace was kept", () => {
    const failing = (tracePath: string) => ({
      costUsd: 0.1,
      partial: false,
      cases: [{ name: "triage-ci-config-r3", arms: { with: [{ passed: false, score: 0.33, tracePath, graders: [{ name: "result", passed: false, explanation: "pattern not found in last_message" }] }] }, aggregates: { score: 0.33, passRate: 0 } }],
      aggregates: { casesTotal: 1, casesPassed: 0, overallScore: 0.33 },
    });
    const traces: Record<string, string> = {
      "/tmp/a/trace.jsonl": trace(event(`${"x".repeat(700)}\n**RESULT: R3**`)),
      "/tmp/b/trace.jsonl": trace(event("RESULT: R3"), event("{}", "t1")),
      "/tmp/c/trace.jsonl": trace(event(null)),
    };
    const annotate = (path: string): string => decodeURIComponent(failureAnnotations(failing(path), "evals-holdout", (p) => traces[p])[0] ?? "");
    const head = "::error title=evals-holdout/triage-ci-config-r3::evals-holdout/triage-ci-config-r3 failed (score 0.33)\nresult: pattern not found in last_message\n";
    expect(annotate("/tmp/a/trace.jsonl")).toBe(`${head}reply:\n    …${"x".repeat(585)}\n    **RESULT: R3**`);
    expect(annotate("/tmp/b/trace.jsonl")).toBe(`${head}reply, as graded: a subagent's, not the session's\n    {}\nthe session's own reply, before it:\n    RESULT: R3`);
    expect(annotate("/tmp/c/trace.jsonl")).toBe(`${head}reply: none (the trace has no assistant text)`);
    expect(annotate("/tmp/gone/trace.jsonl")).toBe(`${head}reply: not kept (the eval ran without --keep-temp)`);
  });
});
