import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFlatDiscount } from "../src/pricing/discount.ts";

test("hidden: applyFlatDiscount subtracts, floors at 0, ignores negatives", () => {
  assert.equal(applyFlatDiscount(5000, 1999), 3001);
  assert.equal(applyFlatDiscount(500, 500), 0);
  assert.equal(applyFlatDiscount(500, 900), 0);
  assert.equal(applyFlatDiscount(500, -100), 500);
});
