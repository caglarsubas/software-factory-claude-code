import { describe, expect, it } from "vitest";
import { summaryRow } from "./eval-summary.ts";

describe("eval-summary", () => {
  it("renders one table row per suite, flagging a partial run", () => {
    const result = { costUsd: 1.512, partial: false, aggregates: { casesTotal: 17, casesPassed: 17, overallScore: 1 } };
    expect(summaryRow(result, "evals")).toBe("| evals | 17 of 17 | 1.00 | $1.51 |");
    expect(summaryRow({ ...result, partial: true }, "evals-holdout")).toBe("| evals-holdout | 17 of 17 | 1.00 | $1.51 (partial) |");
  });
});
