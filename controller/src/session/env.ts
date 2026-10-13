// A session's environment is built from an allowlist, never inherited (ROADMAP §3.2):
// Bash inherits it, and WebFetch and MCP bypass the sandbox, so no credential may be in it.
// Telemetry (P1-06) adds the OTEL_ENV names, and nothing else, when the operator turns it on.
import { OTEL_ENV, type OtelEnv } from "../telemetry.ts";

export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "TERM",
  "CLAUDE_CONFIG_DIR",
  "FACTORY_GUARD_CONFIG",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

export type SessionEnv = Record<(typeof ENV_ALLOWLIST)[number], string> & OtelEnv;

/** What G0-3 and G1-3 accept as a session's env names: exactly the allowlist, or the allowlist and every telemetry name. */
export function allowedEnvKeys(keys: unknown): boolean {
  const got = JSON.stringify(keys);
  return got === JSON.stringify([...ENV_ALLOWLIST].sort()) || got === JSON.stringify([...ENV_ALLOWLIST, ...OTEL_ENV].sort());
}

export const FACTORY_IDENTITY = { name: "software-factory", email: "software-factory@users.noreply.github.com" };

export interface EnvInputs {
  /** The per-task home, config and temp directories (never the operator's). */
  home: string;
  configDir: string;
  tmpDir: string;
  guardConfig: string;
  modelPins: Record<string, string>;
  path?: string;
  /** Telemetry's variables (telemetryEnv), when it is on. */
  telemetry?: OtelEnv;
}

export function sessionEnv(i: EnvInputs): SessionEnv {
  return {
    PATH: i.path ?? process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: i.home,
    TMPDIR: i.tmpDir,
    LANG: "C.UTF-8",
    TERM: "dumb",
    CLAUDE_CONFIG_DIR: i.configDir,
    FACTORY_GUARD_CONFIG: i.guardConfig,
    ANTHROPIC_DEFAULT_OPUS_MODEL: i.modelPins["opus"] ?? "",
    ANTHROPIC_DEFAULT_SONNET_MODEL: i.modelPins["sonnet"] ?? "",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: i.modelPins["haiku"] ?? "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    GIT_AUTHOR_NAME: FACTORY_IDENTITY.name,
    GIT_AUTHOR_EMAIL: FACTORY_IDENTITY.email,
    GIT_COMMITTER_NAME: FACTORY_IDENTITY.name,
    GIT_COMMITTER_EMAIL: FACTORY_IDENTITY.email,
    GIT_CONFIG_NOSYSTEM: "1",
    ...i.telemetry,
  };
}
