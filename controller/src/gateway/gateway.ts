// The credential and budget gateway (ROADMAP P2-02, §3.2). Sessions never hold the Anthropic
// key: each one gets a token for this gateway (ANTHROPIC_BASE_URL plus an apiKeyHelper that
// reads the token's file), and the gateway, inside factoryctl on the host, swaps the token for
// the key on the way out. A token is good for one session of one task, up to a dollar limit,
// the task's hard budget that is left when the session starts. Every response is metered
// from the usage the API reports (meter.ts), priced by the release's pinned table, and recorded
// on the task's ledger as it passes; once a session's metered spend reaches its limit, its
// next request is refused, so a task stops at its hard cap mid-stage. The kill switch refuses
// every request and revokes every token, and a token is revoked when its session ends.
//
// What reaches the upstream: POST /v1/messages and /v1/messages/count_tokens only, for a model
// the price table names, with the session's own headers minus its credential, hop-by-hop
// headers and compression. Everything else is refused here, and nothing about a request's
// content is logged.
import { createHash, randomBytes } from "node:crypto";
import { chownSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describeHalt, readHalt } from "../halt.ts";
import type { Home } from "../home.ts";
import type { Prices } from "../release.ts";
import type { EventStore } from "../store/events.ts";
import { NO_USAGE, priceUsage, UsageMeter, type Usage } from "./meter.ts";

export const ANTHROPIC_API = "https://api.anthropic.com";
/** The API's own request limit. */
const MAX_BODY = 32 * 1024 * 1024;
const METERED = "/v1/messages";
const ROUTES = new Set([METERED, "/v1/messages/count_tokens"]);

/** Request headers never forwarded: the session's credential, hop-by-hop headers, and what the gateway sets itself. */
const DROP_REQUEST = new Set(["host", "authorization", "x-api-key", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding", "cookie", "forwarded"]);
/** Response headers not relayed: hop-by-hop, and the body's framing, which the gateway redoes. */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "proxy-authenticate", "te", "trailer", "upgrade", "set-cookie"]);

export interface GatewaySession {
  id: string;
  taskId: string;
  label: string;
  limitUsd: number;
  spentUsd: number;
  requests: number;
  /** Why the gateway refused this session's last request, if it did. */
  refused: "budget" | "halted" | null;
}

/** One metered response, as the task's ledger records it. */
export interface UsageEntry {
  session: string;
  task: string;
  label: string;
  model: string;
  usage: Usage;
  usd: number;
  /** False when the response ended before saying what it used. */
  reported: boolean;
  request_id: string | null;
}

export interface GatewayOptions {
  prices: Prices;
  /** The operator's key file: read once, at start, and only ever sent upstream. */
  keyFile: string;
  /** Default ANTHROPIC_API; a stub model in tests. */
  upstream?: string;
  /** Addresses to listen on: loopback for host sessions, and the one runner containers reach through their proxy. */
  hosts: string[];
  /** The kill switch: a description while the factory is halted, else null. */
  halted: () => string | null;
  /** Records a metered response on the task's ledger; a throw (a lost lease) revokes the session. */
  onUsage: (e: UsageEntry) => void;
  log: (line: string) => void;
}

export interface Gateway {
  /** The base URL on each listening address, in the order of `hosts`. */
  urls: string[];
  issue(o: { taskId: string; label: string; limitUsd: number }): { id: string; token: string };
  revoke(id: string): void;
  session(id: string): GatewaySession | undefined;
  close(): Promise<void>;
}

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type, message: `factory gateway: ${message}` } }));
}

function credential(req: IncomingMessage): string | null {
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && key !== "") return key.trim();
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") === true ? auth.slice(7).trim() : null;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function startGateway(o: GatewayOptions): Promise<Gateway> {
  const key = readFileSync(o.keyFile, "utf8").trim();
  if (key === "") throw new Error(`${o.keyFile} is empty`);
  const upstream = (o.upstream ?? ANTHROPIC_API).replace(/\/+$/, "");
  const byToken = new Map<string, GatewaySession>();
  const byId = new Map<string, { session: GatewaySession; digest: string }>();

  function revokeAll(reason: "halted"): void {
    for (const s of byToken.values()) s.refused = reason;
    byToken.clear();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    // The CLI's connectivity check: answered here, nothing upstream.
    if (req.method === "GET" && path === "/api/hello") {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (req.method !== "POST" || !ROUTES.has(path)) {
      o.log(`refused ${req.method ?? "?"} ${path}: not a gateway route`);
      apiError(res, 404, "not_found_error", "unknown route");
      return;
    }
    const token = credential(req);
    const session = token === null ? undefined : byToken.get(digest(token));
    if (session === undefined) {
      apiError(res, 401, "authentication_error", "unknown or revoked token");
      return;
    }
    const halt = o.halted();
    if (halt !== null) {
      revokeAll("halted");
      o.log(`${session.taskId} ${session.label}: refused, the factory is ${halt}`);
      apiError(res, 403, "permission_error", `the factory is ${halt}`);
      return;
    }
    if (session.spentUsd >= session.limitUsd) {
      session.refused = "budget";
      o.log(`${session.taskId} ${session.label}: refused, spent $${session.spentUsd.toFixed(4)} of its $${session.limitUsd.toFixed(4)} limit`);
      apiError(res, 403, "permission_error", `the task's hard budget is spent ($${session.spentUsd.toFixed(2)} of $${session.limitUsd.toFixed(2)})`);
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      apiError(res, 413, "request_too_large", "request body too large");
      return;
    }
    let requested: unknown;
    try {
      requested = (JSON.parse(body.toString("utf8")) as { model?: unknown }).model;
    } catch {
      apiError(res, 400, "invalid_request_error", "the body is not JSON");
      return;
    }
    const model = typeof requested === "string" ? requested : "";
    if (o.prices.models[model] === undefined) {
      o.log(`${session.taskId} ${session.label}: refused model ${JSON.stringify(model)}, which the price table does not name`);
      apiError(res, 400, "invalid_request_error", `model ${JSON.stringify(model)} has no price, so it cannot be metered`);
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROP_REQUEST.has(k) || k.startsWith("x-forwarded-") || k.startsWith("proxy-")) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["x-api-key"] = key;
    headers["accept-encoding"] = "identity";
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    session.requests++;
    let up: Response;
    try {
      up = await fetch(`${upstream}${url}`, { method: "POST", headers, body, signal: abort.signal, redirect: "error" });
    } catch (e) {
      if (!abort.signal.aborted) o.log(`${session.taskId} ${session.label}: upstream unreachable: ${e instanceof Error ? e.message : String(e)}`);
      apiError(res, 502, "api_error", "the upstream is unreachable");
      return;
    }
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k)) out[k] = v;
    });
    res.writeHead(up.status, out);
    const meter = path === METERED && up.status === 200 ? new UsageMeter(up.headers.get("content-type") ?? undefined) : null;
    try {
      if (up.body !== null) {
        for await (const chunk of up.body as AsyncIterable<Uint8Array>) {
          meter?.push(chunk);
          if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => { r(); }));
        }
      }
      res.end();
    } catch {
      // The session hung up, or the upstream did: meter what passed.
      res.destroy();
    } finally {
      if (meter !== null) record(session, meter, model, up.headers.get("request-id"));
    }
  }

  function record(session: GatewaySession, meter: UsageMeter, requested: string, requestId: string | null): void {
    const m = meter.end();
    const model = m.model ?? requested;
    // A response from a model the table does not price is charged as the priciest model it does.
    const usd = priceUsage(o.prices, model, m.usage) ?? Math.max(...Object.keys(o.prices.models).map((k) => priceUsage(o.prices, k, m.usage) ?? 0));
    session.spentUsd += usd;
    const entry: UsageEntry = { session: session.id, task: session.taskId, label: session.label, model, usage: m.reported ? m.usage : { ...NO_USAGE }, usd, reported: m.reported, request_id: requestId };
    try {
      o.onUsage(entry);
    } catch (e) {
      o.log(`${session.taskId} ${session.label}: usage not recorded (${e instanceof Error ? e.message : String(e)}); token revoked`);
      const held = byId.get(session.id);
      if (held !== undefined) byToken.delete(held.digest);
    }
  }

  const servers: Server[] = [];
  const urls: string[] = [];
  for (const host of o.hosts) {
    const server = createServer((req, res) => {
      handle(req, res).catch((e: unknown) => {
        o.log(`gateway: ${e instanceof Error ? e.message : String(e)}`);
        apiError(res, 500, "api_error", "internal error");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        resolve();
      });
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    urls.push(`http://${host.includes(":") ? `[${host}]` : host}:${String(port)}`);
  }

  return {
    urls,
    issue({ taskId, label, limitUsd }) {
      const id = `gw_${randomBytes(9).toString("base64url")}`;
      const token = `sfgw_${randomBytes(32).toString("base64url")}`;
      const session: GatewaySession = { id, taskId, label, limitUsd, spentUsd: 0, requests: 0, refused: null };
      const d = digest(token);
      byToken.set(d, session);
      byId.set(id, { session, digest: d });
      return { id, token };
    },
    revoke(id) {
      const held = byId.get(id);
      if (held !== undefined) byToken.delete(held.digest);
    },
    session: (id) => byId.get(id)?.session,
    async close() {
      byToken.clear();
      await Promise.all(servers.map((s) => new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => {
          r();
        });
      })));
    },
  };
}

/** A session's token file: private, outside every directory a session may read, and removed with the session. */
export function writeTokenFile(dir: string, id: string, token: string): { path: string; remove: () => void } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.token`);
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  // A root factoryctl runs its runner as 10001 (runner/container.ts), which must read the mounted token.
  if (process.getuid?.() === 0) chownSync(path, 10001, 10001);
  return {
    path,
    remove: () => {
      rmSync(path, { force: true });
    },
  };
}

/** The task's ledger: each metered response as a usage event, written under the run's lease like every factoryctl write. */
export function ledger(store: EventStore): (e: UsageEntry) => void {
  return (e) => {
    store.append({ task_id: e.task, actor: { kind: "factoryctl", id: "gateway" }, type: "usage", payload: { session: e.session, label: e.label, model: e.model, usage: e.usage, usd: e.usd, reported: e.reported, request_id: e.request_id } });
  };
}

/** The gateway a live factoryctl run starts for its sessions: on loopback, metering to the store, refusing while halted. */
export function startRunGateway(o: { home: Home; store: EventStore; prices: Prices; keyFile: string; log: (line: string) => void }): Promise<Gateway> {
  return startGateway({
    prices: o.prices,
    keyFile: o.keyFile,
    hosts: ["127.0.0.1"],
    halted: () => {
      const h = readHalt(o.home);
      return h === null ? null : describeHalt(h);
    },
    onUsage: ledger(o.store),
    log: (line) => {
      o.log(`gateway: ${line}`);
    },
  });
}
