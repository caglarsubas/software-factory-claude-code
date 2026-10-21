import assert from "node:assert/strict";
import { test } from "node:test";
import { shippingCents } from "../src/shipping/rates.ts";

test("hidden: the world zone costs 2500 cents", () => {
  assert.equal(shippingCents("world"), 2500);
  assert.equal(shippingCents("domestic"), 500);
});
