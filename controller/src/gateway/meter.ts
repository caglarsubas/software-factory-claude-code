// Metering (ROADMAP P2-02): what one Messages API response cost, from the usage the API itself
// reports, priced by the release's pinned price table (config/factory.yaml `prices`, §11).
// The gateway reads usage out of the response as it streams through, without changing a byte:
// a JSON body carries it whole; a stream carries the input side and model in message_start and
// the running output count in each message_delta, the last of which is final.
import type { Prices } from "../release.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** cache_creation_input_tokens by TTL, when the API breaks it down. */
  cache_creation_5m_input_tokens: number;
  cache_creation_1h_input_tokens: number;
}

export const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation_5m_input_tokens: 0, cache_creation_1h_input_tokens: 0 };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Folds an API usage object into a running one: a field the object carries replaces the running value. */
export function mergeUsage(into: Usage, raw: unknown): Usage {
  if (typeof raw !== "object" || raw === null) return into;
  const u = raw as Record<string, unknown>;
  const out = { ...into };
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const v = num(u[k]);
    if (v !== undefined) out[k] = v;
  }
  const by = u["cache_creation"];
  if (typeof by === "object" && by !== null) {
    const b = by as Record<string, unknown>;
    const m5 = num(b["ephemeral_5m_input_tokens"]);
    const h1 = num(b["ephemeral_1h_input_tokens"]);
    if (m5 !== undefined) out.cache_creation_5m_input_tokens = m5;
    if (h1 !== undefined) out.cache_creation_1h_input_tokens = h1;
  }
  return out;
}

export const promptTokens = (u: Usage): number => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;

/**
 * The cost in dollars, or null for a model the table does not price. Cache writes the API does
 * not break down by TTL are priced at the 1-hour rate, the higher one.
 */
export function priceUsage(prices: Prices, model: string, u: Usage): number | null {
  const p = prices.models[model];
  if (p === undefined) return null;
  const rate = p.long !== undefined && promptTokens(u) > p.long.above_prompt_tokens ? p.long : p;
  const split = u.cache_creation_5m_input_tokens + u.cache_creation_1h_input_tokens;
  const unsplit = Math.max(0, u.cache_creation_input_tokens - split);
  const writes = (u.cache_creation_5m_input_tokens * prices.cache_write["5m"] + (u.cache_creation_1h_input_tokens + unsplit) * prices.cache_write["1h"]) * rate.input;
  return (u.input_tokens * rate.input + u.output_tokens * rate.output + u.cache_read_input_tokens * rate.cache_read + writes) / 1e6;
}

export interface Metered {
  model: string | null;
  usage: Usage;
  /** Whether the response said what it used: a stream cut before message_start says nothing. */
  reported: boolean;
}

/**
 * Reads usage out of a response body as it passes. `kind` is from the response's content
 * type; an error body, or a body that is neither, reports nothing.
 */
export class UsageMeter {
  readonly #kind: "json" | "sse" | "other";
  #buffer = "";
  #model: string | null = null;
  #usage: Usage = { ...NO_USAGE };
  #reported = false;
  readonly #decoder = new TextDecoder();

  constructor(contentType: string | undefined) {
    const t = (contentType ?? "").toLowerCase();
    this.#kind = t.includes("text/event-stream") ? "sse" : t.includes("application/json") ? "json" : "other";
  }

  push(chunk: Uint8Array): void {
    if (this.#kind === "other") return;
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    if (this.#kind === "sse") this.#drainEvents(false);
  }

  end(): Metered {
    this.#buffer += this.#decoder.decode();
    if (this.#kind === "sse") this.#drainEvents(true);
    if (this.#kind === "json") {
      try {
        this.#message(JSON.parse(this.#buffer) as unknown);
      } catch {
        // Not a message: nothing to meter.
      }
    }
    this.#buffer = "";
    return { model: this.#model, usage: this.#usage, reported: this.#reported };
  }

  #message(m: unknown): void {
    if (typeof m !== "object" || m === null) return;
    const msg = m as Record<string, unknown>;
    if (msg["type"] !== "message" || typeof msg["usage"] !== "object") return;
    if (typeof msg["model"] === "string") this.#model = msg["model"];
    this.#usage = mergeUsage(this.#usage, msg["usage"]);
    this.#reported = true;
  }

  #drainEvents(final: boolean): void {
    const blocks = this.#buffer.replaceAll("\r\n", "\n").split("\n\n");
    this.#buffer = final ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data === "") continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (e["type"] === "message_start") this.#message(e["message"]);
      else if (e["type"] === "message_delta" && this.#reported) this.#usage = mergeUsage(this.#usage, e["usage"]);
    }
  }
}
