import assert from "node:assert/strict";
import { test } from "node:test";
import { ordersFor } from "../src/orders/customer.ts";
import { OrderStore } from "../src/orders/store.ts";

test("hidden: ordersFor keeps one customer's orders, oldest first, ties by id", () => {
  const s = new OrderStore();
  s.add({ id: "o3", customer: "ann", totalCents: 1, createdAt: "2026-01-03" });
  s.add({ id: "o2", customer: "bob", totalCents: 1, createdAt: "2026-01-02" });
  s.add({ id: "o1b", customer: "ann", totalCents: 1, createdAt: "2026-01-01" });
  s.add({ id: "o1a", customer: "ann", totalCents: 1, createdAt: "2026-01-01" });
  assert.deepEqual(ordersFor(s, "ann").map((o) => o.id), ["o1a", "o1b", "o3"]);
  assert.deepEqual(ordersFor(s, "nobody"), []);
});
