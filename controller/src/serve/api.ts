// `factoryctl serve`'s API (ROADMAP P2-03): the CLI's way in while serve is the single writer.
// It binds to loopback only, and every request must pass three checks before it is read:
//
// - Host must name the bound address (a DNS-rebinding page in a browser sends its own name);
// - Origin, when present, must be the API's own (a cross-site page cannot ride the operator's
//   browser);
// - the bearer token from $FACTORY_HOME/secrets/serve.token, compared in constant time.
//
// Writes also require a JSON content type, which a cross-site form cannot send without a
// preflight. Sessions never reach it: the runner's proxy refuses loopback, the host sandbox's
// network allowlist names registries only, and the token file is denied to every session.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export interface ApiCommand {
  command: "pause" | "resume" | "drain" | "task-pause" | "task-resume" | "cancel";
  task?: string;
  reason?: string;
}

export interface ApiOptions {
  token: string;
  /** The host:port names the API answers to. */
  hosts: readonly string[];
  status: () => unknown;
  command: (c: ApiCommand) => Promise<{ ok: boolean; message: string }>;
}

const MAX_BODY = 16 * 1024;
const TASK = /^T-[0-9]{4,}$/;
const ROUTES: Record<string, ApiCommand["command"]> = { "/v1/pause": "pause", "/v1/resume": "resume", "/v1/drain": "drain" };
const TASK_ROUTE = /^\/v1\/tasks\/(T-[0-9]{4,})\/(pause|resume|cancel)$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(`${JSON.stringify(body)}\n`);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(header ?? "");
  if (m === null) return false;
  const a = Buffer.from(m[1] ?? "");
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The reason a request is refused before it is read, or null. */
export function refusal(req: Pick<IncomingMessage, "headers" | "method">, o: Pick<ApiOptions, "token" | "hosts">): { status: number; error: string } | null {
  const host = req.headers.host ?? "";
  if (!o.hosts.includes(host)) return { status: 421, error: "unknown Host" };
  const origin = req.headers.origin;
  if (origin !== undefined && !o.hosts.some((h) => origin === `http://${h}`)) return { status: 403, error: "cross-origin request" };
  if (!tokenMatches(req.headers.authorization, o.token)) return { status: 401, error: "missing or wrong token" };
  if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) return { status: 415, error: "writes need a JSON body" };
  return null;
}

export function apiHandler(o: ApiOptions): RequestListener {
  return (req, res) => {
    const refused = refusal(req, o);
    if (refused !== null) {
      req.resume();
      send(res, refused.status, { error: refused.error });
      return;
    }
    let body = "";
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      body += c.toString("utf8");
    });
    req.on("end", () => {
      void (async () => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (req.method === "GET" && path === "/v1/status") {
          send(res, 200, o.status());
          return;
        }
        if (req.method !== "POST") {
          send(res, 404, { error: "not found" });
          return;
        }
        let parsed: { reason?: unknown };
        try {
          parsed = body === "" ? {} : (JSON.parse(body) as { reason?: unknown });
        } catch {
          send(res, 400, { error: "invalid JSON" });
          return;
        }
        const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : undefined;
        const serveWide = ROUTES[path];
        const task = TASK_ROUTE.exec(path);
        let c: ApiCommand;
        if (serveWide !== undefined) c = { command: serveWide, ...(reason === undefined ? {} : { reason }) };
        else if (task !== null && TASK.test(task[1] ?? "")) c = { command: task[2] === "cancel" ? "cancel" : task[2] === "pause" ? "task-pause" : "task-resume", task: task[1] ?? "", ...(reason === undefined ? {} : { reason }) };
        else {
          send(res, 404, { error: "not found" });
          return;
        }
        try {
          const r = await o.command(c);
          send(res, r.ok ? 200 : 409, r);
        } catch (e) {
          send(res, 500, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      })();
    });
  };
}
