// The transcript-replay harness (P0-07): a SessionRunner that replays recorded SDK messages
// instead of calling a model. Tool calls in the transcript go through the same permission
// rules as a live session (allowedTools under dontAsk, then the in-process guard), and the
// file edits that pass are applied to the session's cwd, so the rest of the pipeline sees
// the same worktree a live run would have left.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { collect, record, type SessionRunner, type StageRequest } from "./runner.ts";

export type Transcripts = Record<string, SDKMessage[]>;

/** Requests the replay runner received, for tests that assert on the options a stage got. */
export interface ReplayRunner extends SessionRunner {
  requests: StageRequest[];
}

function loadDir(dir: string, label: string): SDKMessage[] | undefined {
  const path = join(dir, `${label}.ndjson`);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as SDKMessage);
}

interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function toolUses(m: SDKMessage): ToolUse[] {
  if (m.type !== "assistant") return [];
  const content: unknown[] = m.message.content;
  return content.filter((b): b is ToolUse & { type: "tool_use" } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use");
}

async function preToolUse(options: Options, use: ToolUse, cwd: string): Promise<string | null> {
  if (!(options.allowedTools ?? []).includes(use.name)) return `${use.name} is not pre-approved (dontAsk)`;
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const out = await hook(
        { hook_event_name: "PreToolUse", session_id: "replay", transcript_path: "", cwd, tool_name: use.name, tool_input: use.input, tool_use_id: use.id },
        use.id,
        { signal: new AbortController().signal },
      );
      const specific = "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
      if (specific?.hookEventName === "PreToolUse" && specific.permissionDecision === "deny") return specific.permissionDecisionReason ?? "denied";
    }
  }
  return null;
}

function apply(use: ToolUse, cwd: string): void {
  const path = typeof use.input["file_path"] === "string" ? use.input["file_path"] : null;
  if (path === null) return;
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  if (use.name === "Write" && typeof use.input["content"] === "string") {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, use.input["content"]);
  } else if (use.name === "Edit" && typeof use.input["old_string"] === "string" && typeof use.input["new_string"] === "string") {
    const before = readFileSync(full, "utf8");
    if (!before.includes(use.input["old_string"])) throw new Error(`replay: Edit target text not found in ${path}`);
    const after = use.input["replace_all"] === true ? before.replaceAll(use.input["old_string"], use.input["new_string"]) : before.replace(use.input["old_string"], use.input["new_string"]);
    writeFileSync(full, after);
  }
}

export function replayRunner(source: Transcripts | string): ReplayRunner {
  const requests: StageRequest[] = [];
  return {
    kind: "replay",
    requests,
    async run(req) {
      requests.push(req);
      const messages = typeof source === "string" ? loadDir(source, req.label) : source[req.label];
      if (messages === undefined) throw new Error(`replay: no transcript for ${req.label}`);
      const cwd = req.options.cwd ?? process.cwd();
      async function* replay(): AsyncGenerator<SDKMessage> {
        for (const m of messages ?? []) {
          for (const use of toolUses(m)) {
            const denied = await preToolUse(req.options, use, cwd);
            if (denied === null) apply(use, cwd);
            else if (!req.denials.some((d) => d.reason === denied)) req.denials.push({ tool: use.name, reason: denied });
          }
          yield m;
        }
      }
      return collect(replay(), req, record(req.transcript));
    },
  };
}
