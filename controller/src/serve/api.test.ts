// serve's API (P2-03): loopback only, and every request needs the bound Host, its own Origin if
// any, the token, and a JSON body for a write; anything else is refused before it is read.
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiHandler, type ApiCommand } from "./api.ts";
import { bindable } from "./serve.ts";

const TOKEN = "t".repeat(43);
const commands: ApiCommand[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    apiHandler({
      token: TOKEN,
      hosts: [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`],
      status: () => ({ ok: true }),
      command: (c) => {
        commands.push(c);
        return Promise.resolve({ ok: true, message: "done" });
      },
    })(req, res);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});

/** A raw request, so the test controls Host and Origin as an attacker's browser would. */
function call(o: { method?: string; path?: string; host?: string; origin?: string; token?: string | null; type?: string; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${String(port)}` };
    if (o.origin !== undefined) headers["origin"] = o.origin;
    if (o.token !== null) headers["authorization"] = `Bearer ${o.token ?? TOKEN}`;
    if (o.type !== undefined) headers["content-type"] = o.type;
    const req = request({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path ?? "/v1/status", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(o.body ?? "");
  });
}

describe("serve API", () => {
  it("answers the bound host with the token, and runs a JSON write", async () => {
    expect(await call({})).toBe(200);
    expect(await call({ host: `localhost:${String(port)}`, origin: `http://localhost:${String(port)}` })).toBe(200);
    expect(await call({ method: "POST", path: "/v1/tasks/T-0007/pause", type: "application/json", body: '{"reason":"look"}' })).toBe(200);
    expect(commands.at(-1)).toEqual({ command: "task-pause", task: "T-0007", reason: "look" });
  });

  it("refuses a rebinding Host, a foreign Origin, a missing or wrong token, and a form-encoded write", async () => {
    const before = commands.length;
    expect(await call({ host: `evil.example:${String(port)}` })).toBe(421);
    expect(await call({ host: "127.0.0.1:1" })).toBe(421);
    expect(await call({ origin: "http://evil.example" })).toBe(403);
    expect(await call({ origin: `http://127.0.0.1:${String(port)}.evil.example` })).toBe(403);
    expect(await call({ token: null })).toBe(401);
    expect(await call({ token: "u".repeat(43) })).toBe(401);
    expect(await call({ token: TOKEN.slice(1) })).toBe(401);
    expect(await call({ method: "POST", path: "/v1/pause", type: "application/x-www-form-urlencoded", body: "a=1" })).toBe(415);
    expect(await call({ method: "POST", path: "/v1/pause" })).toBe(415);
    expect(await call({ method: "POST", path: "/v1/tasks/T-0007;rm/cancel", type: "application/json" })).toBe(404);
    expect(commands.length).toBe(before);
  });

  it("binds to loopback or a tailnet address only", () => {
    for (const h of ["127.0.0.1", "::1", "100.64.0.1", "100.127.255.254"]) expect(bindable(h), h).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.5", "10.0.0.1", "100.128.0.1", "::", "example.com"]) expect(bindable(h), h).toBe(false);
  });
});
