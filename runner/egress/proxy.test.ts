// The egress proxy's policy (P2-01): only CONNECT, only port 443, only allowlisted names, and
// never to an address that is not public, whatever the name resolves to; and its one fixed
// route to the credential gateway (P2-02).
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockedAddress, createEgressProxy, createGatewayRoute, decide, fakeIpAddress, fakeIpRanges } from "./proxy.ts";

describe("egress proxy policy", () => {
  it("refuses other ports, IP literals, unlisted and malformed names", () => {
    const allow = ["registry.npmjs.org"];
    expect(decide("registry.npmjs.org:443", allow)).toEqual({ ok: true, host: "registry.npmjs.org", port: 443 });
    expect(decide("REGISTRY.npmjs.org:443", allow)).toMatchObject({ ok: true });
    expect(decide("registry.npmjs.org:80", allow)).toMatchObject({ ok: false, reason: "port 80 is not 443" });
    expect(decide("93.184.216.34:443", allow)).toMatchObject({ ok: false, reason: "IP literals are refused" });
    expect(decide("[::1]:443", allow)).toMatchObject({ ok: false, reason: "IP literals are refused" });
    expect(decide("host.docker.internal:443", allow)).toMatchObject({ ok: false, reason: "host.docker.internal is not on the allowlist" });
    expect(decide("evil.registry.npmjs.org:443", allow)).toMatchObject({ ok: false });
    expect(decide("registry.npmjs.org", allow)).toMatchObject({ ok: false, reason: "malformed target" });
  });

  it("knows which addresses are not public", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.65.254", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
      expect(blockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "104.16.0.1", "2606:4700::1111", "172.32.0.1"]) expect(blockedAddress(ip), ip).toBe(false);
  });

  it("takes fake-IP ranges only inside 198.18.0.0/15", () => {
    expect(fakeIpRanges(undefined)).toEqual([]);
    expect(fakeIpRanges(" ")).toEqual([]);
    expect(fakeIpRanges("198.18.0.0/15")).toEqual([["198.18.0.0", 15]]);
    expect(fakeIpRanges("198.18.1.0/24, 198.19.0.0/16")).toEqual([["198.18.1.0", 24], ["198.19.0.0", 16]]);
    for (const bad of ["10.0.0.0/8", "198.18.0.0/14", "0.0.0.0/0", "192.168.0.0/16", "198.20.0.0/16", "198.18.0.0/15,127.0.0.0/8"]) {
      expect(() => fakeIpRanges(bad), bad).toThrow(/is not inside 198\.18\.0\.0\/15/);
    }
    for (const bad of ["198.18.0.0", "198.18.0.0/33", "fd00::/8", "198.18.0.0/15;"]) expect(() => fakeIpRanges(bad), bad).toThrow(/is not an IPv4 CIDR/);
    expect([fakeIpAddress("198.18.1.7"), fakeIpAddress("198.19.255.255"), fakeIpAddress("198.20.0.1"), fakeIpAddress("10.0.0.1")]).toEqual([true, true, false, false]);
  });
});

describe("egress proxy", () => {
  let target: Server;
  let proxy: Server;
  let port = 0;
  const logs: Record<string, unknown>[] = [];
  const resolved: Record<string, string[]> = { "registry.npmjs.org": ["93.184.216.34"], "pypi.org": ["127.0.0.1"] };

  beforeAll(async () => {
    // Stands in for the public server: every allowed tunnel is connected here and echoes.
    target = createServer((s) => s.pipe(s)).listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetPort = (target.address() as AddressInfo).port;
    proxy = createEgressProxy({
      allow: ["registry.npmjs.org", "pypi.org"],
      log: (e) => logs.push(e),
      lookup: (host) => Promise.resolve(resolved[host] ?? []),
      connect: () => connect({ host: "127.0.0.1", port: targetPort }),
    }).listen(0, "127.0.0.1");
    await once(proxy, "listening");
    port = (proxy.address() as AddressInfo).port;
  });
  afterAll(() => {
    proxy.close();
    target.close();
  });

  async function tunnel(target: string, payload = "ping"): Promise<{ status: string; echo: string }> {
    const s: Socket = connect({ host: "127.0.0.1", port });
    await once(s, "connect");
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    let buf = "";
    s.setEncoding("utf8");
    return await new Promise((resolve) => {
      let sent = false;
      s.on("data", (d: string) => {
        buf += d;
        if (!sent && buf.includes("\r\n\r\n")) {
          sent = true;
          if (buf.startsWith("HTTP/1.1 200")) s.write(payload);
          else s.end();
        }
        if (buf.endsWith(payload)) s.end();
      });
      s.on("close", () => {
        const [head = "", body = ""] = buf.split("\r\n\r\n");
        resolve({ status: head.split("\r\n")[0] ?? "", echo: body });
      });
    });
  }

  it("tunnels an allowlisted name to its public address, and logs it", async () => {
    expect(await tunnel("registry.npmjs.org:443")).toEqual({ status: "HTTP/1.1 200 Connection Established", echo: "ping" });
    expect(logs.at(-1)).toMatchObject({ method: "CONNECT", target: "registry.npmjs.org:443", decision: "allowed", reason: "via 93.184.216.34" });
  });

  it("refuses an allowlisted name that resolves to a private address", async () => {
    expect((await tunnel("pypi.org:443")).status).toBe("HTTP/1.1 403 Forbidden");
    expect(logs.at(-1)).toMatchObject({ target: "pypi.org:443", decision: "refused", reason: "pypi.org resolves to non-public 127.0.0.1" });
  });

  it("refuses the host, other ports and plain HTTP", async () => {
    expect((await tunnel("host.docker.internal:443")).status).toBe("HTTP/1.1 403 Forbidden");
    expect((await tunnel("registry.npmjs.org:80")).status).toBe("HTTP/1.1 403 Forbidden");
    const res = await fetch(`http://127.0.0.1:${String(port)}/`, { headers: { host: "registry.npmjs.org" } });
    expect(res.status).toBe(403);
    expect(logs.at(-1)).toMatchObject({ method: "GET", decision: "refused", reason: "only CONNECT to port 443 is allowed" });
  });

  it("refuses a fake-IP answer when no fake-IP range is set", async () => {
    resolved["registry.npmjs.org"] = ["198.18.1.7"];
    try {
      expect((await tunnel("registry.npmjs.org:443")).status).toBe("HTTP/1.1 403 Forbidden");
      expect(logs.at(-1)).toMatchObject({ decision: "refused", reason: "registry.npmjs.org resolves to non-public 198.18.1.7" });
    } finally {
      resolved["registry.npmjs.org"] = ["93.184.216.34"];
    }
  });
});

describe("egress proxy with a fake-IP range", () => {
  let target: Server;
  let proxy: Server;
  let port = 0;
  const logs: Record<string, unknown>[] = [];
  const dialed: string[] = [];
  const resolved: Record<string, string[]> = { "registry.npmjs.org": ["198.18.1.7"], "pypi.org": ["198.18.1.154", "10.0.0.5"], "files.pythonhosted.org": ["198.18.2.5"] };

  beforeAll(async () => {
    target = createServer((s) => s.pipe(s)).listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetPort = (target.address() as AddressInfo).port;
    proxy = createEgressProxy({
      allow: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
      fakeIp: fakeIpRanges("198.18.1.0/24"),
      log: (e) => logs.push(e),
      lookup: (host) => Promise.resolve(resolved[host] ?? []),
      connect: (host) => {
        dialed.push(host);
        return connect({ host: "127.0.0.1", port: targetPort });
      },
    }).listen(0, "127.0.0.1");
    await once(proxy, "listening");
    port = (proxy.address() as AddressInfo).port;
  });
  afterAll(() => {
    proxy.close();
    target.close();
  });

  async function status(target: string): Promise<string> {
    const s: Socket = connect({ host: "127.0.0.1", port });
    await once(s, "connect");
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    s.setEncoding("utf8");
    const [first] = (await once(s, "data")) as [string];
    s.destroy();
    return first.split("\r\n")[0] ?? "";
  }

  it("tunnels an allowlisted name to its fake-IP answer, and says so in the log", async () => {
    expect(await status("registry.npmjs.org:443")).toBe("HTTP/1.1 200 Connection Established");
    expect(dialed.at(-1)).toBe("198.18.1.7");
    expect(logs.at(-1)).toMatchObject({ target: "registry.npmjs.org:443", decision: "allowed", reason: "via 198.18.1.7 (fake-IP range)" });
  });

  it("still refuses every other non-public answer, outside the named range or mixed, and names off the allowlist", async () => {
    expect(await status("pypi.org:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(logs.at(-1)).toMatchObject({ decision: "refused", reason: "pypi.org resolves to non-public 10.0.0.5" });
    expect(await status("files.pythonhosted.org:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(logs.at(-1)).toMatchObject({ decision: "refused", reason: "files.pythonhosted.org resolves to non-public 198.18.2.5" });
    expect(await status("example.com:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(logs.at(-1)).toMatchObject({ decision: "refused", reason: "example.com is not on the allowlist" });
    expect(dialed).toEqual(["198.18.1.7"]);
  });
});

describe("the gateway route (P2-02)", () => {
  let gateway: Server;
  let route: Server;
  let port = 0;
  const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    // Stands in for factoryctl's gateway: echoes what reached it.
    gateway = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        res.writeHead(req.url === "/v1/messages/count_tokens" ? 200 : 201, { "content-type": "text/event-stream" }).end("event: message_stop\ndata: {}\n\n");
      });
    }).listen(0, "127.0.0.1");
    await once(gateway, "listening");
    route = createGatewayRoute({ gateway: { host: "127.0.0.1", port: (gateway.address() as AddressInfo).port }, log: (e) => logs.push(e) }).listen(0, "127.0.0.1");
    await once(route, "listening");
    port = (route.address() as AddressInfo).port;
  });
  afterAll(() => {
    route.close();
    gateway.close();
  });

  it("forwards each request to the one gateway, unchanged, and logs no header or body", async () => {
    const r = await fetch(`http://127.0.0.1:${String(port)}/v1/messages?beta=true`, { method: "POST", headers: { "x-api-key": "sfgw_secret-token", "anthropic-version": "2023-06-01", "content-type": "application/json", host: "attacker.example" }, body: '{"model":"claude-sonnet-5-5"}' });
    expect(r.status).toBe(201);
    expect(await r.text()).toContain("message_stop");
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/v1/messages?beta=true", body: '{"model":"claude-sonnet-5-5"}', headers: { "x-api-key": "sfgw_secret-token", "anthropic-version": "2023-06-01" } });
    expect(seen.at(-1)?.headers["host"]).toBe(`127.0.0.1:${String((gateway.address() as AddressInfo).port)}`);
    expect(logs.at(-1)).toMatchObject({ route: "gateway", method: "POST", path: "/v1/messages", status: 201 });
    expect(JSON.stringify(logs)).not.toContain("sfgw_secret-token");
    expect(JSON.stringify(logs)).not.toContain("claude-sonnet-5-5");
  });

  it("answers 502 when the gateway is gone", async () => {
    const dead = createGatewayRoute({ gateway: { host: "127.0.0.1", port: 1 }, log: (e) => logs.push(e) }).listen(0, "127.0.0.1");
    await once(dead, "listening");
    try {
      const r = await fetch(`http://127.0.0.1:${String((dead.address() as AddressInfo).port)}/v1/messages`, { method: "POST", body: "{}" });
      expect(r.status).toBe(502);
      expect(logs.at(-1)).toMatchObject({ route: "gateway", status: "failed" });
    } finally {
      dead.close();
    }
  });
});
