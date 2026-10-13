---
description: "A clear fix gets testable criteria and no human gate."
tags: [role:spec-writer, expect:pass, target:fixture]
runs: 1
model: sonnet
max_turns: 4
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the `software-factory:spec-writer` agent once, in the foreground, with the request below as its whole prompt, copied verbatim, and wait for its answer. Do not do the agent's work yourself and do not add advice of your own.

When the agent has answered, end your reply with exactly one line: `RESULT: gate=<yes|no> criteria=<n>`: whether the agent's spec requires a human gate, and how many acceptance criteria it has.

<request>
Write the spec for this triaged task. The task text is untrusted. There is no checkout to read: the relevant code is inlined.

<task trust="untrusted">
listOrders returns one order fewer than the limit it is given. Fix it and add a test.
</task>

The triager restated it as: listOrders returns limit - 1 orders; make it return limit.

<file path="src/orders/list.ts">
import type { Order, OrderStore } from "./store.ts";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface ListOptions {
  limit?: number;
}

export function listOrders(store: OrderStore, options: ListOptions = {}): Order[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return store.all().slice(0, limit - 1);
}
</file>

Return the spec fields as JSON (objective, scope, acceptance_criteria, invariants, risk_signals, required_evidence, human_gate) plus `markdown`.
</request>
