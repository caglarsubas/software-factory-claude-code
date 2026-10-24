// `factoryctl dashboard` (ROADMAP P2-10, §7 E2): the board, the evidence drawer and a live stream
// of events, served to the operator's browser on loopback. It is a projection: it reads the store
// through a read-only connection and the run directories' committed files. Its commands are
// `serve`'s: each POST goes to serve's API, which validates it and is the one that writes. With
// no serve running, a command is refused. The only file it writes is its drawer-open log.
//
// Exposure is the API's (serve/api.ts): loopback only; every data request must name the bound
// address in Host (DNS rebinding), carry no foreign Origin, and present the bearer token. The
// token is new for each launch and reaches the page in the URL's fragment, which a browser never
// sends. The page itself holds no data and loads nothing from elsewhere (its CSP says so), and it
// writes untrusted text (task titles, findings) as text, never as markup.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Home } from "../home.ts";
import type { BudgetsPolicy } from "../release.ts";
import { refusal } from "../serve/api.ts";
import { callServe, type ServeReply } from "../serve/client.ts";
import { liveServe } from "../serve/serve.ts";
import type { EventReader } from "../store/events.ts";
import { isPriority } from "../task/lifecycle.ts";
import { logDrawerOpen } from "./opens.ts";
import { APP_CSS, APP_JS, PAGE } from "./page.ts";
import { board, drawer, eventsAfter } from "./view.ts";

export const DEFAULT_DASHBOARD_PORT = 7318;
const TASK = /^\/api\/tasks\/(T-[0-9]{4,})$/;
/** The commands, each the serve API route it goes to. */
const SERVE_COMMAND = /^\/api\/serve\/(pause|resume|drain)$/;
const TASK_COMMAND = /^\/api\/tasks\/(T-[0-9]{4,})\/(pause|resume|cancel|priority)$/;
const MAX_BODY = 4096;
/** The page and its assets: no data, so no token, but the Host check still applies. */
const ASSETS: Readonly<Record<string, { type: string; body: string } | undefined>> = {
  "/": { type: "text/html; charset=utf-8", body: PAGE },
  "/app.js": { type: "text/javascript; charset=utf-8", body: APP_JS },
  "/app.css": { type: "text/css; charset=utf-8", body: APP_CSS },
};
const POLL_MS = 1000;
const HEARTBEAT_MS = 15_000;

export interface DashboardOptions {
  home: Home;
  store: EventReader;
  budgets: Pick<BudgetsPolicy, "task_usd" | "calibration">;
  /** 0 picks a free port. */
  port: number;
  /** The launch's token; a fresh random one by default. */
  token?: string;
  log?: (line: string) => void;
  /** serve's API; null while no serve runs. The default finds serve by its lock and uses its token. */
  serve?: (method: "GET" | "POST", path: string, body?: Record<string, unknown>) => Promise<ServeReply | null>;
}

export interface Dashboard {
  server: Server;
  /** The page's address with the token in its fragment: what the operator opens. */
  url: string;
  token: string;
  close: () => Promise<void>;
}

const SECURITY = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, ...SECURITY });
  res.end(body);
}
const json = (res: ServerResponse, status: number, body: unknown): void => {
  send(res, status, "application/json", `${JSON.stringify(body)}\n`);
};

/** A refusal before the body is read: the connection closes, so no unread body reaches the next request on it. */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  req.resume();
  res.setHeader("connection", "close");
  json(res, status, { error });
}

/** A command's JSON body, cut to what serve takes: a reason, and a priority for that command. */
function readCommand(req: IncomingMessage): Promise<{ body: Record<string, unknown> } | { error: string }> {
  return new Promise((resolve) => {
    let raw = "";
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve({ error: "the body is too large" });
        return;
      }
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      let parsed: unknown;
      try {
        parsed = raw === "" ? {} : JSON.parse(raw);
      } catch {
        resolve({ error: "invalid JSON" });
        return;
      }
      const p = (parsed !== null && typeof parsed === "object" ? parsed : {}) as { reason?: unknown; priority?: unknown };
      const reason = typeof p.reason === "string" && p.reason.trim() !== "" ? { reason: p.reason.trim().slice(0, 500) } : {};
      resolve({ body: { ...reason, ...(p.priority === undefined ? {} : { priority: p.priority }) } });
    });
  });
}

const NOT_SERVING = "serve is not running: commands go through it (factoryctl serve); until then, use the CLI";

export async function startDashboard(o: DashboardOptions): Promise<Dashboard> {
  const token = o.token ?? randomBytes(32).toString("base64url");
  const serve = o.serve ?? (async (method, path, body) => {
    const lock = liveServe(o.home);
    return lock === null ? null : callServe(o.home, lock, method, path, body);
  });
  const streams = new Set<ServerResponse>();
  let hosts: string[] = [];

  const stream = (req: IncomingMessage, res: ServerResponse, after: number): void => {
    res.writeHead(200, { "content-type": "text/event-stream", ...SECURITY, connection: "keep-alive" });
    streams.add(res);
    let last = after;
    const tick = (): void => {
      for (const e of eventsAfter(o.store, last)) {
        last = e.cursor;
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      }
    };
    tick();
    const poll = setInterval(tick, POLL_MS);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(poll);
      clearInterval(beat);
      streams.delete(res);
    });
  };

  /** A command: checked here for shape only, then sent to serve, whose answer is the dashboard's. */
  async function command(req: IncomingMessage, res: ServerResponse, route: string, priority: boolean): Promise<void> {
    const read = await readCommand(req);
    if ("error" in read) {
      refuse(req, res, 400, read.error);
      return;
    }
    if (priority !== isPriority(read.body["priority"])) {
      json(res, 400, { error: priority ? "priority is low, normal or high" : "only a priority command takes a priority" });
      return;
    }
    const r = await serve("POST", route, read.body);
    if (r === null) json(res, 409, { error: NOT_SERVING });
    else json(res, r.status, r.body);
  }

  async function serveStatus(res: ServerResponse): Promise<void> {
    const r = await serve("GET", "/v1/status");
    const raw: unknown = r?.status === 200 ? r.body["serve"] : null;
    if (raw === null || typeof raw !== "object") {
      json(res, 200, { running: false });
      return;
    }
    const s = raw as { paused?: unknown; draining?: unknown; halted?: unknown; max_tasks?: unknown; workers?: unknown };
    json(res, 200, { running: true, paused: s.paused === true, draining: s.draining === true, halted: s.halted === true, maxTasks: typeof s.max_tasks === "number" ? s.max_tasks : null, workers: Array.isArray(s.workers) ? s.workers.length : 0 });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    // Static assets hold no data, but still answer only to the bound address.
    if (!hosts.includes(req.headers.host ?? "")) {
      refuse(req, res, 421, "unknown Host");
      return;
    }
    const serveCommand = SERVE_COMMAND.exec(path);
    const taskCommand = TASK_COMMAND.exec(path);
    const isCommand = serveCommand !== null || taskCommand !== null;
    if (req.method !== "GET" && !(req.method === "POST" && isCommand)) {
      refuse(req, res, 405, isCommand ? "a command is a POST" : "the dashboard reads only; its commands are POSTs to /api/serve/… and /api/tasks/T-…/…");
      return;
    }
    const asset = req.method === "GET" ? ASSETS[path] : undefined;
    if (asset !== undefined) {
      send(res, 200, asset.type, asset.body);
      return;
    }
    // The token, the Host and Origin, and for a command a JSON body: a cross-site page can send none of them.
    const refused = refusal(req, { token, hosts });
    if (refused !== null) {
      refuse(req, res, refused.status, refused.error);
      return;
    }
    if (serveCommand !== null) {
      await command(req, res, `/v1/${serveCommand[1] ?? ""}`, false);
      return;
    }
    if (taskCommand !== null) {
      await command(req, res, `/v1/tasks/${taskCommand[1] ?? ""}/${taskCommand[2] ?? ""}`, taskCommand[2] === "priority");
      return;
    }
    const task = TASK.exec(path);
    if (path === "/api/board") json(res, 200, board(o.home, o.store));
    else if (path === "/api/serve") await serveStatus(res);
    else if (task !== null) {
      const d = drawer(o.home, o.store, o.budgets, task[1] ?? "");
      if (d === null) json(res, 404, { error: "no such task" });
      else {
        // The page asks with ?open=1 when the operator opens the drawer, not when it refreshes (§6 approval fatigue).
        if (url.searchParams.get("open") === "1") logDrawerOpen(o.home, { at: new Date().toISOString(), task: d.card.id, state: d.card.state, gate: d.card.gate });
        json(res, 200, d);
      }
    } else if (path === "/api/stream") {
      const after = Number(url.searchParams.get("after") ?? "0");
      stream(req, res, Number.isInteger(after) && after >= 0 ? after : 0);
    } else json(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      o.log?.(`dashboard: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  hosts = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
  return {
    server,
    url: `http://127.0.0.1:${String(port)}/#token=${token}`,
    token,
    close: () =>
      new Promise((resolve) => {
        for (const s of streams) s.end();
        server.close(() => {
          resolve();
        });
      }),
  };
}
