---
description: "A claimed SQL injection in a parameterised query is refuted."
tags: [role:refuter, expect:pass, target:fixture]
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
review-security/F-1 blocking, security, src/orders/search.ts:6: the customer name from the search box is concatenated into the SQL string, so a quote in it injects SQL. Fix: use a parameterised query.
</finding>

<file path="src/orders/search.ts">
import type { Database } from "./db.ts";
import type { Order } from "./store.ts";

/** Orders of customers whose name contains `name`. */
export function searchOrders(db: Database, name: string): Order[] {
  return db.query("SELECT * FROM orders WHERE customer LIKE ?", [`%${name}%`]) as Order[];
}
</file>
</request>
