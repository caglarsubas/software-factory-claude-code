// The failure taxonomy (ROADMAP P1-07): every failed task carries exactly one of these
// categories, mapped from SDK result subtypes, guard denials and the pipeline's own checks.
// The weekly review in STATUS counts tasks by category; the raw cause stays in the event.

export const CATEGORIES = [
  "gate_fail",
  "review_block",
  "budget_exceeded",
  "max_turns",
  "schema_invalid",
  "permission_denied",
  "api_error",
  "merge_conflict",
  "wall_clock",
  "human_rejected",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

const SDK_SUBTYPES: Readonly<Record<string, Category>> = {
  error_max_turns: "max_turns",
  error_max_budget_usd: "budget_exceeded",
  error_max_structured_output_retries: "schema_invalid",
};

/** A session that ended without success: its SDK result subtype, or "no_result". */
export function sdkCategory(subtype: string): Category {
  return SDK_SUBTYPES[subtype] ?? "api_error";
}

/**
 * The builder produced nothing usable. Either it recorded a failure (it could not get the
 * gates to pass) or it made no change. Denied tool calls make it a permission problem:
 * the builder was stopped, not wrong. Otherwise the change failed its gates.
 */
export function buildCategory(deniedCalls: number): Category {
  return deniedCalls > 0 ? "permission_denied" : "gate_fail";
}
