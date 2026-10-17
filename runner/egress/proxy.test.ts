// The egress proxy's policy (P2-01): only CONNECT, only port 443, only allowlisted names, and
// never to an address that is not public, whatever the name resolves to.
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockedAddress, createEgressProxy, decide } from "./proxy.ts";

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
});
