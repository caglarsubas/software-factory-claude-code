import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { signSession, verifySession } from "../src/auth/session.ts";

const key = randomBytes(32);

test("a signed session verifies", () => {
  const token = signSession({ user: "ada", issuedAt: 1_760_000_000 }, key);
  assert.deepEqual(verifySession(token, key), { user: "ada", issuedAt: 1_760_000_000 });
});

test("a tampered or foreign session does not", () => {
  const token = signSession({ user: "ada", issuedAt: 1_760_000_000 }, key);
  assert.equal(verifySession(`${token}x`, key), null);
  assert.equal(verifySession(token, randomBytes(32)), null);
  assert.equal(verifySession("garbage", key), null);
});
