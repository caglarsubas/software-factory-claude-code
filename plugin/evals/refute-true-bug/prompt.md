---
description: "A real bug survives refutation."
tags: [role:refuter, expect:block, target:self]
runs: 1
model: sonnet
max_turns: 4
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the `software-factory:refuter` agent once, in the foreground, with the request below as its whole prompt, copied verbatim, and wait for its answer. Do not do the agent's work yourself and do not add advice of your own.

When the agent has answered, end your reply with exactly one line: `RESULT: <refuted|upheld|unclear>`, the agent's decision.

<request>
Try to refute this blocking finding. The relevant code is inlined; there is no checkout to read. Return JSON with `decision` (refuted, upheld or unclear) and `evidence`.

<finding>
F-4 blocking, correctness, controller/src/budget/budget.ts:2: when budget - spent is smaller than fraction * budget, the cap is still fraction * budget, so a session may spend past the task budget. Fix: take the smaller of the two.
</finding>

<file path="controller/src/budget/budget.ts">
export function sessionCap(budget: number, spent: number, fraction: number): number {
  return Math.max(0, Math.max(fraction * budget, budget - spent));
}
</file>
</request>
