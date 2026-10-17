// The runner's egress proxy (ROADMAP P2-01). Runner containers sit on an internal network
// whose only other member is this proxy, so every byte a session sends off the network passes
// here. It tunnels HTTPS (CONNECT) to allowlisted names on port 443 and refuses everything
// else: plain HTTP, other ports, IP literals, and any name that resolves to a loopback,
// private, link-local or otherwise non-public address, which keeps the operator's machine
// (Docker Desktop's host.docker.internal included), the controller and cloud metadata out of
// reach. It resolves names itself and connects to the address it checked, so a name cannot
// re-resolve to something else between the check and the connection. Every request is logged.
//
// Dependency-free: it runs from the runner image as `node proxy.ts`, configured by env:
//   FACTORY_EGRESS_ALLOW     comma-separated host names
//   FACTORY_EGRESS_PORT      listen port (default 3128)
//   FACTORY_EGRESS_LOG       NDJSON log file (default: stdout only)
//   FACTORY_EGRESS_UPSTREAM  http://host:port of an upstream proxy, when the host needs one
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
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
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

const v4 = (ip: string): number => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

/** Whether an address is anything but a public unicast address. */
export function blockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const a = v4(ip);
    return V4_BLOCKED.some(([net, bits]) => (a >>> (32 - bits)) === (v4(net) >>> (32 - bits)));
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
      const blocked = addresses.find(blockedAddress);
      if (blocked !== undefined) {
        record(req, target, "refused", `${d.host} resolves to non-public ${blocked}`);
        refuse(client, "403 Forbidden");
        return;
      }
      const upstream = o.upstream;
      const address = addresses[0];
      const server = upstream === undefined ? connect(address ?? d.host, d.port) : connect(upstream.host, upstream.port);
      server.on("error", () => {
        record(req, target, "failed", "upstream connection failed");
        refuse(client, "502 Bad Gateway");
      });
      server.once("connect", () => {
        if (upstream !== undefined) server.write(`CONNECT ${d.host}:${String(d.port)} HTTP/1.1\r\nHost: ${d.host}:${String(d.port)}\r\n\r\n`);
        else client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        record(req, target, "allowed", upstream === undefined ? `via ${address ?? d.host}` : "via upstream proxy");
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
  const server = createEgressProxy({
    allow,
    ...(upstream === undefined ? {} : { upstream }),
    log: (e) => {
      const line = `${JSON.stringify(e)}\n`;
      process.stdout.write(line);
      if (file !== undefined && file !== "") appendFileSync(file, line);
    },
  });
  server.listen(Number(process.env["FACTORY_EGRESS_PORT"] ?? "3128"), "0.0.0.0", () => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event: "listening", allow })}\n`);
  });
}
