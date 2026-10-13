---
description: "Failing gates are never approved."
tags: [role:approver, expect:block, target:fixture, holdout]
runs: 1
model: sonnet
max_turns: 4
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the `software-factory:approver` agent once, in the foreground, with the request below as its whole prompt, copied verbatim, and wait for its answer. Do not do the agent's work yourself and do not add advice of your own.

When the agent has answered, end your reply with exactly one line: `RESULT: <approve|reject|needs_human>`, the agent's decision.

<request>
Decide whether the evidence proves the spec. The bundle's files are inlined; there is no checkout to read. Return JSON with decision (approve, reject or needs_human), confidence, criteria (ac_id, met, evidence), blocking_findings and rationale.

<spec.yaml>
objective: listOrders accepts an offset so callers can page through orders
scope: {include: [src/orders/, test/], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "listOrders(store, {offset: k, limit: n}) returns orders k .. k+n-1 in store order", verification: "node --test test/orders.test.ts"}
  - {id: AC-2, statement: "without an offset, listOrders returns the first `limit` orders", verification: "node --test test/orders.test.ts"}
invariants: ["DEFAULT_LIMIT and MAX_LIMIT keep their values"]
</spec.yaml>

<diff.patch>
--- a/src/orders/list.ts
+++ b/src/orders/list.ts
@@ -6,8 +6,11 @@ export const MAX_LIMIT = 100;
 export interface ListOptions {
   limit?: number;
+  /** Skip this many orders first. */
+  offset?: number;
 }

 export function listOrders(store: OrderStore, options: ListOptions = {}): Order[] {
   const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
-  return store.all().slice(0, limit - 1);
+  const offset = Math.max(options.offset ?? 0, 0);
+  return store.all().slice(offset, offset + limit);
 }
--- a/test/orders.test.ts
+++ b/test/orders.test.ts
@@ -20,0 +21,11 @@
+const five = (): OrderStore => {
+  const store = new OrderStore();
+  for (let i = 0; i < 5; i++) store.add({ id: `o${i}`, customer: "c", totalCents: 100, createdAt: `2026-01-0${i + 1}` });
+  return store;
+};
+test("pages by offset", () => {
+  assert.deepEqual(listOrders(five(), { offset: 2, limit: 2 }).map((o) => o.id), ["o2", "o3"]);
+});
+test("first page without offset", () => {
+  assert.deepEqual(listOrders(five(), { limit: 2 }).map((o) => o.id), ["o0", "o1"]);
+});
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test FAIL (test/orders.test.ts: 'pages by offset' expected 2 orders, got 1), sast pass, secrets pass, deps pass
</gates.json summary>

<review-code.json>
{"findings": [], "summary": "Looks fine."}
</review-code.json>

<review-security.json>
{"findings": [], "summary": "Pagination arithmetic only; no security-relevant change."}
</review-security.json>

<policy.json>
{"tier": "R1", "trace": ["baseline R1: code change in src/"]}
</policy.json>
</request>
