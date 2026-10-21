import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("hidden: the usage guide describes OrderStore", () => {
  const usage = readFileSync(new URL("../docs/usage.md", import.meta.url), "utf8");
  assert.match(usage, /OrderStore/);
  assert.match(usage, /\badd\b/);
  assert.match(usage, /all\(\)/);
});
