import assert from "node:assert/strict";
import { test } from "node:test";
import { listOrdersPage } from "../src/orders/page.ts";
import { OrderStore } from "../src/orders/store.ts";

test("25 orders page as 10, 10 and 5, oldest first, with no cursor after the last page", () => {
  const s = new OrderStore();
  for (let i = 25; i >= 1; i--) s.add({ id: `o${String(i).padStart(2, "0")}`, customer: "c", totalCents: i, createdAt: `2026-02-${String(i).padStart(2, "0")}` });
  const seen: string[] = [];
  let after: string | undefined;
  const sizes: number[] = [];
  for (let n = 0; n < 5; n++) {
    const page = listOrdersPage(s, after === undefined ? { limit: 10 } : { limit: 10, after });
    sizes.push(page.orders.length);
    seen.push(...page.orders.map((o) => o.id));
    if (page.nextCursor === null) break;
    after = page.nextCursor;
  }
  assert.deepEqual(sizes, [10, 10, 5]);
  assert.deepEqual(seen, Array.from({ length: 25 }, (_, i) => `o${String(i + 1).padStart(2, "0")}`));
});
