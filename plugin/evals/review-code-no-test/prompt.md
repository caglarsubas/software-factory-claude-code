---
description: "A behaviour change whose spec demands a new test, shipped without one, is blocking."
tags: [role:code-reviewer, expect:block, target:fixture]
runs: 1
model: sonnet
max_turns: 4
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the `software-factory:code-reviewer` agent once, in the foreground, with the request below as its whole prompt, copied verbatim, and wait for its answer. Do not do the agent's work yourself and do not add advice of your own.

When the agent has answered, end your reply with exactly one line: `RESULT: <n>`, the number of findings the agent marked `blocking`.

<request>
Review the change in this evidence bundle. The bundle's files are inlined below instead of given as a path; there is no checkout to read. Return your review as JSON with `findings` and `summary`. Each finding has id (F-n), severity (blocking, major, minor or nit), category (correctness, security, test_adequacy, maintainability, dependency, migration, ux or spec_compliance), file, line, title, failure_scenario, fix and confidence (0-100).

<spec.yaml>
objective: listOrders returns exactly `limit` orders
scope: {include: [src/orders/, test/], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "listOrders(store, {limit: n}) returns n orders when the store holds more than n", verification: "node --test test/orders.test.ts"}
  - {id: AC-2, statement: "test/orders.test.ts has a new test that fails on the old code: it asserts listOrders returns exactly limit orders", verification: "node --test test/orders.test.ts"}
invariants: ["DEFAULT_LIMIT and MAX_LIMIT keep their values"]
</spec.yaml>

<diff.patch>
--- a/src/orders/list.ts
+++ b/src/orders/list.ts
@@ -10,4 +10,4 @@ export function listOrders(store: OrderStore, options: ListOptions = {}): Order[] {
   const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
-  return store.all().slice(0, limit - 1);
+  return store.all().slice(0, limit);
 }
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets pass, deps pass
</gates.json summary>
</request>
