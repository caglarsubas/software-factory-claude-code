import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderStore } from "../src/orders/store.ts";

test("hidden: get finds an order by id, or undefined", () => {
  const s = new OrderStore();
  s.add({ id: "a", customer: "ann", totalCents: 1, createdAt: "2026-01-01" });
  s.add({ id: "b", customer: "bob", totalCents: 2, createdAt: "2026-01-02" });
  assert.equal(s.get("b")?.totalCents, 2);
  assert.equal(s.get("z"), undefined);
});
