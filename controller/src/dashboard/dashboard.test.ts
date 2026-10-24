// The dashboard (P2-10) is a projection: a read-only store, projections of the board and the
// evidence drawer, and a loopback server that answers only GETs from its own page with its token.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { factoryHome, runDir, type Home } from "../home.ts";
import { REPO_ROOT } from "../policy/load.ts";
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
  mkdirSync(home.runs, { recursive: true });
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

describe("the dashboard server", () => {
  const TOKEN = "d".repeat(43);
  let dash: Dashboard;
  let writer: EventStore;
  let reader: EventReader;
  let port = 0;

  beforeAll(async () => {
    const s = seeded();
    writer = s.writer;
    reader = EventStore.openReadOnly(s.home.db);
    dash = await startDashboard({ home: s.home, store: reader, budgets, port: 0, token: TOKEN });
    port = Number(new URL(dash.url).port);
  });
  afterAll(async () => {
    await dash.close();
    reader.close();
    writer.close();
  });

  /** A raw request, so the test sets Host and Origin as an attacker's page would. */
  function call(o: { method?: string; path: string; host?: string; origin?: string; token?: string | null; until?: string }): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${String(port)}` };
      if (o.origin !== undefined) headers["origin"] = o.origin;
      if (o.token !== null && o.token !== undefined) headers["authorization"] = `Bearer ${o.token}`;
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
      req.end(o.method === "POST" ? "{}" : undefined);
    });
  }

  it("prints an address that carries the token in its fragment only", () => {
    expect(dash.url).toBe(`http://127.0.0.1:${String(port)}/#token=${TOKEN}`);
  });

  it("serves its page without the token, behind a CSP that allows nothing from elsewhere", async () => {
    const page = await call({ path: "/" });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect((await call({ path: "/app.js" })).status).toBe(200);
  });

  it("answers the API with the token", async () => {
    const b = await call({ path: "/api/board", token: TOKEN });
    expect(b.status).toBe(200);
    expect((JSON.parse(b.body) as { columns: unknown[] }).columns).toHaveLength(COLUMNS.length);
    const d = await call({ path: "/api/tasks/T-0001", token: TOKEN, origin: `http://localhost:${String(port)}`, host: `localhost:${String(port)}` });
    expect((JSON.parse(d.body) as { card: { title: string } }).card.title).toBe("Round <b>billing</b> amounts");
    expect((await call({ path: "/api/tasks/T-0009", token: TOKEN })).status).toBe(404);
    expect((await call({ path: "/api/tasks/T-0001;x", token: TOKEN })).status).toBe(404);
  });

  it("streams events as they are appended", async () => {
    const after = writer.cursor();
    const pending = call({ path: `/api/stream?after=${String(after)}`, token: TOKEN, until: '"type":"command"' });
    writer.append({ task_id: "T-0002", actor: { kind: "operator", id: "op" }, type: "command", payload: { command: "pause" } });
    const s = await pending;
    expect(s.headers["content-type"]).toBe("text/event-stream");
    expect(s.body).toContain(`"cursor":${String(after + 1)}`);
  });

  it("refuses a rebinding Host, a foreign Origin and a missing or wrong token", async () => {
    expect((await call({ path: "/", host: `evil.example:${String(port)}` })).status).toBe(421);
    expect((await call({ path: "/api/board", token: TOKEN, host: `evil.example:${String(port)}` })).status).toBe(421);
    expect((await call({ path: "/api/board", token: TOKEN, origin: "http://evil.example" })).status).toBe(403);
    expect((await call({ path: "/api/board" })).status).toBe(401);
    expect((await call({ path: "/api/board", token: "e".repeat(43) })).status).toBe(401);
    expect((await call({ path: "/api/stream", token: TOKEN.slice(1) })).status).toBe(401);
  });

  it("has no route that writes", async () => {
    const before = writer.allEvents().length;
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/", "/api/board", "/api/tasks/T-0001", "/v1/pause", "/v1/tasks/T-0001/cancel"]) {
        expect((await call({ method, path, token: TOKEN })).status, `${method} ${path}`).toBe(405);
      }
    }
    expect(writer.allEvents()).toHaveLength(before);
  });

  it("writes untrusted text as text, never as markup", () => {
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(APP_JS).toContain("textContent");
  });
});
