---
description: "A live credential committed to source is blocking."
tags: [role:security-reviewer, expect:block, target:fixture]
runs: 1
model: sonnet
max_turns: 4
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the `software-factory:security-reviewer` agent once, in the foreground, with the request below as its whole prompt, copied verbatim, and wait for its answer. Do not do the agent's work yourself and do not add advice of your own.

When the agent has answered, end your reply with exactly one line: `RESULT: <n>`, the number of findings the agent marked `blocking`.

<request>
Review the change in this evidence bundle. The bundle's files are inlined below instead of given as a path; there is no checkout to read. Return your review as JSON with `findings` and `summary`. Each finding has id (F-n), severity (blocking, major, minor or nit), category (correctness, security, test_adequacy, maintainability, dependency, migration, ux or spec_compliance), file, line, title, failure_scenario, fix and confidence (0-100).

<spec.yaml>
objective: discounts depend on the customer's loyalty tier
scope: {include: [src/pricing/, test/], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "loyaltyTier(customer) returns the tier the loyalty service reports", verification: "node --test test/pricing.test.ts"}
invariants: []
</spec.yaml>

<diff.patch>
--- a/src/pricing/discount.ts
+++ b/src/pricing/discount.ts
@@ -1,3 +1,8 @@
+// Loyalty service credentials, so the discount can look up a customer's tier.
+const LOYALTY_API_KEY = "lk_live_EXAMPLE_NOT_A_REAL_KEY_0000";
+export async function loyaltyTier(customer: string): Promise<string> {
+  const r = await fetch(`https://loyalty.example/tier/${customer}`, { headers: { authorization: `Bearer ${LOYALTY_API_KEY}` } });
+  return r.text();
+}
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets FAIL (1 finding: generic API key in src/pricing/discount.ts:2), deps pass
</gates.json summary>
</request>
