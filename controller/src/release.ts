// The factory release a run uses. Plugin, hooks, policies and the gate runner load only from
// it (ROADMAP §2.4): an installed releases/<sha> in operation (FACTORY_RELEASE), or this
// checkout during development.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadYaml, REPO_ROOT } from "./policy/load.ts";
import type { Validator } from "./schemas/validate.ts";

export interface FactoryConfig {
  claude_code: { version: string; agent_sdk: string; minimum: string };
  concurrency: { max_tasks: number };
  model_pins: Record<string, string>;
  routing: Record<string, { model: string; effort: string; escalate_to?: string }>;
  retention_days: { bundles: number; transcripts: number; otel: number };
}

export interface ToolsPolicy {
  agents: Record<string, { allow: string[]; deny: string[] }>;
  forbidden: { pattern: string; reason: string }[];
}

export interface Release {
  root: string;
  pluginDir: string;
  gatesCli: string;
  version: string;
  config: FactoryConfig;
  tools: ToolsPolicy;
}

export function loadRelease(validator: Validator, root: string = process.env["FACTORY_RELEASE"] ?? REPO_ROOT): Release {
  const plugin = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string };
  return {
    root,
    pluginDir: join(root, "plugin"),
    gatesCli: join(root, "gates/src/cli.ts"),
    version: plugin.version,
    config: loadYaml(join(root, "config/factory.yaml"), "factory-config.schema.json", validator) as FactoryConfig,
    tools: loadYaml(join(root, "policies/tools.yaml"), "tools-policy.schema.json", validator) as ToolsPolicy,
  };
}
