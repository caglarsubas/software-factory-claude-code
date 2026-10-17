// The runner image's managed settings (ROADMAP P2-01, §3.2, Appendix B). Managed settings win
// over everything a session passes, and with allowManagedPermissionRulesOnly the CLI ignores
// the allow and deny rules in --settings and --allowedTools. So the managed file carries the
// union of what any stage may use, plus every deny; each stage still narrows its own session
// through `tools`, `disallowedTools` (honoured under managed-only rules) and the in-process
// guard. With allowManagedHooksOnly the plugin's hooks.json does not run: the four factory hooks
// are managed hooks here, copied into the image from the release.
//
// Paths here are paths inside the runner, never the operator's: the per-session token is
// mounted at TOKEN_PATH and nothing under $FACTORY_HOME/secrets is mounted at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRIES, STRUCTURED_OUTPUT_TOOL } from "../session/options.ts";
import type { Release } from "../release.ts";

/** Where the image installs its managed settings (the Linux managed-settings path). */
export const MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";
/** The factory hooks inside the image. */
export const HOOKS_DIR = "/opt/software-factory/hooks";
/** The session's credential, mounted read-only and denied to every tool and to the sandbox. */
export const TOKEN_DIR = "/run/factory";
export const TOKEN_PATH = `${TOKEN_DIR}/api-token`;

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

type HookConfig = Record<string, { matcher?: string; hooks: HookCommand[] }[]>;

/** The plugin's hooks.json, pointed at the image's copy of the hooks. */
export function managedHooks(pluginDir: string): HookConfig {
  const file = JSON.parse(readFileSync(join(pluginDir, "hooks/hooks.json"), "utf8")) as { hooks: HookConfig };
  const out: HookConfig = {};
  for (const [event, groups] of Object.entries(file.hooks)) {
    out[event] = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => {
        const command = h.command.replaceAll("${CLAUDE_PLUGIN_ROOT}/hooks", HOOKS_DIR);
        if (command === h.command) throw new Error(`hooks.json: ${event} hook does not run from \${CLAUDE_PLUGIN_ROOT}/hooks`);
        return { ...h, command };
      }),
    }));
  }
  return out;
}

/** Every tool some stage may use: the managed allow list. */
export function unionAllow(release: Release): string[] {
  const all = new Set<string>([STRUCTURED_OUTPUT_TOOL]);
  for (const a of Object.values(release.tools.agents)) for (const t of a.allow) all.add(t);
  return [...all].sort();
}

/** The models a routed stage may run on, by exact ID. */
export function availableModels(release: Release): string[] {
  const ids = new Set<string>();
  for (const r of Object.values(release.config.routing)) {
    for (const alias of [r.model, ...(r.escalate_to === undefined ? [] : [r.escalate_to])]) {
      const pin = release.config.model_pins[alias];
      if (pin === undefined) throw new Error(`config/factory.yaml pins no model for ${alias}`);
      ids.add(pin);
    }
  }
  return [...ids].sort();
}

export function managedSettings(release: Release): Record<string, unknown> {
  const pins = release.config.model_pins;
  return {
    requiredMinimumVersion: release.config.claude_code.minimum,
    apiKeyHelper: `cat ${TOKEN_PATH}`,
    permissions: {
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      allow: unionAllow(release),
      deny: [
        "Read(./.env*)",
        "Read(~/.ssh/**)",
        "Read(~/.aws/**)",
        "Read(//proc/*/environ)",
        `Read(/${TOKEN_DIR}/**)`,
        "WebFetch",
        "WebSearch",
        ...release.tools.forbidden.map((f) => f.pattern),
      ],
    },
    allowManagedPermissionRulesOnly: true,
    allowManagedHooksOnly: true,
    allowManagedMcpServersOnly: true,
    allowedMcpServers: [],
    availableModels: availableModels(release),
    availableModelsMatch: "exact",
    disableWorkflows: true,
    workflowKeywordTriggerEnabled: false,
    cleanupPeriodDays: release.config.retention_days.transcripts,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      enableWeakerNestedSandbox: false,
      network: { allowedDomains: REGISTRIES },
      filesystem: { denyWrite: [".claude/**"], denyRead: [TOKEN_DIR] },
    },
    hooks: managedHooks(release.pluginDir),
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: pins["opus"] ?? "",
      ANTHROPIC_DEFAULT_SONNET_MODEL: pins["sonnet"] ?? "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: pins["haiku"] ?? "",
    },
  };
}

export const managedSettingsJson = (release: Release): string => `${JSON.stringify(managedSettings(release), null, 2)}\n`;
