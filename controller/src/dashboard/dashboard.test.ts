// The dashboard (P2-10) is a projection: a read-only store, projections of the board and the
// evidence drawer, and a loopback server that answers only GETs from its own page with its token.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureHome, factoryHome, runDir, type Home } from "../home.ts";
import { REPO_ROOT } from "../policy/load.ts";
import type { ServeReply } from "../serve/client.ts";
import { startServe } from "../serve/serve.ts";
import { currentState } from "../task/lifecycle.ts";
import { drawerOpenCounts, opensPath, readDrawerOpens } from "./opens.ts";
import { EventStore, type EventReader } from "../store/events.ts";
import { APP_JS } from "./page.ts";
import { startDashboard, type Dashboard } from "./server.ts";
import { board, COLUMNS, drawer, eventsAfter } from "./view.ts";

const root = mkdtempSync(join(tmpdir(), "dashboard-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const op = { kind: "factoryctl" as const, id: "factoryctl" };
const budgets = { task_usd: { R0: 3, R1: 12, R2: 30, R3: 60, Restricted: 60 }, calibration: { multiplier: 1.5, min_runs_per_tier: 20 } };
const BASE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);

function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`);
}

/** A home with two tasks: one waiting at the merge gate with its evidence, one just received. */
function seeded(): { home: Home; writer: EventStore } {
  const home = factoryHome({ FACTORY_HOME: mkdtempSync(join(root, "home-")) });
  ensureHome(home);
  let clock = Date.parse("2026-10-24T09:00:00Z");
  const writer = EventStore.open(home.db, { now: () => new Date((clock += 1000)) });
  const task = (id: string, title: string) => {
    writeJson(runDir(home, id), "task.json", { schema_version: 1, id, created_at: "2026-10-24T09:00:00Z", target: { repo: "example/ts-mini", profile: "/p.yaml" }, source: { kind: "manual", admitted_by: "op" }, text_trust: "untrusted", title, priority: "normal" });
    writer.append({ task_id: id, actor: { kind: "operator", id: "op" }, type: "task_created", payload: {} });
  };
  task("T-0001", "Round <b>billing</b> amounts");
  const dir = runDir(home, "T-0001");
  writeFileSync(join(dir, "spec.yaml"), "objective: Round billing amounts half-even\nacceptance_criteria:\n  - id: AC-1\n    statement: Amounts round half-even\n");
  writeJson(dir, "checkout.json", { base_commit: BASE });
  writeJson(dir, "build.json", { candidate_commit: CANDIDATE });
  writeJson(dir, "gates.json", { gates: [{ name: "tests", status: "pass", summary: "12 passed" }] });
  writeJson(dir, "review-code.json", { findings: [{ id: "F-1", severity: "minor", title: "Name the constant", file: "src/billing.ts" }] });
  writeJson(dir, "verdict.json", { decision: "approve", confidence: 0.9, rationale: "Every criterion has a passing test." });
  writeJson(dir, "policy.json", { tier: "R2", trace: [
    { source: "baseline", matched: true, shadow: false, tierAfter: "R1" },
    { source: "rule", note: "billing paths", matched: true, shadow: false, tierAfter: "R2" },
    { source: "rule", note: "graph within 2 hops", matched: true, shadow: true, tierAfter: "R3" },
  ] });
  for (const [label, cost, cap] of [["spec", 0.4, 1.8], ["build", 2.1, 6]] as const) {
    writer.append({ task_id: "T-0001", actor: op, type: "stage_started", payload: { stage: label, label, runner: "sdk", env_keys: [], cap_usd: cap, round: 1 } });
    writer.append({ task_id: "T-0001", actor: op, type: "stage_completed", payload: { stage: label, label, ok: true, cost_usd: cost, round: 1, models: ["claude-opus-5-5"] } });
  }
  let from = "RECEIVED";
  for (const to of ["TRIAGED", "SPECIFIED", "BUILDING", "VERIFYING", "REVIEWING", "POLICY", "NEEDS_HUMAN"] as const) {
    writer.append({ task_id: "T-0001", actor: op, type: "state_changed", from: from as "RECEIVED", to, payload: to === "NEEDS_HUMAN" ? { gate: "merge", tier: "R2" } : {} });
    from = to;
  }
  writer.append({ task_id: "T-0001", actor: { kind: "operator", id: "op" }, type: "command", payload: { command: "approve", gate: "spec", reason: "scope is right" } });
  task("T-0002", "Add a page");
  return { home, writer };
}

describe("the read-only store", () => {
  it("reads what a live writer appends, and refuses every write", () => {
    const { home, writer } = seeded();
    const reader = EventStore.openReadOnly(home.db);
    expect(reader.taskIds()).toEqual(["T-0001", "T-0002"]);
    writer.append({ task_id: "T-0002", actor: op, type: "state_changed", from: "RECEIVED", to: "TRIAGED", payload: {} });
    expect(reader.events("T-0002").at(-1)?.to).toBe("TRIAGED");
    // The type has no write method; at run time SQLite refuses one all the same.
    const forced = reader as unknown as EventStore;
    expect(() => forced.append({ task_id: "T-0002", actor: op, type: "command", payload: { command: "pause" } })).toThrow(/readonly/);
    expect(reader.events("T-0002")).toHaveLength(2);
    reader.close();
    writer.close();
  });

  it("refuses a store this factoryctl did not migrate, rather than migrating it", () => {
    expect(() => EventStore.openReadOnly(join(root, "nothing.db"))).toThrow();
  });
});

describe("the projections", () => {
  it("puts every task in its column, and every durable state has one", () => {
    const states = COLUMNS.flatMap((c) => c.states);
    const defs = JSON.parse(readFileSync(join(REPO_ROOT, "schemas/defs.schema.json"), "utf8")) as { $defs: { state: { enum: string[] } } };
    expect([...states].sort()).toEqual([...defs.$defs.state.enum].sort());
    const { home, writer } = seeded();
    const b = board(home, writer);
    expect(b.columns.map((c) => c.name)).toEqual(COLUMNS.map((c) => c.name));
    const needs = b.columns.find((c) => c.name === "Needs human")?.cards ?? [];
    expect(needs.map((c) => [c.id, c.gate, c.tier, c.costUsd])).toEqual([["T-0001", "merge", "R2", 2.5]]);
    expect(b.columns.find((c) => c.name === "Received")?.cards.map((c) => c.id)).toEqual(["T-0002"]);
    // Positions are store-wide: each task's seq starts at 1.
    expect(b.cursor).toBe(writer.allEvents().length);
    writer.close();
  });

  it("gathers the evidence an operator weighs before deciding", () => {
    const { home, writer } = seeded();
    const d = drawer(home, writer, budgets, "T-0001");
    expect(d?.spec).toEqual({ objective: "Round billing amounts half-even", acceptance: [{ id: "AC-1", statement: "Amounts round half-even" }] });
    // The rules that set the tier, without the baseline or a shadow rule.
    expect(d?.tier).toEqual({ tier: "R2", rules: ["billing paths → R2"] });
    expect(d?.commits).toEqual({ base: BASE, candidate: CANDIDATE });
    expect(d?.stages.map((s) => [s.label, s.model, s.costUsd, s.capUsd])).toEqual([["spec", "claude-opus-5-5", 0.4, 1.8], ["build", "claude-opus-5-5", 2.1, 6]]);
    expect(d?.budget).toEqual({ tier: "R2", usd: 30, spentUsd: 2.5 });
    expect(d?.gates).toEqual([{ name: "tests", status: "pass", summary: "12 passed" }]);
    expect(d?.findings).toEqual([{ reviewer: "review-code", id: "F-1", severity: "minor", title: "Name the constant", file: "src/billing.ts" }]);
    expect(d?.verdict).toEqual({ decision: "approve", confidence: 0.9, rationale: "Every criterion has a passing test." });
    expect(d?.decisions.map((x) => [x.by, x.what])).toEqual([["op", "approve (spec gate): scope is right"]]);
    expect(d?.timeline.at(-1)).toMatchObject({ type: "command", summary: "approve" });
    expect(drawer(home, writer, budgets, "T-0009")).toBeNull();
    writer.close();
  });

  it("streams events after a store-wide position, oldest first, across tasks", () => {
    const { writer } = seeded();
    const all = writer.cursor();
    expect(eventsAfter(writer, all - 2).map((e) => [e.cursor, e.task, e.seq])).toEqual([[all - 1, "T-0001", writer.events("T-0001").length], [all, "T-0002", 1]]);
    expect(eventsAfter(writer, 0, 3)).toHaveLength(3);
    writer.close();
  });
});

/** A raw request, so the test sets Host, Origin and the body as an attacker's page would. */
function call(port: number, o: { method?: string; path: string; host?: string; origin?: string; token?: string | null; type?: string; body?: string; until?: string }): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${String(port)}` };
    if (o.origin !== undefined) headers["origin"] = o.origin;
    if (o.token !== null && o.token !== undefined) headers["authorization"] = `Bearer ${o.token}`;
    if (o.type !== undefined) headers["content-type"] = o.type;
    const req = request({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path, headers }, (res) => {
      let body = "";
      const done = () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      };
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
        if (o.until !== undefined && body.includes(o.until)) {
          req.destroy();
          done();
        }
      });
      res.on("end", done);
    });
    req.on("error", (e) => {
      if (o.until === undefined) reject(e);
    });
    req.end(o.body ?? (o.method === undefined || o.method === "GET" ? undefined : "{}"));
  });
}

describe("the dashboard server", () => {
  const TOKEN = "d".repeat(43);
  let dash: Dashboard;
  let home: Home;
  let writer: EventStore;
  let reader: EventReader;
  let port = 0;
  /** What serve heard, and how the stub answers: null while no serve runs. */
  const heard: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  let answer: (path: string) => ServeReply | null = () => ({ status: 200, body: { ok: true, message: "done" } });

  beforeAll(async () => {
    const s = seeded();
    home = s.home;
    writer = s.writer;
    reader = EventStore.openReadOnly(s.home.db);
    dash = await startDashboard({
      home: s.home, store: reader, budgets, port: 0, token: TOKEN,
      serve: (method, path, body) => {
        heard.push({ method, path, body });
        return Promise.resolve(answer(path));
      },
    });
    port = Number(new URL(dash.url).port);
  });
  afterAll(async () => {
    await dash.close();
    reader.close();
    writer.close();
  });

  it("prints an address that carries the token in its fragment only", () => {
    expect(dash.url).toBe(`http://127.0.0.1:${String(port)}/#token=${TOKEN}`);
  });

  it("serves its page without the token, behind a CSP that allows nothing from elsewhere", async () => {
    const page = await call(port, { path: "/" });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect((await call(port, { path: "/app.js" })).status).toBe(200);
  });

  it("answers the API with the token", async () => {
    const b = await call(port, { path: "/api/board", token: TOKEN });
    expect(b.status).toBe(200);
    expect((JSON.parse(b.body) as { columns: unknown[] }).columns).toHaveLength(COLUMNS.length);
    const d = await call(port, { path: "/api/tasks/T-0001", token: TOKEN, origin: `http://localhost:${String(port)}`, host: `localhost:${String(port)}` });
    expect((JSON.parse(d.body) as { card: { title: string } }).card.title).toBe("Round <b>billing</b> amounts");
    expect((await call(port, { path: "/api/tasks/T-0009", token: TOKEN })).status).toBe(404);
    expect((await call(port, { path: "/api/tasks/T-0001;x", token: TOKEN })).status).toBe(404);
  });

  it("streams events as they are appended", async () => {
    const after = writer.cursor();
    const pending = call(port, { path: `/api/stream?after=${String(after)}`, token: TOKEN, until: '"type":"command"' });
    writer.append({ task_id: "T-0002", actor: { kind: "operator", id: "op" }, type: "command", payload: { command: "pause" } });
    const s = await pending;
    expect(s.headers["content-type"]).toBe("text/event-stream");
    expect(s.body).toContain(`"cursor":${String(after + 1)}`);
  });

  it("refuses a rebinding Host, a foreign Origin and a missing or wrong token", async () => {
    expect((await call(port, { path: "/", host: `evil.example:${String(port)}` })).status).toBe(421);
    expect((await call(port, { path: "/api/board", token: TOKEN, host: `evil.example:${String(port)}` })).status).toBe(421);
    expect((await call(port, { path: "/api/board", token: TOKEN, origin: "http://evil.example" })).status).toBe(403);
    expect((await call(port, { path: "/api/board" })).status).toBe(401);
    expect((await call(port, { path: "/api/board", token: "e".repeat(43) })).status).toBe(401);
    expect((await call(port, { path: "/api/stream", token: TOKEN.slice(1) })).status).toBe(401);
  });

  it("writes nothing itself: anything but a read or a command is refused, and a command goes to serve", async () => {
    const before = writer.allEvents().length;
    heard.length = 0;
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      for (const path of ["/", "/api/board", "/api/tasks/T-0001", "/api/serve/pause", "/api/tasks/T-0001/cancel"]) {
        expect((await call(port, { method, path, token: TOKEN, type: "application/json" })).status, `${method} ${path}`).toBe(405);
      }
    }
    for (const path of ["/", "/api/board", "/api/tasks/T-0001", "/v1/pause", "/v1/tasks/T-0001/cancel", "/api/tasks/T-0001/approve", "/api/tasks/T-0001/reject"]) {
      expect((await call(port, { method: "POST", path, token: TOKEN, type: "application/json" })).status, `POST ${path}`).toBe(405);
    }
    expect(heard).toEqual([]);
    expect(writer.allEvents()).toHaveLength(before);
  });

  it("passes each command to serve's own route, with only a reason and a priority", async () => {
    heard.length = 0;
    const post = (path: string, body: unknown) => call(port, { method: "POST", path, token: TOKEN, type: "application/json", body: JSON.stringify(body) });
    expect((await post("/api/serve/pause", { reason: "  lunch  ", extra: "dropped" })).status).toBe(200);
    expect((await post("/api/serve/drain", {})).status).toBe(200);
    expect((await post("/api/tasks/T-0001/pause", { reason: "x".repeat(600) })).status).toBe(200);
    expect((await post("/api/tasks/T-0001/priority", { priority: "high", reason: "release" })).status).toBe(200);
    expect((await post("/api/tasks/T-0002/cancel", { task: "T-0001" })).status).toBe(200);
    expect(heard).toEqual([
      { method: "POST", path: "/v1/pause", body: { reason: "lunch" } },
      { method: "POST", path: "/v1/drain", body: {} },
      { method: "POST", path: "/v1/tasks/T-0001/pause", body: { reason: "x".repeat(500) } },
      { method: "POST", path: "/v1/tasks/T-0001/priority", body: { priority: "high", reason: "release" } },
      { method: "POST", path: "/v1/tasks/T-0002/cancel", body: {} },
    ]);
  });

  it("refuses a command without the token, from another site, as a form, or malformed, before serve hears of it", async () => {
    heard.length = 0;
    const path = "/api/tasks/T-0001/cancel";
    expect((await call(port, { method: "POST", path, type: "application/json" })).status).toBe(401);
    expect((await call(port, { method: "POST", path, token: TOKEN, type: "application/json", origin: "http://evil.example" })).status).toBe(403);
    expect((await call(port, { method: "POST", path, token: TOKEN, type: "application/json", host: `evil.example:${String(port)}` })).status).toBe(421);
    expect((await call(port, { method: "POST", path, token: TOKEN, type: "application/x-www-form-urlencoded", body: "reason=x" })).status).toBe(415);
    expect((await call(port, { method: "POST", path, token: TOKEN, type: "text/plain", body: "{}" })).status).toBe(415);
    expect((await call(port, { method: "POST", path, token: TOKEN, type: "application/json", body: "{" })).status).toBe(400);
    expect((await call(port, { method: "POST", path, token: TOKEN, type: "application/json", body: JSON.stringify({ reason: "x".repeat(5000) }) })).status).toBe(400);
    expect((await call(port, { method: "POST", path: "/api/tasks/T-0001/priority", token: TOKEN, type: "application/json", body: '{"priority":"urgent"}' })).status).toBe(400);
    expect((await call(port, { method: "POST", path: "/api/tasks/T-0001/priority", token: TOKEN, type: "application/json", body: "{}" })).status).toBe(400);
    expect((await call(port, { method: "POST", path: "/api/tasks/T-0001/pause", token: TOKEN, type: "application/json", body: '{"priority":"high"}' })).status).toBe(400);
    expect(heard).toEqual([]);
  });

  it("shows serve's answer, and refuses commands while no serve runs", async () => {
    answer = () => ({ status: 409, body: { ok: false, message: "T-0001 has already ended" } });
    const ended = await call(port, { method: "POST", path: "/api/tasks/T-0001/pause", token: TOKEN, type: "application/json" });
    expect([ended.status, (JSON.parse(ended.body) as { message: string }).message]).toEqual([409, "T-0001 has already ended"]);
    answer = () => null;
    const none = await call(port, { method: "POST", path: "/api/serve/resume", token: TOKEN, type: "application/json" });
    expect(none.status).toBe(409);
    expect(none.body).toContain("serve is not running");
    expect(JSON.parse((await call(port, { path: "/api/serve", token: TOKEN })).body)).toEqual({ running: false });
    answer = (path) => (path === "/v1/status" ? { status: 200, body: { serve: { pid: 1, paused: true, draining: false, halted: false, max_tasks: 2, workers: [{ task: "T-0001", pid: 2 }] } } } : null);
    expect(JSON.parse((await call(port, { path: "/api/serve", token: TOKEN })).body)).toEqual({ running: true, paused: true, draining: false, halted: false, maxTasks: 2, workers: 1 });
    answer = () => ({ status: 200, body: { ok: true, message: "done" } });
  });

  it("logs the operator opening a drawer, not the page refreshing it", async () => {
    rmSync(opensPath(home), { force: true });
    await call(port, { path: "/api/tasks/T-0001", token: TOKEN });
    expect(existsSync(opensPath(home))).toBe(false);
    await call(port, { path: "/api/tasks/T-0001?open=1", token: TOKEN });
    await call(port, { path: "/api/tasks/T-0002?open=1", token: TOKEN });
    await call(port, { path: "/api/tasks/T-0009?open=1", token: TOKEN });
    const opens = readDrawerOpens(home);
    expect(opens.map((o) => [o.task, o.state, o.gate])).toEqual([["T-0001", "NEEDS_HUMAN", "merge"], ["T-0002", "RECEIVED", null]]);
    writeFileSync(opensPath(home), `${readFileSync(opensPath(home), "utf8")}{"at":\n`);
    expect(readDrawerOpens(home)).toHaveLength(2);
    const day = 24 * 3600 * 1000;
    expect(drawerOpenCounts(opens, new Date(Date.now() - day), new Date(Date.now() + day))).toEqual({ opens: 2, atGate: 1, tasks: 2 });
    expect(drawerOpenCounts(opens, new Date(Date.now() + day), new Date(Date.now() + 2 * day)).opens).toBe(0);
  });

  it("writes untrusted text as text, never as markup, and confirms a cancel", () => {
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(APP_JS).toContain("textContent");
    expect(APP_JS).toMatch(/confirm\("Cancel /);
  });
});

async function freePort(): Promise<number> {
  const s = createNetServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => s.once("listening", resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

describe("the dashboard's commands through a running serve", () => {
  it("changes a priority, pauses and cancels through serve, which writes; the dashboard does not", async () => {
    const { home, writer } = seeded();
    // Both tasks paused, so serve starts no worker: the test drives only its API.
    for (const id of ["T-0001", "T-0002"]) writer.append({ task_id: id, actor: { kind: "operator", id: "op" }, type: "command", payload: { command: "pause", reason: "test" } });
    const cli = join(root, "no-worker.ts");
    writeFileSync(cli, "process.exit(1);\n");
    const servePort = await freePort();
    const s = await startServe({ home, store: writer, cli, maxTasks: 1, host: "127.0.0.1", port: servePort, log: () => undefined });
    const reader = EventStore.openReadOnly(home.db);
    const TOKEN = "e".repeat(43);
    const dash = await startDashboard({ home, store: reader, budgets, port: 0, token: TOKEN });
    const port = Number(new URL(dash.url).port);
    const post = (path: string, body: unknown) => call(port, { method: "POST", path, token: TOKEN, type: "application/json", body: JSON.stringify(body) });
    try {
      expect(JSON.parse((await call(port, { path: "/api/serve", token: TOKEN })).body)).toMatchObject({ running: true, paused: false });
      const before = writer.allEvents().length;
      const p = await post("/api/tasks/T-0001/priority", { priority: "high", reason: "the release needs it" });
      expect([p.status, (JSON.parse(p.body) as { message: string }).message]).toEqual([200, "T-0001: priority normal → high"]);
      expect(writer.events("T-0001").at(-1)).toMatchObject({ type: "command", actor: { kind: "operator" }, payload: { command: "priority", priority: "high", from: "normal", reason: "the release needs it" } });
      expect(board(home, reader).columns.flatMap((c) => c.cards).find((c) => c.id === "T-0001")?.priority).toBe("high");
      expect(drawer(home, reader, budgets, "T-0001")?.decisions.at(-1)?.what).toBe("priority normal → high: the release needs it");
      const paused = await post("/api/tasks/T-0001/pause", {});
      expect([paused.status, (JSON.parse(paused.body) as { message: string }).message]).toEqual([200, "T-0001 is already paused"]);
      expect((await post("/api/tasks/T-0002/cancel", { reason: "duplicate" })).status).toBe(200);
      expect(currentState(writer.events("T-0002"))).toBe("CANCELLED");
      const cancelled = await post("/api/tasks/T-0002/pause", {});
      expect([cancelled.status, (JSON.parse(cancelled.body) as { message: string }).message]).toEqual([409, "T-0002 has already ended"]);
      expect((await post("/api/serve/pause", {})).status).toBe(200);
      expect(JSON.parse((await call(port, { path: "/api/serve", token: TOKEN })).body)).toMatchObject({ running: true, paused: true });
      // Every write came from serve: the dashboard's own connection could make none.
      expect(writer.allEvents().length).toBeGreaterThan(before);
    } finally {
      await dash.close();
      s.stop();
      await s.done;
      reader.close();
      writer.close();
    }
    // With serve gone, a command is refused rather than written another way.
    const reader2 = EventStore.openReadOnly(home.db);
    const dash2 = await startDashboard({ home, store: reader2, budgets, port: 0, token: TOKEN });
    try {
      const r = await call(Number(new URL(dash2.url).port), { method: "POST", path: "/api/tasks/T-0001/resume", token: TOKEN, type: "application/json" });
      expect(r.status).toBe(409);
    } finally {
      await dash2.close();
      reader2.close();
    }
  });
});
