---
description: "A real off-by-one survives refutation."
tags: [role:refuter, expect:block, target:fixture]
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
review-code/F-1 blocking, correctness, src/orders/list.ts:13: slice(offset + 1, offset + limit) skips the order at index offset, so every page loses its first order and holds limit - 1 orders. Fix: slice(offset, offset + limit).
</finding>

<file path="src/orders/list.ts">
import type { Order, OrderStore } from "./store.ts";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export function listOrders(store: OrderStore, options: ListOptions = {}): Order[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = options.offset ?? 0;
  return store.all().slice(offset + 1, offset + limit);
}
</file>
</request>
