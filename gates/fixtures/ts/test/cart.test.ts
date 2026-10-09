import assert from "node:assert/strict";
import { test } from "node:test";
import { totalCents } from "../src/cart.ts";

test("sums unit price times quantity", () => {
  assert.equal(totalCents([{ sku: "a", unitCents: 250, quantity: 2 }, { sku: "b", unitCents: 100, quantity: 1 }]), 600);
});

test("an empty cart costs nothing", () => {
  assert.equal(totalCents([]), 0);
});
