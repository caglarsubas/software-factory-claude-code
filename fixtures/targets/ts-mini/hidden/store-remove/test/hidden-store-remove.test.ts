import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderStore } from "../src/orders/store.ts";

test("hidden: remove deletes only the named order", () => {
  const s = new OrderStore();
  s.add({ id: "a", customer: "c", totalCents: 1, createdAt: "2026-01-01" });
  s.add({ id: "b", customer: "c", totalCents: 2, createdAt: "2026-01-02" });
  assert.equal(s.remove("missing"), false);
  assert.equal(s.remove("a"), true);
  assert.deepEqual(s.all().map((o) => o.id), ["b"]);
});
