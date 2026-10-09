// Stop hook for the build stage: the builder may stop only after its local preflight passed
// or it recorded a structured failure. The authoritative gates still run in VERIFYING.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { block, loadConfig, readInput } from "./lib/io.ts";

const input = readInput();
const config = loadConfig();

if (config?.stage !== "build") process.exit(0);
// Already continuing because of this hook: let it stop; factoryctl records the missing evidence.
if (input["stop_hook_active"] === true) process.exit(0);

const readJson = (name: string): Record<string, unknown> | null => {
  const path = join(config.task_dir, name);
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const preflight = readJson("preflight.json");
if (preflight?.["passed"] === true) process.exit(0);
const failure = readJson("build-failure.json");
if (typeof failure?.["reason"] === "string" && failure["reason"].trim() !== "") process.exit(0);

block("before stopping, make the local preflight pass (preflight.json), or write build-failure.json in the task directory with a reason");
