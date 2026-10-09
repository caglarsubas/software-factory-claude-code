// Observer hook: records subagent stops, failed tool calls and session ends in the task
// ledger. It never blocks; factoryctl's event store remains the source of truth.
import { ledger, loadConfig, readInput } from "./lib/io.ts";

try {
  const input = readInput();
  const config = loadConfig();
  if (config !== null) {
    ledger(config, {
      event: input["hook_event_name"],
      session_id: input["session_id"],
      ...(typeof input["tool_name"] === "string" ? { tool: input["tool_name"] } : {}),
      ...(typeof input["reason"] === "string" ? { reason: input["reason"] } : {}),
    });
  }
} catch {
  // Swallow: an observer must not change the session's outcome.
}
process.exit(0);
