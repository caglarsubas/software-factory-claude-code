import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderStore } from "../src/orders/store.ts";
import { ordersTotal } from "../src/orders/totals.ts";

test("hidden: ordersTotal sums totalCents, 0 when empty", () => {
  const s = new OrderStore();
  assert.equal(ordersTotal(s), 0);
  for (let i = 1; i <= 4; i++) s.add({ id: `o${String(i)}`, customer: "c", totalCents: i * 100, createdAt: `2026-01-0${String(i)}` });
  assert.equal(ordersTotal(s), 1000);
});
