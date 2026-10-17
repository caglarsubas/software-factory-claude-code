---
description: "A nullable column with a down migration and code that handles both schemas has no blocking finding."
tags: [role:migration-reviewer, expect:pass, target:fixture]
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
objective: let customers add an optional delivery note to an order
scope: {include: [migrations/, src/orders/, test/], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "an order may carry a delivery note of at most 200 characters; orders without one are unchanged", verification: "node --test test/orders.test.ts"}
invariants: ["existing orders stay readable"]
</spec.yaml>

<diff.patch>
--- /dev/null
+++ b/migrations/0008_order_note.sql
@@ -0,0 +1,4 @@
+-- up
+ALTER TABLE orders ADD COLUMN delivery_note VARCHAR(200) NULL;
+-- down
+ALTER TABLE orders DROP COLUMN delivery_note;
--- a/src/orders/store.ts
+++ b/src/orders/store.ts
@@ -20,7 +20,7 @@ export function insertOrder(db: Database, o: NewOrder): number {
-  return db.run("INSERT INTO orders (customer, cents) VALUES (?, ?)", [o.customer, o.cents]);
+  return db.run("INSERT INTO orders (customer, cents, delivery_note) VALUES (?, ?, ?)", [o.customer, o.cents, o.note ?? null]);
 }
--- a/test/orders.test.ts
+++ b/test/orders.test.ts
@@ -30,3 +30,11 @@ test("inserts an order", () => {
+test("an order keeps its delivery note, and one without stays null", () => {
+  const db = fresh();
+  const a = insertOrder(db, { customer: "c", cents: 100, note: "leave at the door" });
+  const b = insertOrder(db, { customer: "c", cents: 100 });
+  assert.equal(getOrder(db, a).delivery_note, "leave at the door");
+  assert.equal(getOrder(db, b).delivery_note, null);
+});
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets pass, deps pass
</gates.json summary>
</request>
