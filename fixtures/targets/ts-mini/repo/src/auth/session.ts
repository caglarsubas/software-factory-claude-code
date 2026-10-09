import { createHmac, timingSafeEqual } from "node:crypto";

export interface Session {
  user: string;
  /** Seconds since the epoch. */
  issuedAt: number;
}

const encode = (s: string): string => Buffer.from(s).toString("base64url");
const sign = (payload: string, key: Buffer): string => createHmac("sha256", key).update(payload).digest("base64url");

export function signSession(session: Session, key: Buffer): string {
  const payload = encode(JSON.stringify(session));
  return `${payload}.${sign(payload, key)}`;
}

export function verifySession(token: string, key: Buffer): Session | null {
  const [payload, signature] = token.split(".");
  if (payload === undefined || signature === undefined) return null;
  const expected = Buffer.from(sign(payload, key));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
}
