// Builders for SDK messages, for hand-written replay transcripts (tests, fixtures). Real
// transcripts come from live runs (runner.ts records every session).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

let counter = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

export function assistant(model: string, content: Record<string, unknown>[]): SDKMessage {
  return {
    type: "assistant",
    message: { id: `msg_${uuid()}`, type: "message", role: "assistant", model, content, stop_reason: "tool_use", stop_sequence: null, usage },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: "replay-session",
  } as unknown as SDKMessage;
}

export const text = (t: string): Record<string, unknown> => ({ type: "text", text: t });
export const toolUse = (name: string, input: Record<string, unknown>): Record<string, unknown> => ({ type: "tool_use", id: `toolu_${uuid()}`, name, input });

export function result(model: string, opts: { structured?: unknown; text?: string; costUsd?: number; subtype?: "success" | "error_max_turns" } = {}): SDKMessage {
  const subtype = opts.subtype ?? "success";
  const base = {
    type: "result",
    subtype,
    duration_ms: 1000,
    duration_api_ms: 900,
    is_error: subtype !== "success",
    num_turns: 3,
    stop_reason: "end_turn",
    total_cost_usd: opts.costUsd ?? 0.05,
    usage,
    modelUsage: { [model]: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: opts.costUsd ?? 0.05, contextWindow: 200000, maxOutputTokens: 32000 } },
    permission_denials: [],
    uuid: uuid(),
    session_id: "replay-session",
  };
  return (subtype === "success" ? { ...base, result: opts.text ?? "done", structured_output: opts.structured } : { ...base, errors: ["max turns reached"] }) as unknown as SDKMessage;
}

/** A judgment stage that answers with structured output and no tool calls. */
export const answer = (model: string, structured: unknown): SDKMessage[] => [assistant(model, [text("Reviewed the bundle.")]), result(model, { structured })];
