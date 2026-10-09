import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { signSession, verifySession } from "../src/auth/session.ts";

test("sessions expire after 24 hours and not before", () => {
  const key = randomBytes(32);
  const now = Math.floor(Date.now() / 1000);
  assert.notEqual(verifySession(signSession({ user: "u", issuedAt: now - 3600 }, key), key), null);
  assert.equal(verifySession(signSession({ user: "u", issuedAt: now - 25 * 3600 }, key), key), null);
});
