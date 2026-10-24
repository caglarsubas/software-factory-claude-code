// `factoryctl dashboard` (ROADMAP P2-10, §7 E2): the board, the evidence drawer and a live stream
// of events, served to the operator's browser on loopback. It is a projection: it reads the store
// through a read-only connection and the run directories' committed files, and this server has
// no route that writes anything.
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
import type { EventReader } from "../store/events.ts";
import { APP_CSS, APP_JS, PAGE } from "./page.ts";
import { board, drawer, eventsAfter } from "./view.ts";

export const DEFAULT_DASHBOARD_PORT = 7318;
const TASK = /^\/api\/tasks\/(T-[0-9]{4,})$/;
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

export async function startDashboard(o: DashboardOptions): Promise<Dashboard> {
  const token = o.token ?? randomBytes(32).toString("base64url");
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

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    // Static assets hold no data, but still answer only to the bound address.
    if (!hosts.includes(req.headers.host ?? "")) {
      json(res, 421, { error: "unknown Host" });
      return;
    }
    if (req.method !== "GET") {
      req.resume();
      json(res, 405, { error: "the dashboard reads only" });
      return;
    }
    const asset = ASSETS[path];
    if (asset !== undefined) {
      send(res, 200, asset.type, asset.body);
      return;
    }
    const refused = refusal(req, { token, hosts });
    if (refused !== null) {
      json(res, refused.status, { error: refused.error });
      return;
    }
    try {
      const task = TASK.exec(path);
      if (path === "/api/board") json(res, 200, board(o.home, o.store));
      else if (task !== null) {
        const d = drawer(o.home, o.store, o.budgets, task[1] ?? "");
        if (d === null) json(res, 404, { error: "no such task" });
        else json(res, 200, d);
      } else if (path === "/api/stream") {
        const after = Number(new URL(req.url ?? "/", "http://x").searchParams.get("after") ?? "0");
        stream(req, res, Number.isInteger(after) && after >= 0 ? after : 0);
      } else json(res, 404, { error: "not found" });
    } catch (e) {
      o.log?.(`dashboard: ${e instanceof Error ? e.message : String(e)}`);
      json(res, 500, { error: "internal error" });
    }
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
