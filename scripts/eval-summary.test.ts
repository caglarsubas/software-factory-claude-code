import { describe, expect, it } from "vitest";
import { failureAnnotations, summaryRow } from "./eval-summary.ts";

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
});
