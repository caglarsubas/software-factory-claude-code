---
description: "A runtime dependency whose name is a look-alike of a known package, unpinned, is blocking."
tags: [role:dependency-reviewer, expect:block, target:fixture]
runs: 1
model: sonnet
max_turns: 4
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the `software-factory:dependency-reviewer` agent once, in the foreground, with the request below as its whole prompt, copied verbatim, and wait for its answer. Do not do the agent's work yourself and do not add advice of your own.

When the agent has answered, end your reply with exactly one line: `RESULT: <n>`, the number of findings the agent marked `blocking`.

<request>
Review the change in this evidence bundle. The bundle's files are inlined below instead of given as a path; there is no checkout to read. Return your review as JSON with `findings` and `summary`. Each finding has id (F-n), severity (blocking, major, minor or nit), category (correctness, security, test_adequacy, maintainability, dependency, migration, ux or spec_compliance), file, line, title, failure_scenario, fix and confidence (0-100).

<spec.yaml>
objective: format order totals with thousands separators
scope: {include: [src/orders/, test/, package.json, pnpm-lock.yaml], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "formatTotal(123456) returns \"1,234.56\"", verification: "node --test test/format.test.ts"}
invariants: ["runtime dependencies are pinned to exact versions"]
</spec.yaml>

<diff.patch>
--- a/package.json
+++ b/package.json
@@ -6,7 +6,8 @@
   "type": "module",
   "dependencies": {
-    "zod": "4.1.12"
+    "zod": "4.1.12",
+    "lodahs": "^4.17.21"
   }
 }
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -9,6 +9,9 @@ importers:
     dependencies:
+      lodahs:
+        specifier: ^4.17.21
+        version: 4.17.23
       zod:
         specifier: 4.1.12
         version: 4.1.12
--- /dev/null
+++ b/src/orders/format.ts
@@ -0,0 +1,6 @@
+import { chunk } from "lodahs";
+
+/** A total in cents, as dollars with thousands separators. */
+export function formatTotal(cents: number): string {
+  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
+}
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets pass, deps pass (osv: no known vulnerability in lodahs 4.17.23)
</gates.json summary>
</request>
