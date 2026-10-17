// The credential and budget gateway (P2-02): a session's token, never the key, reaches the
// gateway; the key, never the token, reaches the upstream; every response is metered from its
// usage and priced by the pinned table; a session past its limit, a halted factory and a revoked
// token are refused before anything goes upstream.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { stubHandler, type Script } from "../session/stub-model.ts";
import { startGateway, writeTokenFile, type Gateway, type UsageEntry } from "./gateway.ts";
import { priceUsage, UsageMeter, NO_USAGE } from "./meter.ts";

const KEY = "sk-ant-test-real-key";
const release = loadRelease(createValidator());
const prices = release.config.prices;
const scratch = mkdtempSync(join(tmpdir(), "gateway-"));
const keyFile = join(scratch, "anthropic.key");
writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });

const script: Script = {
  cheap: [{ text: "hello" }],
  // 100k input and 10k output on Opus 5.5: $0.40 + $0.20 per request.
  dear: [{ tool: "Bash", input: { command: "true" }, usage: { input_tokens: 100_000, output_tokens: 10_000 } }, { tool: "Bash", input: { command: "true" }, usage: { input_tokens: 100_000, output_tokens: 10_000 } }, { text: "done", usage: { input_tokens: 100_000, output_tokens: 10_000 } }],
};
const upstreamSeen: { path: string; headers: IncomingHttpHeaders }[] = [];
let upstream: Server;
let gw: Gateway;
const usage: UsageEntry[] = [];
const logs: string[] = [];
let halted: string | null = null;

beforeAll(async () => {
  const stub = stubHandler(() => script, () => undefined);
  upstream = createServer((req, res) => {
    upstreamSeen.push({ path: req.url ?? "", headers: req.headers });
    stub(req, res);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => upstream.once("listening", r));
  gw = await startGateway({
    prices, keyFile, upstream: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`, hosts: ["127.0.0.1"],
    halted: () => halted, onUsage: (e) => usage.push(e), log: (l) => logs.push(l),
  });
});

afterAll(async () => {
  await gw.close();
  upstream.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** One Messages API turn, as the CLI sends it: the case in the prompt, the conversation so far as assistant turns. */
async function turn(token: string | null, o: { case?: string; turns?: number; stream?: boolean; model?: string; path?: string } = {}): Promise<{ status: number; body: string }> {
  const messages: unknown[] = [{ role: "user", content: `[case:${o.case ?? "cheap"}] go` }];
  for (let i = 0; i < (o.turns ?? 0); i++) messages.push({ role: "assistant", content: "x" }, { role: "user", content: "ok" });
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta" };
  if (token !== null) headers["x-api-key"] = token;
  const r = await fetch(`${gw.urls[0] ?? ""}${o.path ?? "/v1/messages?beta=true"}`, {
    method: "POST", headers,
    body: JSON.stringify({ model: o.model ?? "claude-opus-5-5", stream: o.stream ?? true, max_tokens: 1000, tools: [{ name: "Bash" }], messages }),
  });
  return { status: r.status, body: await r.text() };
}

describe("metering", () => {
  it("prices usage by the pinned table: input, output, cache reads and writes, and Haiku's long-prompt rate", () => {
    const u = { ...NO_USAGE, input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(priceUsage(prices, "claude-opus-5-5", u)).toBeCloseTo(24);
    expect(priceUsage(prices, "claude-sonnet-5-5", { ...NO_USAGE, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2);
    expect(priceUsage(prices, "claude-opus-5-5", { ...NO_USAGE, cache_creation_input_tokens: 1_000_000, cache_creation_5m_input_tokens: 1_000_000 })).toBeCloseTo(5);
    // A write the API does not split by TTL is priced at the 1-hour rate, the higher one.
    expect(priceUsage(prices, "claude-opus-5-5", { ...NO_USAGE, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(8);
    expect(priceUsage(prices, "claude-haiku-5-5", { ...NO_USAGE, input_tokens: 100_000, output_tokens: 1_000 })).toBeCloseTo(0.0105);
    expect(priceUsage(prices, "claude-haiku-5-5", { ...NO_USAGE, input_tokens: 100_001, output_tokens: 1_000 })).toBeCloseTo(0.0525, 4);
    expect(priceUsage(prices, "claude-unpriced-9", u)).toBeNull();
  });

  it("prices every model a stage may run on", () => {
    for (const alias of Object.values(release.config.routing).flatMap((r) => [r.model, ...(r.escalate_to === undefined ? [] : [r.escalate_to])])) {
      const id = release.config.model_pins[alias] ?? "";
      expect(prices.models[id], id).toBeDefined();
    }
  });

  it("reads usage from a stream split anywhere, and from a JSON message", () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { type: "message", model: "claude-sonnet-5-5", usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 } } } })}\n\n`,
      `event: ping\ndata: {"type":"ping"}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 40 } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}\r\n\r\n`,
    ].join("");
    const m = new UsageMeter("text/event-stream; charset=utf-8");
    const bytes = new TextEncoder().encode(sse);
    for (let i = 0; i < bytes.length; i += 13) m.push(bytes.slice(i, i + 13));
    expect(m.end()).toEqual({ model: "claude-sonnet-5-5", reported: true, usage: { ...NO_USAGE, input_tokens: 7, output_tokens: 42, cache_read_input_tokens: 3, cache_creation_5m_input_tokens: 2 } });
    const j = new UsageMeter("application/json");
    j.push(new TextEncoder().encode(JSON.stringify({ type: "message", model: "claude-haiku-5-5", usage: { input_tokens: 5, output_tokens: 6 } })));
    expect(j.end()).toMatchObject({ model: "claude-haiku-5-5", reported: true, usage: { input_tokens: 5, output_tokens: 6 } });
    expect(new UsageMeter("application/json").end().reported).toBe(false);
  });
});

describe("the gateway", () => {
  it("swaps the session's token for the key, relays the stream unchanged, and records what it cost", async () => {
    const { id, token } = gw.issue({ taskId: "T-0001", label: "build", limitUsd: 5 });
    const before = upstreamSeen.length;
    const r = await turn(token, { case: "cheap" });
    expect(r.status).toBe(200);
    expect(r.body).toContain("event: message_stop");
    const seen = upstreamSeen.slice(before);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/v1/messages?beta=true");
    expect(seen[0]?.headers["x-api-key"]).toBe(KEY);
    expect(seen[0]?.headers["anthropic-beta"]).toBe("test-beta");
    expect(seen[0]?.headers["accept-encoding"]).toBe("identity");
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(token);
    const e = usage.at(-1);
    expect(e).toMatchObject({ session: id, task: "T-0001", label: "build", model: "claude-opus-5-5", reported: true, usage: { input_tokens: 10, output_tokens: 5 } });
    expect(e?.usd).toBeCloseTo((10 * 4 + 5 * 20) / 1e6, 10);
    expect(gw.session(id)?.spentUsd).toBeCloseTo(e?.usd ?? 0, 10);
    // count_tokens goes through unmetered; the CLI's connectivity check is answered here.
    const counted = usage.length;
    expect((await turn(token, { path: "/v1/messages/count_tokens" })).status).toBe(200);
    expect(usage.length).toBe(counted);
    expect((await fetch(`${gw.urls[0] ?? ""}/api/hello`)).status).toBe(200);
  });

  it("refuses a missing, wrong or revoked token, another route and an unpriced model, before going upstream", async () => {
    const { id, token } = gw.issue({ taskId: "T-0002", label: "spec", limitUsd: 5 });
    const before = upstreamSeen.length;
    expect((await turn(null)).status).toBe(401);
    expect((await turn(`${token}x`)).status).toBe(401);
    expect((await turn(KEY)).status).toBe(401);
    expect((await turn(token, { path: "/v1/complete" })).status).toBe(404);
    expect((await turn(token, { path: "/v1/messages/batches" })).status).toBe(404);
    const unpriced = await turn(token, { model: "claude-unpriced-9" });
    expect(unpriced.status).toBe(400);
    expect(unpriced.body).toContain("has no price");
    gw.revoke(id);
    expect((await turn(token)).status).toBe(401);
    expect(upstreamSeen.length).toBe(before);
  });

  it("stops a session at its limit: the request that reaches it completes, the next is refused", async () => {
    // Each turn costs $0.60; the limit is $1.00, so the third turn is refused mid-session.
    const { id, token } = gw.issue({ taskId: "T-0003", label: "build", limitUsd: 1 });
    expect((await turn(token, { case: "dear", turns: 0 })).status).toBe(200);
    expect((await turn(token, { case: "dear", turns: 1, stream: false })).status).toBe(200);
    expect(gw.session(id)?.spentUsd).toBeCloseTo(1.2);
    const before = upstreamSeen.length;
    const refused = await turn(token, { case: "dear", turns: 2 });
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("hard budget is spent");
    expect(upstreamSeen.length).toBe(before);
    expect(gw.session(id)).toMatchObject({ refused: "budget", requests: 2 });
    expect(usage.filter((u) => u.session === id).map((u) => u.usd)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.6, 6)]);
  });

  it("refuses everything while the factory is halted, and the tokens stay revoked after", async () => {
    const { id, token } = gw.issue({ taskId: "T-0004", label: "review", limitUsd: 5 });
    halted = "halted by operator";
    try {
      const r = await turn(token);
      expect(r.status).toBe(403);
      expect(r.body).toContain("halted");
    } finally {
      halted = null;
    }
    expect(gw.session(id)?.refused).toBe("halted");
    expect((await turn(token)).status).toBe(401);
  });

  it("revokes a session whose usage cannot be recorded (a lost lease)", async () => {
    const failing = await startGateway({
      prices, keyFile, upstream: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`, hosts: ["127.0.0.1"],
      halted: () => null, onUsage: () => { throw new Error("stale epoch"); }, log: (l) => logs.push(l),
    });
    try {
      const { token } = failing.issue({ taskId: "T-0005", label: "build", limitUsd: 5 });
      const call = (): Promise<Response> => fetch(`${failing.urls[0] ?? ""}/v1/messages`, { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "[case:cheap] x" }], tools: [{ name: "Bash" }] }) });
      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(401);
    } finally {
      await failing.close();
    }
  });

  it("writes a session's token where only factoryctl reads it", () => {
    const t = writeTokenFile(join(scratch, "tokens"), "gw_x", "sfgw_secret");
    expect(t.path).toBe(join(scratch, "tokens", "gw_x.token"));
    t.remove();
    expect(() => writeTokenFile(join(scratch, "tokens"), "gw_x", "a")).not.toThrow();
    expect(() => writeTokenFile(join(scratch, "tokens"), "gw_x", "b")).toThrow();
  });
});
