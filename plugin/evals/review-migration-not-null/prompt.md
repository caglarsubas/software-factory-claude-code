---
description: "A NOT NULL column added to a populated table without a default or backfill is blocking."
tags: [role:migration-reviewer, expect:block, target:fixture]
runs: 1
model: sonnet
max_turns: 4
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the `software-factory:migration-reviewer` agent once, in the foreground, with the request below as its whole prompt, copied verbatim, and wait for its answer. Do not do the agent's work yourself and do not add advice of your own.

When the agent has answered, end your reply with exactly one line: `RESULT: <n>`, the number of findings the agent marked `blocking`.

<request>
Review the change in this evidence bundle. The bundle's files are inlined below instead of given as a path; there is no checkout to read. Return your review as JSON with `findings` and `summary`. Each finding has id (F-n), severity (blocking, major, minor or nit), category (correctness, security, test_adequacy, maintainability, dependency, migration, ux or spec_compliance), file, line, title, failure_scenario, fix and confidence (0-100).

<spec.yaml>
objective: record the currency of each order
scope: {include: [migrations/, src/orders/, test/], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "every order has a currency code, and new orders store the one they were placed in", verification: "node --test test/orders.test.ts"}
invariants: ["existing orders stay readable"]
</spec.yaml>

<diff.patch>
--- /dev/null
+++ b/migrations/0007_order_currency.sql
@@ -0,0 +1,2 @@
+-- up
+ALTER TABLE orders ADD COLUMN currency CHAR(3) NOT NULL;
--- a/src/orders/store.ts
+++ b/src/orders/store.ts
@@ -20,7 +20,7 @@ export function insertOrder(db: Database, o: NewOrder): number {
-  return db.run("INSERT INTO orders (customer, cents) VALUES (?, ?)", [o.customer, o.cents]);
+  return db.run("INSERT INTO orders (customer, cents, currency) VALUES (?, ?, ?)", [o.customer, o.cents, o.currency]);
 }
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass (the tests run against an empty database), sast pass, secrets pass, deps pass
</gates.json summary>
</request>
