# ADR 0002: The ux-evaluator waits for a target with a preview deploy

| Field | Value |
|---|---|
| Status | Proposed in the P2-09 PR; accepted when the operator merges it |
| Date | 2026-10-17 |
| Changes | ROADMAP P2-09 (the ux-evaluator half) and the ux-evaluator row of §2.2 for Phase 2 |
| Decided by | the operator, by merging the P2-09 PR, on the evidence below |

## Context

ROADMAP P2-09 has two halves:

- **The risk-directed reviewer graph:** security, dependency and migration reviewers, chosen by the risk policy.
- **The ux-evaluator:** it drives a preview deploy with Playwright MCP, headless and `--isolated`, in its own session. Its browser reaches the preview origin only (§2.2, note 3).

The done-when names only the first: "conditional reviewers fire on seeded fixtures".

Nothing the factory serves before G2 can use the ux-evaluator:

- **No UI.** Both fixture targets (`ts-mini`, `py-mini`) are libraries, and so is the pilot target. None has a page to drive.
- **No preview deploy.** No admitted target has a preview environment. The profile's `preview.url_template` is an example only, and deploys arrive with P3-03.
- **Not on G2's path.** No G2 criterion depends on it.

Building it now would still cost a great deal:

- **Two new dependencies in the runner image:** the Playwright MCP server and a headless browser. Each needs a pin, provenance checks in `verify-tools`, and a review of its own.
- **A new egress rule:** a per-task preview origin in the egress proxy, which would also widen the threat model.
- **No test of the real path:** with no preview to drive, its evals and done-when would have only a stub page to run against.

## Decision

- **P2-09 ships the reviewer graph only:**
  - **Every candidate:** the code and security reviewers.
  - **Conditional reviewers:** the dependency and migration reviewers join when the policy engine's risk rules ask for that review on the candidate's diff.
  - **Coverage:** each has its rubric, routing, tool policy and evals. Each target seeds a task that brings one in.
- **The ux-evaluator is deferred** until a target with a UI and a preview deploy is admitted, and no earlier than P3-03 (the deploy adapter).
  - **Until then:** the policy engine's `ux` review kind stays defined, and no risk rule asks for it.
  - **When it lands:** the ux-evaluator comes with its own pins, egress rule, threat-model entry and evals, and with the P3-01 eval-replay gate.

## Consequences

- **G2 is unaffected.** The frozen system's reviewer graph is the one P2-09 ships.
- **A UI change goes without a UX review.** It still gets the code and security reviews, plus the dependency and migration reviewers where its diff calls for them. A UI target is not admitted before the ux-evaluator exists.
- **No new dependency now.** The runner image and its threat model are unchanged.

## Alternatives considered

| Option | Why not |
|---|---|
| Build the ux-evaluator now against a stub page | Two unreviewed dependencies and a new egress rule in the frozen system, for an agent nothing would use before G3 |
| Keep it in P2-09 and hold P2-09 open | P2-09 must land before the freeze, and its done-when is met without it |
