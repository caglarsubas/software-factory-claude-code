// PreToolUse guard: decides every tool call. hooks.json runs it as `node guard.ts || exit 2`,
// so a crash or a missing runtime blocks the call instead of letting it through.
import { decide } from "./lib/guard-policy.ts";
import { block, ledger, loadConfig, readInput } from "./lib/io.ts";

const input = readInput();
const config = loadConfig();
const { tool_name: tool, tool_input: toolInput, cwd } = input;

if (input["hook_event_name"] !== "PreToolUse") block("guard received a non-PreToolUse event");
if (typeof tool !== "string" || tool === "") block("tool call without a tool name");
if (typeof toolInput !== "object" || toolInput === null) block(`${tool} call without input`);
if (typeof cwd !== "string" || !cwd.startsWith("/")) block("tool call without an absolute working directory");

const decision = decide({ tool_name: tool, tool_input: toolInput as Record<string, unknown>, cwd }, config);
if (!decision.allow) {
  if (config !== null) ledger(config, { event: "guard_denied", tool, reason: decision.reason });
  block(decision.reason);
}
process.exit(0);
