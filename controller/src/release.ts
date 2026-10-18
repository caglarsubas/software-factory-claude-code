// The factory release a run uses. Plugin, hooks, policies and the gate runner load only from
// it (ROADMAP §2.4): the code factoryctl itself runs from, which is an installed
// releases/<sha> in operation (started through $FACTORY_HOME/bin/factoryctl) or this checkout
// during development. FACTORY_RELEASE overrides it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tier } from "./policy/engine.ts";
import { loadYaml, REPO_ROOT } from "./policy/load.ts";
import type { Validator } from "./schemas/validate.ts";

export interface FactoryConfig {
  claude_code: { version: string; agent_sdk: string; minimum: string };
  concurrency: { max_tasks: number };
  model_pins: Record<string, string>;
  routing: Record<string, { model: string; effort: string; escalate_to?: string }>;
  retention_days: { bundles: number; transcripts: number; otel: number };
  prices: Prices;
}

/** $ per million tokens for one model (config/factory.yaml `prices`, ROADMAP §11). */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  /** Prices for a request whose prompt is above `above_prompt_tokens`. */
  long?: { above_prompt_tokens: number; input: number; output: number; cache_read: number };
}

export interface Prices {
  as_of: string;
  /** Cache writes as multiples of the input price, by TTL. */
  cache_write: { "5m": number; "1h": number };
  models: Record<string, ModelPrice>;
}

export interface ToolsPolicy {
  agents: Record<string, { allow: string[]; deny: string[] }>;
  forbidden: { pattern: string; reason: string }[];
}

export type BudgetTier = "R0" | "R1" | "R2" | "R3" | "Restricted";

/** policies/budgets.yaml (schemas/budgets-policy.schema.json). */
export interface BudgetsPolicy {
  task_usd: Record<BudgetTier, number>;
  default_monthly_cap_usd: number;
  wall_clock_minutes: number;
  max_remediation_rounds: number;
  calibration: { multiplier: number; min_runs_per_tier: number };
  stage_fraction: Record<"triage" | "spec" | "build" | "review" | "refute" | "approve" | "summarize", number>;
}

/** RELEASE.json of an installed release (schemas/release.schema.json). */
export interface ReleaseInfo {
  schema_version: 1;
  sha: string;
  tag: string;
  repository: string | null;
  installed_at: string;
  installed_by: string;
  tree_digest: string;
  files_digest: string;
  files: number;
  plugin_version: string;
  claude_code: string;
  agent_sdk: string;
}

export interface Release {
  root: string;
  pluginDir: string;
  gatesCli: string;
  version: string;
  /** null when running from a development checkout rather than an installed release. */
  info: ReleaseInfo | null;
  config: FactoryConfig;
  tools: ToolsPolicy;
  budgets: BudgetsPolicy;
  approvals: ApprovalsPolicy;
}

export type MergeAction = "human_merge" | "auto_merge" | "prepare_only";

/** policies/approvals.yaml: the autonomy ladder, and the phase whose rung applies now. */
export interface ApprovalsPolicy {
  current_phase: "P0" | "P1" | "P2" | "P3";
  spec_gate_tiers: Tier[];
  phases: Record<"P0" | "P1" | "P2" | "P3", Record<Tier, MergeAction>>;
}

export function readReleaseInfo(root: string, validator: Validator): ReleaseInfo | null {
  const path = join(root, "RELEASE.json");
  if (!existsSync(path)) return null;
  const info: unknown = JSON.parse(readFileSync(path, "utf8"));
  const check = validator.validate("release.schema.json", info);
  if (!check.valid) throw new Error(`${path}: ${check.errors.join("; ")}`);
  return info as ReleaseInfo;
}

export function loadRelease(validator: Validator, root: string = process.env["FACTORY_RELEASE"] ?? REPO_ROOT): Release {
  const plugin = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string };
  return {
    root,
    pluginDir: join(root, "plugin"),
    gatesCli: join(root, "gates/src/cli.ts"),
    version: plugin.version,
    info: readReleaseInfo(root, validator),
    config: loadYaml(join(root, "config/factory.yaml"), "factory-config.schema.json", validator) as FactoryConfig,
    tools: loadYaml(join(root, "policies/tools.yaml"), "tools-policy.schema.json", validator) as ToolsPolicy,
    budgets: loadYaml(join(root, "policies/budgets.yaml"), "budgets-policy.schema.json", validator) as BudgetsPolicy,
    approvals: loadYaml(join(root, "policies/approvals.yaml"), "approvals-policy.schema.json", validator) as ApprovalsPolicy,
  };
}
