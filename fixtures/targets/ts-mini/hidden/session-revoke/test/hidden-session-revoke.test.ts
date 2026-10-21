import assert from "node:assert/strict";
import { test } from "node:test";
import { signSession, verifySession } from "../src/auth/session.ts";

test("hidden: revoked users are refused, others still verify", () => {
  const key = Buffer.from("secret-key");
  const ann = signSession({ user: "ann", issuedAt: 100 }, key);
  const bob = signSession({ user: "bob", issuedAt: 100 }, key);
  const revoked = new Set(["ann"]);
  assert.equal(verifySession(ann, key, revoked), null);
  assert.equal(verifySession(bob, key, revoked)?.user, "bob");
  assert.equal(verifySession(ann, key)?.user, "ann");
});
