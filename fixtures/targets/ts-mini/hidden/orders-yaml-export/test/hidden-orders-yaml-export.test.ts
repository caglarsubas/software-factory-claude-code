import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { exportOrdersYaml } from "../src/orders/export.ts";
import { OrderStore } from "../src/orders/store.ts";

test("orders export as YAML, oldest first, and parse back", () => {
  const s = new OrderStore();
  s.add({ id: "o2", customer: "b", totalCents: 250, createdAt: "2026-02-02" });
  s.add({ id: "o1", customer: "a", totalCents: 1000, createdAt: "2026-02-01" });
  assert.deepEqual(parse(exportOrdersYaml(s)), {
    orders: [
      { id: "o1", customer: "a", total_cents: 1000, created_at: "2026-02-01" },
      { id: "o2", customer: "b", total_cents: 250, created_at: "2026-02-02" },
    ],
  });
  assert.deepEqual(parse(exportOrdersYaml(new OrderStore())), { orders: [] });
});
