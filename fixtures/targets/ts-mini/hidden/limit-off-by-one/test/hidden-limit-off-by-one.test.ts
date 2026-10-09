import assert from "node:assert/strict";
import { test } from "node:test";
import { listOrders, MAX_LIMIT } from "../src/orders/list.ts";
import { OrderStore } from "../src/orders/store.ts";

test("listOrders returns exactly limit orders when it has them", () => {
  const s = new OrderStore();
  for (let i = 1; i <= 150; i++) s.add({ id: `o${String(i)}`, customer: "c", totalCents: i, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() });
  assert.equal(listOrders(s, { limit: 1 }).length, 1);
  assert.equal(listOrders(s, { limit: 7 }).length, 7);
  assert.equal(listOrders(s).length, 20);
  assert.equal(listOrders(s, { limit: 500 }).length, MAX_LIMIT);
});
