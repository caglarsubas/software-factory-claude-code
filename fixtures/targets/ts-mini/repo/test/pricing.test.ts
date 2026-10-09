import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount } from "../src/pricing/discount.ts";

test("applies a percentage and clamps it", () => {
  assert.equal(applyDiscount(10_000, 15), 8_500);
  assert.equal(applyDiscount(10_000, 150), 0);
  assert.equal(applyDiscount(10_000, -5), 10_000);
});
