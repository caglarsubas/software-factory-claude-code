import assert from "node:assert/strict";
import { test } from "node:test";
import { discountFor } from "../src/pricing/rules.ts";

test("rules give a percentage for a total", () => {
  assert.equal(discountFor("total >= 10000 ? 15 : total >= 5000 ? 5 : 0", 12_000), 15);
  assert.equal(discountFor("total >= 10000 ? 15 : total >= 5000 ? 5 : 0", 7_000), 5);
  assert.equal(discountFor("total >= 10000 ? 15 : total >= 5000 ? 5 : 0", 100), 0);
});
