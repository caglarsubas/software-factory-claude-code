// The runner's egress proxy (ROADMAP P2-01). Runner containers sit on an internal network
// whose only other member is this proxy, so every byte a session sends off the network passes
// here. It tunnels HTTPS (CONNECT) to allowlisted names on port 443 and refuses everything
// else: plain HTTP, other ports, IP literals, and any name that resolves to a loopback,
// private, link-local or otherwise non-public address, which keeps the operator's machine
// (Docker Desktop's host.docker.internal included), the controller and cloud metadata out of
// reach. It resolves names itself and connects to the address it checked, so a name cannot
// re-resolve to something else between the check and the connection. Every request is logged.
//
// One exception is opt-in (FACTORY_EGRESS_FAKE_IP): on a network whose DNS answers with fake-IP
// addresses (198.18.0.0/15, the range proxy routers and VPN apps use) and carries each
// connection on to the real host by name, an allowlisted name may resolve into the ranges the
// operator names there, and only into those. No other non-public address is ever accepted.
//
// It also carries the one route to the host (P2-02): a second listener that forwards every
// HTTP request, unchanged, to the credential gateway in factoryctl, where the runner's
// ANTHROPIC_BASE_URL points. The gateway is a fixed address set at start, never a name a session
// chooses, and it answers only a valid session token. That route's log has the method, path and
// status of each request, never a header or a body.
//
// Dependency-free: it runs from the runner image as `node proxy.ts`, configured by env:
//   FACTORY_EGRESS_ALLOW         comma-separated host names
//   FACTORY_EGRESS_PORT          listen port (default 3128)
//   FACTORY_EGRESS_LOG           NDJSON log file (default: stdout only)
//   FACTORY_EGRESS_UPSTREAM      http://host:port of an upstream proxy, when the host needs one
//   FACTORY_EGRESS_FAKE_IP       comma-separated CIDRs inside 198.18.0.0/15 (none: no exception)
//   FACTORY_EGRESS_GATEWAY       host:port of the credential gateway (none: no gateway route)
//   FACTORY_EGRESS_GATEWAY_PORT  the gateway route's listen port (default 3129)
import { appendFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Duplex } from "node:stream";

export interface ProxyOptions {
  allow: readonly string[];
  log?: (entry: Record<string, unknown>) => void;
  /** Injected in tests; defaults to the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  /** Injected in tests; defaults to a TCP connection. */
  connect?: (host: string, port: number) => Socket;
  upstream?: { host: string; port: number };
  /** Fake-IP ranges an allowlisted name may resolve into (fakeIpRanges). */
  fakeIp?: readonly [string, number][];
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

const v4 = (ip: string): number => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const within = (ip: string, [net, bits]: [string, number]): boolean => bits === 0 || (v4(ip) >>> (32 - bits)) === (v4(net) >>> (32 - bits));

/** The only range FACTORY_EGRESS_FAKE_IP may name: RFC 2544's, which fake-IP DNS answers from. */
export const FAKE_IP_RANGE: [string, number] = ["198.18.0.0", 15];

/** Whether an address is in 198.18.0.0/15, where fake-IP DNS answers come from. */
export const fakeIpAddress = (ip: string): boolean => isIP(ip) === 4 && within(ip, FAKE_IP_RANGE);

/**
 * Parses FACTORY_EGRESS_FAKE_IP: comma-separated IPv4 CIDRs, each inside 198.18.0.0/15. Anything
 * else is refused, so the setting can never open a private, loopback or metadata address.
 */
export function fakeIpRanges(value: string | undefined): [string, number][] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((part) => {
    const cidr = part.trim();
    const m = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/([0-9]{1,2})$/.exec(cidr);
    const net = m?.[1] ?? "";
    const bits = Number(m?.[2] ?? -1);
    if (m === null || isIP(net) !== 4 || bits < 0 || bits > 32) throw new Error(`FACTORY_EGRESS_FAKE_IP: ${cidr} is not an IPv4 CIDR`);
    if (bits < FAKE_IP_RANGE[1] || !within(net, FAKE_IP_RANGE)) throw new Error(`FACTORY_EGRESS_FAKE_IP: ${cidr} is not inside ${FAKE_IP_RANGE.join("/")}`);
    return [net, bits];
  });
}

/** Whether an address is anything but a public unicast address. */
export function blockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    return V4_BLOCKED.some((range) => within(ip, range));
  }
  const s = ip.toLowerCase();
  if (s.startsWith("::ffff:")) return blockedAddress(s.slice(7));
  // Loopback, unspecified, unique local (fc00::/7), link-local (fe80::/10), multicast, documentation.
  return s === "::1" || s === "::" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff") || s.startsWith("2001:db8");
}

const NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type Decision = { ok: true; host: string; port: number } | { ok: false; reason: string };

/** The policy for a CONNECT target, before any resolution. */
export function decide(target: string, allow: readonly string[]): Decision {
  const m = /^(.+):([0-9]{1,5})$/.exec(target);
  if (m === null) return { ok: false, reason: "malformed target" };
  const host = (m[1] ?? "").toLowerCase();
  const port = Number(m[2]);
  if (port !== 443) return { ok: false, reason: `port ${String(port)} is not 443` };
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return { ok: false, reason: "IP literals are refused" };
  if (!NAME.test(host)) return { ok: false, reason: "not a host name" };
  if (!allow.includes(host)) return { ok: false, reason: `${host} is not on the allowlist` };
  return { ok: true, host, port };
}

async function systemLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

export function createEgressProxy(o: ProxyOptions): Server {
  const log = o.log ?? ((e) => { process.stdout.write(`${JSON.stringify(e)}\n`); });
  const lookup = o.lookup ?? systemLookup;
  const connect = o.connect ?? ((host, port) => netConnect({ host, port }));
  const record = (req: IncomingMessage, target: string, decision: string, reason?: string): void => {
    log({ ts: new Date().toISOString(), client: req.socket.remoteAddress ?? null, method: req.method ?? null, target, decision, ...(reason === undefined ? {} : { reason }) });
  };
  const refuse = (socket: Duplex, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const server = createServer((req, res) => {
    record(req, req.url ?? "", "refused", "only CONNECT to port 443 is allowed");
    res.writeHead(403, { connection: "close" }).end();
  });
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    const target = req.url ?? "";
    const d = decide(target, o.allow);
    if (!d.ok) {
      record(req, target, "refused", d.reason);
      refuse(client, "403 Forbidden");
      return;
    }
    client.on("error", () => client.destroy());
    void (async () => {
      let addresses: string[];
      try {
        addresses = await lookup(d.host);
      } catch {
        // Behind an upstream proxy the name may not resolve here; the upstream resolves it.
        if (o.upstream === undefined) {
          record(req, target, "refused", "name does not resolve");
          refuse(client, "502 Bad Gateway");
          return;
        }
        addresses = [];
      }
      // A fake-IP answer stands for the name itself, which the network carries on to the real host.
      const fake = (ip: string): boolean => isIP(ip) === 4 && (o.fakeIp ?? []).some((range) => within(ip, range));
      const blocked = addresses.find((ip) => blockedAddress(ip) && !fake(ip));
      if (blocked !== undefined) {
        record(req, target, "refused", `${d.host} resolves to non-public ${blocked}`);
        refuse(client, "403 Forbidden");
        return;
      }
      const upstream = o.upstream;
      const address = addresses[0];
      const via = upstream !== undefined ? "via upstream proxy" : `via ${address ?? d.host}${address !== undefined && fake(address) ? " (fake-IP range)" : ""}`;
      const server = upstream === undefined ? connect(address ?? d.host, d.port) : connect(upstream.host, upstream.port);
      server.on("error", () => {
        record(req, target, "failed", "upstream connection failed");
        refuse(client, "502 Bad Gateway");
      });
      server.once("connect", () => {
        if (upstream !== undefined) server.write(`CONNECT ${d.host}:${String(d.port)} HTTP/1.1\r\nHost: ${d.host}:${String(d.port)}\r\n\r\n`);
        else client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        record(req, target, "allowed", via);
        if (head.length > 0) server.write(head);
        if (upstream === undefined) {
          server.pipe(client).pipe(server);
          return;
        }
        // The upstream's own CONNECT answer goes to the client as ours.
        server.pipe(client);
        client.pipe(server);
      });
    })();
  });
  return server;
}

/** Hop-by-hop headers, which a forwarding hop drops. */
const HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The gateway route: every request forwarded to the one gateway address, and logged without its headers. */
export function createGatewayRoute(o: { gateway: { host: string; port: number }; log?: (entry: Record<string, unknown>) => void }): Server {
  const log = o.log ?? ((e) => { process.stdout.write(`${JSON.stringify(e)}\n`); });
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const record = (status: number | string): void => {
      log({ ts: new Date().toISOString(), route: "gateway", client: req.socket.remoteAddress ?? null, method: req.method ?? null, path, status });
    };
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
    headers["host"] = `${o.gateway.host}:${String(o.gateway.port)}`;
    const up = httpRequest({ host: o.gateway.host, port: o.gateway.port, method: req.method, path: req.url, headers }, (upRes) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
      record(upRes.statusCode ?? 502);
    });
    up.on("error", () => {
      record("failed");
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"api_error","message":"egress: the gateway is unreachable"}}');
      else res.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  });
}

function gatewayFrom(v: string | undefined): { host: string; port: number } | undefined {
  if (v === undefined || v === "") return undefined;
  const m = /^(.+):([0-9]{1,5})$/.exec(v);
  if (m === null) throw new Error("FACTORY_EGRESS_GATEWAY must be host:port");
  return { host: (m[1] ?? "").replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

function upstreamFrom(url: string | undefined): { host: string; port: number } | undefined {
  if (url === undefined || url === "") return undefined;
  const u = new URL(url);
  if (u.protocol !== "http:" || u.username !== "" || u.password !== "") throw new Error("FACTORY_EGRESS_UPSTREAM must be http://host:port without credentials");
  return { host: u.hostname, port: Number(u.port === "" ? "80" : u.port) };
}

if (import.meta.main) {
  const allow = (process.env["FACTORY_EGRESS_ALLOW"] ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
  const file = process.env["FACTORY_EGRESS_LOG"];
  const upstream = upstreamFrom(process.env["FACTORY_EGRESS_UPSTREAM"]);
  const fakeIp = fakeIpRanges(process.env["FACTORY_EGRESS_FAKE_IP"]);
  const server = createEgressProxy({
    allow,
    ...(upstream === undefined ? {} : { upstream }),
    ...(fakeIp.length === 0 ? {} : { fakeIp }),
    log: (e) => {
      const line = `${JSON.stringify(e)}\n`;
      process.stdout.write(line);
      if (file !== undefined && file !== "") appendFileSync(file, line);
    },
  });
  server.listen(Number(process.env["FACTORY_EGRESS_PORT"] ?? "3128"), "0.0.0.0", () => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event: "listening", allow, ...(fakeIp.length === 0 ? {} : { fake_ip: fakeIp.map((r) => r.join("/")) }) })}\n`);
  });
  const gateway = gatewayFrom(process.env["FACTORY_EGRESS_GATEWAY"]);
  if (gateway !== undefined) {
    createGatewayRoute({
      gateway,
      log: (e) => {
        const line = `${JSON.stringify(e)}\n`;
        process.stdout.write(line);
        if (file !== undefined && file !== "") appendFileSync(file, line);
      },
    }).listen(Number(process.env["FACTORY_EGRESS_GATEWAY_PORT"] ?? "3129"), "0.0.0.0");
  }
}
