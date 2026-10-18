---
description: "A pinned development dependency the spec needs, with a matching lockfile, has no blocking finding."
tags: [role:dependency-reviewer, expect:pass, target:fixture]
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
objective: add property-based tests for cart totals
scope: {include: [test/, package.json, pnpm-lock.yaml], exclude: [src/]}
acceptance_criteria:
  - {id: AC-1, statement: "a property test checks totalCents is never negative for any cart", verification: "node --test test/cart.prop.test.ts"}
invariants: ["no runtime dependency is added"]
</spec.yaml>

<diff.patch>
--- a/package.json
+++ b/package.json
@@ -8,6 +8,9 @@
   "dependencies": {
     "zod": "4.1.12"
+  },
+  "devDependencies": {
+    "fast-check": "4.3.0"
   }
 }
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -12,6 +12,10 @@ importers:
       zod:
         specifier: 4.1.12
         version: 4.1.12
+    devDependencies:
+      fast-check:
+        specifier: 4.3.0
+        version: 4.3.0
--- /dev/null
+++ b/test/cart.prop.test.ts
@@ -0,0 +1,9 @@
+import fc from "fast-check";
+import { test } from "node:test";
+import { totalCents } from "../src/cart.ts";
+
+test("totals are never negative", () => {
+  fc.assert(fc.property(fc.array(fc.record({ cents: fc.nat(), qty: fc.nat(100) })), (lines) => totalCents(lines) >= 0));
+});
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets pass, deps pass (osv: no known vulnerability in fast-check 4.3.0)
</gates.json summary>
</request>
