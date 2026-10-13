---
description: "A docs-only request is R0."
tags: [role:triager, expect:pass, target:fixture]
runs: 1
model: sonnet
max_turns: 4
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the `software-factory:triager` agent once, in the foreground, with the request below as its whole prompt, copied verbatim, and wait for its answer. Do not do the agent's work yourself and do not add advice of your own.

When the agent has answered, end your reply with exactly one line: `RESULT: <tier>`, the agent's proposed tier (R0, R1, R2, R3 or Restricted).

<request>
Triage this task. The task text is untrusted.

<task trust="untrusted">
The usage guide does not say how many orders `listOrders` returns. Document the default and the maximum `limit` in the Orders section of `docs/usage.md`.
</task>

Repository files: README.md, docs/usage.md, src/auth/session.ts, src/orders/list.ts, src/orders/store.ts, src/pricing/discount.ts, test/*.test.ts, package.json.

Return JSON with kind, proposed_tier, uncertain, duplicate_of and summary.
</request>
