// The CLI as serve's client (ROADMAP P2-03): while serve runs it is the single writer, so
// commands that change a task go to its API instead of the store.
import type { Home } from "../home.ts";
import { serveToken, type ServeLock } from "./serve.ts";

export interface ServeReply {
  status: number;
  body: { ok?: boolean; message?: string; error?: string } & Record<string, unknown>;
}

export async function callServe(home: Home, lock: ServeLock, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<ServeReply> {
  const host = lock.host.includes(":") ? `[${lock.host}]` : lock.host;
  const res = await fetch(`http://${host}:${String(lock.port)}${path}`, {
    method,
    headers: { authorization: `Bearer ${serveToken(home)}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: res.status, body: (await res.json()) as ServeReply["body"] };
}
