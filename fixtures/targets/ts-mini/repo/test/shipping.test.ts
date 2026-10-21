import assert from "node:assert/strict";
import { test } from "node:test";
import { shippingCents } from "../src/shipping/rates.ts";

test("rates by zone", () => {
  assert.equal(shippingCents("domestic"), 500);
  assert.equal(shippingCents("eu"), 1500);
  assert.throws(() => shippingCents("moon"));
});
