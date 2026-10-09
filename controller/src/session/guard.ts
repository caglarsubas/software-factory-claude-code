// The in-process SDK guard: the plugin guard's own policy, run as an SDK PreToolUse hook so
// it applies even where plugin hooks do not load (ROADMAP §3.2, "the SDK guard").
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { decide, type GuardConfig } from "../../../plugin/hooks/lib/guard-policy.ts";

export interface Denial {
  tool: string;
  reason: string;
}

/** `halted` is the kill switch (halt.ts): while it reports a halt, every tool call is denied. */
export function guardHook(config: GuardConfig, onDeny: (d: Denial) => void, halted: () => string | null = () => null): HookCallback {
  return (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
    const toolInput = typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
    const halt = halted();
    const decision = halt !== null ? { allow: false, reason: `the factory is ${halt}` } : decide({ tool_name: input.tool_name, tool_input: toolInput, cwd: input.cwd }, config);
    if (decision.allow) return Promise.resolve({});
    onDeny({ tool: input.tool_name, reason: decision.reason });
    return Promise.resolve({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason },
    });
  };
}
