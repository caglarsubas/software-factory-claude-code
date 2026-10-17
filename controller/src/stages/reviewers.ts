// The reviewer graph (P2-09): code and security review every candidate; the dependency and
// migration reviewers join when the policy engine asks for their review on the candidate's diff.
import type { ReviewKind } from "../policy/engine.ts";

export interface Reviewer {
  /** The step label and the report's name, `<label>.json`. */
  label: string;
  /** Plugin agent file name. */
  agent: string;
  /** The policy engine's review that brings this reviewer in; none means every candidate. */
  when?: ReviewKind;
  focus: string;
}

export const REVIEWERS: readonly Reviewer[] = [
  { label: "review-code", agent: "code-reviewer", focus: "correctness, maintainability and test adequacy, checked against every acceptance criterion and invariant in the spec" },
  { label: "review-security", agent: "security-reviewer", focus: "authorization, injection, secrets and data exposure; try to construct an exploit before you report one" },
  { label: "review-dependency", agent: "dependency-reviewer", when: "dependency", focus: "every added or changed dependency: whether it is needed, its identity, pinning, install scripts and source" },
  { label: "review-migration", agent: "migration-reviewer", when: "migration", focus: "every schema or data migration: existing rows, destructive steps, reversibility, ordering against the code, and locks" },
];

/** The reviewers a candidate gets, given the reviews the policy engine asked for. */
export function selectReviewers(reviews: readonly ReviewKind[]): Reviewer[] {
  return REVIEWERS.filter((r) => r.when === undefined || reviews.includes(r.when));
}
