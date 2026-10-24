// The factory's own OTel collector (ROADMAP P2-08). Every live run starts one on loopback unless
// the operator points sessions at a collector of their own (FACTORY_OTEL_ENDPOINT) or turns
// telemetry off (FACTORY_OTEL=off). It accepts OTLP over HTTP with JSON bodies, the protocol
// Claude Code calls http/json, and appends each export as one NDJSON line to a file per UTC day
// in `$FACTORY_HOME/otel/`, kept for the config's `retention_days.otel`. Those files are what
// `factoryctl slo` reads and what the G2-5 canary audit searches; nothing is forwarded anywhere.
//
// Prompt and response text never reach it: sessions export with Claude Code's default redaction
// (telemetry.ts passes no variable that would log them).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { writeAtomic } from "../fsutil.ts";

const MAX_BODY = 8 * 1024 * 1024;
const SIGNALS: Record<string, "metrics" | "logs" | "traces"> = { "/v1/metrics": "metrics", "/v1/logs": "logs", "/v1/traces": "traces" };
const DAY_FILE = /^([0-9]{4}-[0-9]{2}-[0-9]{2})\.ndjson$/;

/** One stored export. */
export interface OtelRecord {
  received_at: string;
  signal: "metrics" | "logs" | "traces";
  body: unknown;
}

export const otelDir = (root: string): string => join(root, "otel");

async function read(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Deletes day files older than the retention; returns how many. */
export function pruneOtel(dir: string, retentionDays: number, now: Date = new Date()): number {
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const day = DAY_FILE.exec(f)?.[1];
    if (day === undefined || Date.parse(`${day}T23:59:59Z`) >= cutoff) continue;
    rmSync(join(dir, f), { force: true });
    removed++;
  }
  return removed;
}

export interface Collector {
  url: string;
  close: () => Promise<void>;
}

export async function startCollector(o: { dir: string; retentionDays: number; log?: (line: string) => void; now?: () => Date }): Promise<Collector> {
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  pruneOtel(o.dir, o.retentionDays);
  const now = o.now ?? (() => new Date());
  const server: Server = createServer((req, res) => {
    void (async () => {
      const signal = SIGNALS[(req.url ?? "").split("?")[0] ?? ""];
      if (req.method !== "POST" || signal === undefined) {
        res.writeHead(404).end();
        return;
      }
      if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        // Protobuf is not decoded here: sessions are configured for http/json.
        res.writeHead(415, { "content-type": "application/json" }).end('{"error":"only OTLP/HTTP JSON is accepted"}');
        return;
      }
      let raw = await read(req);
      if (raw === null) {
        res.writeHead(413).end();
        return;
      }
      let body: unknown;
      try {
        if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"not a JSON OTLP export"}');
        return;
      }
      const at = now();
      const record: OtelRecord = { received_at: at.toISOString(), signal, body };
      appendFileSync(join(o.dir, `${at.toISOString().slice(0, 10)}.ndjson`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    })().catch((e: unknown) => {
      o.log?.(`otel collector: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => {
        r();
      });
    }),
  };
}

interface Resource {
  resource?: { attributes?: { key: string; value: { stringValue?: string } }[] };
}

const RESOURCES = ["resourceLogs", "resourceMetrics", "resourceSpans"] as const;
const TASK_ID = /T-[0-9]{4,}/g;

const resourceTask = (r: Resource): string | null => r.resource?.attributes?.find((a) => a.key === "factory.task_id")?.value.stringValue ?? null;

/**
 * Removes every exported resource of the tasks `drop` names (a purge or a retention, ADR 0003),
 * rewriting a day file atomically only when something in it changed. An export left with no
 * resource goes; a line that does not parse (a torn append) goes only if it names such a task.
 * Run it only while no collector writes: a purge and a prune refuse unless the factory is idle.
 */
export function filterOtel(dir: string, drop: (task: string) => boolean): { removed: number; files: number } {
  let removed = 0;
  let files = 0;
  if (!existsSync(dir)) return { removed, files };
  for (const f of readdirSync(dir).filter((x) => DAY_FILE.test(x) && statSync(join(dir, x)).isFile()).sort()) {
    const path = join(dir, f);
    const before = removed;
    const kept = readFileSync(path, "utf8").split("\n").flatMap((line) => {
      if (line === "") return [];
      let record: OtelRecord;
      try {
        record = JSON.parse(line) as OtelRecord;
      } catch {
        if ([...line.matchAll(TASK_ID)].some((m) => drop(m[0]))) {
          removed++;
          return [];
        }
        return [line];
      }
      const body = (record.body ?? {}) as Partial<Record<(typeof RESOURCES)[number], Resource[]>>;
      let any = false;
      let left = 0;
      for (const key of RESOURCES) {
        const list = body[key];
        if (!Array.isArray(list)) continue;
        const keep = list.filter((r) => {
          const task = resourceTask(r);
          return task === null || !drop(task);
        });
        if (keep.length !== list.length) any = true;
        body[key] = keep;
        left += keep.length;
      }
      if (!any) return [line];
      removed++;
      return left === 0 ? [] : [JSON.stringify({ ...record, body })];
    });
    if (removed === before) continue;
    files++;
    if (kept.length === 0) rmSync(path, { force: true });
    else writeAtomic(path, `${kept.join("\n")}\n`);
  }
  return { removed, files };
}

/** Every stored export, oldest day first; a torn last line (a crash mid-append) is skipped. */
export function readOtel(dir: string): OtelRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => DAY_FILE.test(f) && statSync(join(dir, f)).isFile()).sort().flatMap((f) =>
    readFileSync(join(dir, f), "utf8").split("\n").flatMap((line) => {
      if (line === "") return [];
      try {
        return [JSON.parse(line) as OtelRecord];
      } catch {
        return [];
      }
    }),
  );
}
