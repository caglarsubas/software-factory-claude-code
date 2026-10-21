import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("hidden: the Discounts section states the 0 to 100 range", () => {
  const discounts = readFileSync(new URL("../docs/usage.md", import.meta.url), "utf8").split("## Discounts")[1] ?? "";
  assert.match(discounts, /\b0\b/);
  assert.match(discounts, /\b100\b/);
});
