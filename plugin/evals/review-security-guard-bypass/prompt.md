---
description: "A guard change that unprotects paths written with a trailing slash is blocking."
tags: [role:security-reviewer, expect:block, target:self]
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
objective: speed up the guard's protected-path check
scope: {include: [plugin/hooks/lib/], exclude: []}
acceptance_criteria:
  - {id: AC-1, statement: "isProtected returns the same answer as before for every path, faster", verification: "pnpm test plugin/hooks"}
invariants: ["the guard denies every write to a protected path"]
</spec.yaml>

<diff.patch>
--- a/plugin/hooks/lib/guard-policy.ts
+++ b/plugin/hooks/lib/guard-policy.ts
@@ -40,6 +40,8 @@ export function isProtected(path: string, globs: readonly string[]): boolean {
-  const rel = normalise(path);
+  // Paths with a trailing slash name directories, which the guard need not protect.
+  if (path.endsWith("/")) return false;
+  const rel = normalise(path);
   return globs.some((g) => matches(rel, g));
 }
</diff.patch>

<gates.json summary>
typecheck pass, lint pass, test pass, sast pass, secrets pass, deps pass
</gates.json summary>
</request>
