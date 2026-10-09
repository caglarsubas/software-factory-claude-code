// Explicit SDK options for one stage session (ROADMAP P0-07, §3.2). Nothing is left to a
// default that could widen access: dontAsk with an explicit tool list, no filesystem settings,
// an allowlisted env, a per-task config dir, the plugin and its agent definition from the
// release, the in-process guard, a sandbox that must be available, and structured output for
// every judgment stage.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, Options, SandboxSettings, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { GuardConfig } from "../../../plugin/hooks/lib/guard-policy.ts";
import { sessionDir, type Home } from "../home.ts";
import { readDefinition, toAgent } from "../plugin/agents.ts";
import type { Release } from "../release.ts";
import type { Validator } from "../schemas/validate.ts";
import { sessionEnv, type SessionEnv } from "./env.ts";
import { guardHook, type Denial } from "./guard.ts";

/** Stages that run a model session (gates and publish are factoryctl's own). */
export type SessionStage = "triage" | "spec" | "build" | "review" | "approve" | "summarize";

export const REGISTRIES = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];

export interface StageSpec {
  stage: SessionStage;
  /** Plugin agent file name, e.g. "code-reviewer". */
  agent: string;
  /** Transcript and guard-config name; unique per session in a task, e.g. "review-security". */
  label: string;
  cwd: string;
  prompt: string;
  /** JSON Schema for structured output; required for every stage except build. */
  outputSchema?: Record<string, unknown>;
  /** Directories the session may read besides cwd (the evidence bundle, the task directory). */
  extraDirs: string[];
  guard: Pick<GuardConfig, "worktree" | "task_dir" | "protected_paths" | "scope" | "writable_task_files" | "secret_paths" | "readable_roots">;
  /** Build stage: the command require-gates runs before the builder may stop. */
  preflight?: { argv: string[]; timeout_ms: number };
}

export interface SessionInputs {
  home: Home;
  taskId: string;
  release: Release;
  validator: Validator;
  /** File apiKeyHelper reads; denied to every tool and to the sandbox. */
  keyFile: string;
  abort?: AbortController;
}

export interface PreparedSession {
  options: Options;
  env: SessionEnv;
  guardConfigPath: string;
  /** Filled as the in-process guard denies tool calls. */
  denials: Denial[];
}

/** The plugin's agent file as an SDK agent definition: one definition, two runtimes. */
export function agentDefinition(release: Release, agent: string): AgentDefinition {
  const a = toAgent(readDefinition(join(release.pluginDir, "agents", `${agent}.md`)));
  const pin = release.config.model_pins[a.model];
  if (pin === undefined) throw new Error(`${agent}: no model pin for alias ${a.model}`);
  return {
    description: a.description,
    prompt: a.prompt.replaceAll("${CLAUDE_PLUGIN_ROOT}", release.pluginDir),
    tools: a.tools,
    disallowedTools: a.disallowedTools,
    model: pin,
    maxTurns: a.maxTurns,
    omitClaudeMd: a.omitClaudeMd,
    effort: a.effort as NonNullable<AgentDefinition["effort"]>,
  };
}

/** Credential and secret locations no session may read, by absolute path as well as by `~`. */
export function secretPaths(home: Home): string[] {
  const operator = homedir();
  return [home.secrets, ...[".ssh", ".aws", ".azure", ".config/gcloud", ".config/gh", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials"].map((p) => join(operator, p))];
}

export function sessionSettings(inputs: SessionInputs, release: Release): Settings {
  const deny = [
    "Read(./.env*)",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(//proc/*/environ)",
    ...secretPaths(inputs.home).map((p) => `Read(/${p}/**)`),
    "WebFetch",
    "WebSearch",
    ...release.tools.forbidden.map((f) => f.pattern),
  ];
  return {
    apiKeyHelper: `cat '${inputs.keyFile.replaceAll("'", "'\\''")}'`,
    permissions: { defaultMode: "dontAsk", disableBypassPermissionsMode: "disable", deny },
    disableWorkflows: true,
    workflowKeywordTriggerEnabled: false,
    cleanupPeriodDays: release.config.retention_days.transcripts,
  };
}

export function sessionSandbox(inputs: SessionInputs): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: REGISTRIES },
    filesystem: { denyWrite: [".claude/**"], denyRead: secretPaths(inputs.home) },
  };
}

export function prepareSession(inputs: SessionInputs, spec: StageSpec): PreparedSession {
  const { release } = inputs;
  const tools = release.tools.agents[spec.agent];
  if (tools === undefined) throw new Error(`policies/tools.yaml has no entry for ${spec.agent}`);
  const routing = release.config.routing[spec.agent];
  if (routing === undefined) throw new Error(`config/factory.yaml routes no ${spec.agent}`);
  const model = release.config.model_pins[routing.model];
  if (model === undefined) throw new Error(`config/factory.yaml pins no model for ${routing.model}`);
  if (spec.stage !== "build" && spec.outputSchema === undefined) throw new Error(`${spec.stage} must return structured output`);

  const dir = sessionDir(inputs.home, inputs.taskId);
  const home = join(dir, "home");
  const configDir = join(dir, "claude");
  const tmpDir = join(dir, "tmp");
  for (const d of [home, configDir, tmpDir]) mkdirSync(d, { recursive: true, mode: 0o700 });

  const guard: GuardConfig & { preflight?: { argv: string[]; timeout_ms: number }; post_edit: never[] } = {
    schema_version: 1,
    task_id: inputs.taskId,
    stage: spec.stage,
    ...spec.guard,
    allowed_tools: tools.allow,
    // No host-side post-edit commands: formatters and linters load config the builder can edit.
    post_edit: [],
    ...(spec.preflight === undefined ? {} : { preflight: spec.preflight }),
  };
  const check = inputs.validator.validate("guard-config.schema.json", guard);
  if (!check.valid) throw new Error(`guard config for ${spec.label}: ${check.errors.join("; ")}`);
  const guardConfigPath = join(dir, `${spec.label}.guard.json`);
  writeFileSync(guardConfigPath, `${JSON.stringify(guard, null, 2)}\n`, { mode: 0o600 });

  const env = sessionEnv({ home, configDir, tmpDir, guardConfig: guardConfigPath, modelPins: release.config.model_pins });
  const denials: Denial[] = [];
  const options: Options = {
    cwd: spec.cwd,
    additionalDirectories: spec.extraDirs,
    agent: spec.agent,
    agents: { [spec.agent]: agentDefinition(release, spec.agent) },
    plugins: [{ type: "local", path: release.pluginDir }],
    settingSources: [],
    settings: sessionSettings(inputs, release),
    sandbox: sessionSandbox(inputs),
    permissionMode: "dontAsk",
    tools: tools.allow,
    allowedTools: tools.allow,
    disallowedTools: [...tools.deny, ...release.tools.forbidden.map((f) => f.pattern)],
    model,
    effort: routing.effort as NonNullable<Options["effort"]>,
    env,
    hooks: { PreToolUse: [{ matcher: "*", hooks: [guardHook(guard, (d) => denials.push(d))] }] },
    persistSession: true,
    ...(spec.outputSchema === undefined ? {} : { outputFormat: { type: "json_schema", schema: spec.outputSchema } }),
    ...(inputs.abort === undefined ? {} : { abortController: inputs.abort }),
  };
  return { options, env, guardConfigPath, denials };
}
