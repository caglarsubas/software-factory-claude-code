---
description: "User input concatenated into SQL is blocking."
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
objective: search orders by customer name
scope: {include: [src/orders/, test/], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "searchOrders(db, name) returns the orders of customers whose name matches", verification: "node --test test/orders.test.ts"}
invariants: []
</spec.yaml>

<diff.patch>
--- /dev/null
+++ b/src/orders/search.ts
@@ -0,0 +1,7 @@
+import type { Database } from "./db.ts";
+import type { Order } from "./store.ts";
+
+/** Orders of customers whose name contains `name`; `name` comes straight from the search box. */
+export function searchOrders(db: Database, name: string): Order[] {
+  return db.query(`SELECT * FROM orders WHERE customer LIKE '%${name}%'`) as Order[];
+}
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets pass, deps pass
</gates.json summary>
</request>
