// Shared I/O for the hook entrypoints: stdin parsing, the guard config factoryctl writes,
// the ledger, and exits. Exit 2 blocks the action and shows stderr to Claude; exit 1 would
// fail open, so enforcing hooks never use it.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "./guard-policy.ts";

/** Set by factoryctl for factory sessions only; its absence means a human session. */
export const CONFIG_ENV = "FACTORY_GUARD_CONFIG";

export function block(reason: string): never {
  process.stderr.write(`software-factory: ${reason}\n`);
  process.exit(2);
}

export function readInput(): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return block("hook input could not be read");
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return block("hook input is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return block("hook input is not a JSON object");
  return data as Record<string, unknown>;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The factory session's guard config, or null in a human session. Invalid config blocks. */
export function loadConfig(): GuardConfig | null {
  const path = process.env[CONFIG_ENV];
  if (path === undefined || path === "") return null;
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return block(`guard config ${path} is missing or unreadable`);
  }
  const scope = c["scope"] as Record<string, unknown> | null | undefined;
  const valid =
    c["schema_version"] === 1 &&
    typeof c["task_id"] === "string" &&
    typeof c["stage"] === "string" &&
    typeof c["worktree"] === "string" && c["worktree"].startsWith("/") &&
    typeof c["task_dir"] === "string" && c["task_dir"].startsWith("/") &&
    isStringArray(c["protected_paths"]) &&
    isStringArray(c["writable_task_files"]) &&
    isStringArray(c["secret_paths"]) &&
    isStringArray(c["allowed_tools"]) &&
    isStringArray(c["readable_roots"]) &&
    (scope === null || (typeof scope === "object" && isStringArray(scope["include"]) && isStringArray(scope["exclude"])));
  if (!valid) return block(`guard config ${path} does not match guard-config.schema.json`);
  return c as unknown as GuardConfig;
}

/** Append one event to the task's ledger. Observing must never break a session. */
export function ledger(config: GuardConfig, event: Record<string, unknown>): void {
  try {
    appendFileSync(join(config.task_dir, "ledger.ndjson"), `${JSON.stringify({ ts: new Date().toISOString(), task_id: config.task_id, stage: config.stage, ...event })}\n`);
  } catch {
    process.stderr.write("software-factory: ledger write failed\n");
  }
}
