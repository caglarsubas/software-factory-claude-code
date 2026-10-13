---
description: "A request parameter joined into a file path is blocking."
tags: [role:security-reviewer, expect:block, target:fixture, holdout]
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
objective: customers can download their order exports
scope: {include: [src/orders/, test/], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "readExport(name) returns the content of the named export", verification: "node --test test/orders.test.ts"}
invariants: []
</spec.yaml>

<diff.patch>
--- /dev/null
+++ b/src/orders/export.ts
@@ -0,0 +1,8 @@
+import { readFileSync } from "node:fs";
+import { join } from "node:path";
+
+const EXPORTS = "/var/lib/shop/exports";
+/** The export file a customer asked to download; `file` is the request's query parameter. */
+export function readExport(file: string): string {
+  return readFileSync(join(EXPORTS, file), "utf8");
+}
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets pass, deps pass
</gates.json summary>
</request>
