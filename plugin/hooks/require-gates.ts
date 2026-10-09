// Stop and SubagentStop hook for the build stage: the builder may stop only after the
// preflight passes (the gate runner, run on its committed HEAD) or after it recorded a
// structured failure. The hook runs the preflight itself, so no file the builder could write
// stands in for a passing result. The authoritative gates still run again in VERIFYING.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { block, loadConfig, readInput } from "./lib/io.ts";

/** Below hooks.json's 1800 s, so the hook always answers before Claude Code gives up on it. */
const MAX_PREFLIGHT_MS = 1_740_000;
const OUTPUT_TAIL = 4000;

const input = readInput();
const config = loadConfig();

if (config?.stage !== "build") process.exit(0);
// Already continuing because of this hook: let it stop; factoryctl records the missing evidence.
if (input["stop_hook_active"] === true) process.exit(0);

const failurePath = join(config.task_dir, "build-failure.json");
if (existsSync(failurePath)) {
  try {
    const failure: unknown = JSON.parse(readFileSync(failurePath, "utf8"));
    const reason = typeof failure === "object" && failure !== null ? (failure as Record<string, unknown>)["reason"] : undefined;
    if (typeof reason === "string" && reason.trim() !== "") process.exit(0);
  } catch {
    // An unreadable failure record does not excuse the preflight.
  }
}

const preflight = (JSON.parse(readFileSync(process.env["FACTORY_GUARD_CONFIG"] ?? "", "utf8")) as { preflight?: { argv?: unknown; timeout_ms?: unknown } }).preflight;
const argv = preflight?.argv;
if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a): a is string => typeof a === "string")) {
  block("no preflight is configured for this build; write build-failure.json in the task directory with a reason to stop");
}
const [program = "", ...args] = argv;
const timeout = Math.min(typeof preflight?.timeout_ms === "number" ? preflight.timeout_ms : MAX_PREFLIGHT_MS, MAX_PREFLIGHT_MS);
const r = spawnSync(program, args, { cwd: config.worktree, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, shell: false });
if (r.status === 0) process.exit(0);

const why = r.error !== undefined ? (r.error.message.includes("ETIMEDOUT") ? `timed out after ${String(timeout / 1000)} s` : r.error.message) : `exit ${String(r.status)}`;
const output = `${r.stdout}${r.stderr}`.trim().slice(-OUTPUT_TAIL);
block(
  `the preflight did not pass (${why}). Commit your work, fix what failed and stop again, or write build-failure.json in the task directory with a reason.${output === "" ? "" : `\n${output}`}`,
);
