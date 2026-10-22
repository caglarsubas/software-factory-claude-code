// The factory's own OTel collector (P2-08): OTLP/HTTP JSON in, one NDJSON line per export in a
// file per day, kept for the retention; and the gateway's route to it for runner sessions.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { startGateway } from "../gateway/gateway.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { otelPanel } from "../report/slo.ts";
import { filterOtel, pruneOtel, readOtel, startCollector } from "./collector.ts";

const scratch = mkdtempSync(join(tmpdir(), "otel-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const logs = (task: string, events: Record<string, string>[]): unknown => ({
  resourceLogs: [{
    resource: { attributes: [{ key: "factory.task_id", value: { stringValue: task } }] },
    scopeLogs: [{ logRecords: events.map((e) => ({ attributes: Object.entries(e).map(([key, v]) => ({ key, value: { stringValue: v } })) })) }],
  }],
});

describe("the OTel collector", () => {
  it("stores JSON exports by day and refuses what it cannot read", async () => {
    const dir = join(scratch, "a");
    const c = await startCollector({ dir, retentionDays: 30, now: () => new Date("2026-10-17T10:00:00Z") });
    try {
      const post = (path: string, body: string | Buffer, headers: Record<string, string> = { "content-type": "application/json" }): Promise<Response> => fetch(`${c.url}${path}`, { method: "POST", headers, body });
      expect((await post("/v1/logs", JSON.stringify(logs("T-0001", [{ "event.name": "claude_code.api_request" }, { "event.name": "claude_code.tool_decision", decision: "reject" }])))).status).toBe(200);
      expect((await post("/v1/metrics", gzipSync(JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: "factory.task_id", value: { stringValue: "T-0001" } }] } }] })), { "content-type": "application/json", "content-encoding": "gzip" })).status).toBe(200);
      expect((await post("/v1/logs", Buffer.from([1, 2, 3]), { "content-type": "application/x-protobuf" })).status).toBe(415);
      expect((await post("/v1/logs", "{not json")).status).toBe(400);
      expect((await post("/v1/other", "{}")).status).toBe(404);
      expect(readdirSync(dir)).toEqual(["2026-10-17.ndjson"]);
      const records = readOtel(dir);
      expect(records.map((r) => r.signal)).toEqual(["logs", "metrics"]);
      expect(otelPanel(records)).toEqual([{ task: "T-0001", exports: 2, api_requests: 1, api_errors: 0, tool_decisions: { accept: 0, reject: 1 } }]);
    } finally {
      await c.close();
    }
  });

  it("keeps day files for the retention and skips a torn last line", () => {
    const dir = join(scratch, "b");
    mkdirSync(dir);
    const now = new Date("2026-10-17T10:00:00Z");
    writeFileSync(join(dir, "2026-09-01.ndjson"), "{}\n");
    writeFileSync(join(dir, "2026-10-10.ndjson"), `${JSON.stringify({ received_at: "x", signal: "logs", body: {} })}\n{"torn`);
    writeFileSync(join(dir, "notes.txt"), "kept\n");
    expect(pruneOtel(dir, 30, now)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["2026-10-10.ndjson", "notes.txt"]);
    expect(readOtel(dir)).toHaveLength(1);
  });

  it("drops a purged task's exported resources and keeps every other task's (ADR 0003)", () => {
    const dir = join(scratch, "filtered");
    mkdirSync(dir);
    const both = { resourceLogs: [...(logs("T-0001", []) as { resourceLogs: unknown[] }).resourceLogs, ...(logs("T-0002", []) as { resourceLogs: unknown[] }).resourceLogs] };
    const line = (body: unknown): string => JSON.stringify({ received_at: "x", signal: "logs", body });
    writeFileSync(join(dir, "2026-10-21.ndjson"), [line(logs("T-0002", [])), '{"torn":"T-0002'].join("\n"));
    writeFileSync(join(dir, "2026-10-22.ndjson"), [line(logs("T-0001", [])), line(both), line({ resourceMetrics: [] }), '{"torn":"T-0001'].join("\n") + "\n");
    const untouched = readFileSync(join(dir, "2026-10-22.ndjson"), "utf8");
    expect(filterOtel(dir, (t) => t === "T-0003")).toEqual({ removed: 0, files: 0 });
    expect(readFileSync(join(dir, "2026-10-22.ndjson"), "utf8")).toBe(untouched);
    expect(filterOtel(dir, (t) => t === "T-0002")).toEqual({ removed: 3, files: 2 });
    // A day with nothing left goes; the export both tasks shared keeps the other task's resource.
    expect(readdirSync(dir)).toEqual(["2026-10-22.ndjson"]);
    expect(otelPanel(readOtel(dir)).map((p) => [p.task, p.exports])).toEqual([["T-0001", 2]]);
    expect(readFileSync(join(dir, "2026-10-22.ndjson"), "utf8")).toContain('{"torn":"T-0001');
  });

  it("is reachable through the gateway, without a token, only when the run has one", async () => {
    const dir = join(scratch, "c");
    const c = await startCollector({ dir, retentionDays: 30 });
    const keyFile = join(scratch, "key");
    writeFileSync(keyFile, "sk-ant-test\n");
    const prices = loadRelease(createValidator()).config.prices;
    const with_ = await startGateway({ prices, keyFile, upstream: "http://127.0.0.1:1", hosts: ["127.0.0.1"], halted: () => null, onUsage: () => undefined, log: () => undefined, otel: c.url });
    const without = await startGateway({ prices, keyFile, upstream: "http://127.0.0.1:1", hosts: ["127.0.0.1"], halted: () => null, onUsage: () => undefined, log: () => undefined });
    try {
      const body = JSON.stringify(logs("T-0002", [{ "event.name": "claude_code.api_error" }]));
      expect((await fetch(`${with_.urls[0] ?? ""}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(200);
      expect((await fetch(`${without.urls[0] ?? ""}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(404);
      expect(otelPanel(readOtel(dir))).toEqual([expect.objectContaining({ task: "T-0002", api_errors: 1 })]);
    } finally {
      await with_.close();
      await without.close();
      await c.close();
    }
  });
});
