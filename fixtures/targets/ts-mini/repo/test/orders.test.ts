import assert from "node:assert/strict";
import { test } from "node:test";
import { listOrders } from "../src/orders/list.ts";
import { OrderStore } from "../src/orders/store.ts";

function store(n: number): OrderStore {
  const s = new OrderStore();
  for (let i = n; i > 0; i--) s.add({ id: `o${String(i)}`, customer: "c", totalCents: 100 * i, createdAt: `2026-01-${String(i).padStart(2, "0")}` });
  return s;
}

test("lists orders oldest first", () => {
  const orders = listOrders(store(5));
  assert.equal(orders[0]?.id, "o1");
  assert.ok(orders.every((o, i, all) => i === 0 || (all[i - 1]?.createdAt ?? "") <= o.createdAt));
});

test("an empty store lists nothing", () => {
  assert.deepEqual(listOrders(new OrderStore()), []);
});
