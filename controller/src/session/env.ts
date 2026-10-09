// A session's environment is built from an allowlist, never inherited (ROADMAP §3.2):
// Bash inherits it, and WebFetch and MCP bypass the sandbox, so no credential may be in it.
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

export type SessionEnv = Record<(typeof ENV_ALLOWLIST)[number], string>;

export const FACTORY_IDENTITY = { name: "software-factory", email: "software-factory@users.noreply.github.com" };

export interface EnvInputs {
  /** The per-task home, config and temp directories (never the operator's). */
  home: string;
  configDir: string;
  tmpDir: string;
  guardConfig: string;
  modelPins: Record<string, string>;
  path?: string;
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
  };
}
