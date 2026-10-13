// Fingerprints recognise the same failure across rounds (P1-01).
import { describe, expect, it } from "vitest";
import { findingFingerprint, gateFingerprint, normalise } from "./fingerprint.ts";

describe("fingerprints", () => {
  it("normalise numbers, hashes, case and punctuation away", () => {
    expect(normalise("  TypeError at src/cart.ts:12:5 (commit 3f9a1c2d)  ")).toBe("typeerror at src cart ts # # commit #");
  });

  it("match a gate failure whose line numbers or counts moved, and nothing else", () => {
    const a = gateFingerprint({ name: "test", summary: "\n3 of 41 tests failed: cart.test.ts:88\nmore detail" });
    expect(gateFingerprint({ name: "test", summary: "5 of 42 tests failed: cart.test.ts:91" })).toBe(a);
    expect(gateFingerprint({ name: "typecheck", summary: "3 of 41 tests failed: cart.test.ts:88" })).not.toBe(a);
    expect(gateFingerprint({ name: "test", summary: "lint errors in cart.ts" })).not.toBe(a);
    expect(a).toMatch(/^gate:[0-9a-f]{16}$/);
  });

  it("match a finding by file, category and title, not by its line or id", () => {
    const f = { file: "src/cart.ts", category: "correctness", title: "isEmpty ignores 0-quantity lines" };
    expect(findingFingerprint({ ...f, title: "IsEmpty ignores 0 quantity lines." })).toBe(findingFingerprint(f));
    expect(findingFingerprint({ ...f, file: "src/order.ts" })).not.toBe(findingFingerprint(f));
    expect(findingFingerprint({ ...f, category: "security" })).not.toBe(findingFingerprint(f));
    expect(findingFingerprint(f)).toMatch(/^finding:[0-9a-f]{16}$/);
  });
});
