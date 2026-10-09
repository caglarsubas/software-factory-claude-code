// Running a stage session. The live runner drives the Agent SDK; the replay runner (replay.ts)
// feeds a recorded transcript through the same collector, so everything downstream of a
// session is testable with zero tokens. Every live session's stream is recorded as NDJSON in
// the run directory, which makes it replayable.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Denial } from "./guard.ts";

export interface StageRequest {
  /** Transcript name, e.g. "review-security". */
  label: string;
  prompt: string;
  options: Options;
  /** NDJSON file the session's messages are recorded to. */
  transcript: string;
  /** Denials the in-process guard records (shared with the guard hook). */
  denials: Denial[];
}

export interface StageOutcome {
  ok: boolean;
  /** SDK result subtype, or "no_result" when the stream ended without one. */
  subtype: string;
  structured: unknown;
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Resolved model IDs, from the result's modelUsage. */
  models: string[];
  numTurns: number;
  /** Tool calls the permission system or the guard refused. */
  denied: { tool: string; reason: string }[];
  errors: string[];
  sessionId: string | null;
}

export interface SessionRunner {
  /** Recorded on every session's stage_started event: gate G0-1 counts only live sessions. */
  readonly kind: "sdk" | "replay";
  run(req: StageRequest): Promise<StageOutcome>;
}

export function record(path: string): (m: SDKMessage) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (m) => {
    appendFileSync(path, `${JSON.stringify(m)}\n`, { mode: 0o600 });
  };
}

export async function collect(stream: AsyncIterable<SDKMessage>, req: StageRequest, sink: (m: SDKMessage) => void): Promise<StageOutcome> {
  const outcome: StageOutcome = {
    ok: false,
    subtype: "no_result",
    structured: undefined,
    text: "",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    models: [],
    numTurns: 0,
    denied: [],
    errors: [],
    sessionId: null,
  };
  for await (const m of stream) {
    sink(m);
    if (m.type !== "result") continue;
    outcome.subtype = m.subtype;
    outcome.ok = m.subtype === "success" && !m.is_error;
    outcome.costUsd = m.total_cost_usd;
    outcome.inputTokens = m.usage.input_tokens + m.usage.cache_read_input_tokens + m.usage.cache_creation_input_tokens;
    outcome.outputTokens = m.usage.output_tokens;
    outcome.models = Object.keys(m.modelUsage).sort();
    outcome.numTurns = m.num_turns;
    outcome.sessionId = m.session_id;
    // Under dontAsk, PermissionDenied hooks do not fire; the result lists denials instead.
    outcome.denied.push(...m.permission_denials.map((d) => ({ tool: d.tool_name, reason: "not allowed in this stage" })));
    if (m.subtype === "success") {
      outcome.text = m.result;
      outcome.structured = m.structured_output;
    } else {
      outcome.errors = m.errors;
    }
  }
  for (const d of req.denials) outcome.denied.push(d);
  return outcome;
}

export const sdkRunner: SessionRunner = {
  kind: "sdk",
  run(req) {
    return collect(query({ prompt: req.prompt, options: req.options }), req, record(req.transcript));
  },
};
