import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the usage guide states the default and maximum limit", () => {
  const orders = readFileSync(new URL("../docs/usage.md", import.meta.url), "utf8").split("## Sessions")[0] ?? "";
  assert.match(orders, /limit/i);
  assert.match(orders, /\b20\b/);
  assert.match(orders, /\b100\b/);
});
