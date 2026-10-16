// `factoryctl run --attach` (ROADMAP P1-04): each session's messages, one short line each, as
// they arrive. The full stream is in the run's transcripts; this is what an operator watches.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const WIDTH = 160;
const line = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= WIDTH ? one : `${one.slice(0, WIDTH - 1)}…`;
};

/** What a tool call is about: its file, command or pattern, when it names one. */
function target(input: Record<string, unknown>): string {
  for (const k of ["file_path", "command", "pattern", "path", "description"]) {
    const v = input[k];
    if (typeof v === "string" && v !== "") return ` ${v}`;
  }
  return "";
}

export function describeMessage(m: SDKMessage): string[] {
  if (m.type === "assistant") {
    const content: unknown[] = m.message.content;
    return content.flatMap((b) => {
      const block = b as { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") return [line(block.text)];
      if (block.type === "tool_use" && typeof block.name === "string") return [line(`→ ${block.name}${target(block.input ?? {})}`)];
      return [];
    });
  }
  if (m.type === "user") {
    const content: unknown = m.message.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((b) => {
      const block = b as { type?: string; is_error?: boolean; content?: unknown };
      if (block.type !== "tool_result" || block.is_error !== true) return [];
      return [line(`✗ ${typeof block.content === "string" ? block.content : "tool error"}`)];
    });
  }
  if (m.type === "result") {
    return [line(`■ ${m.subtype}: ${String(m.num_turns)} turns, $${m.total_cost_usd.toFixed(2)}, ${(m.duration_ms / 1000).toFixed(0)}s`)];
  }
  return [];
}
