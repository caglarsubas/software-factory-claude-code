// Reads the plugin's agent and skill files. factoryctl turns an agent file into the options
// of one Agent SDK session, so headless runs and humans use the same definition.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const PLUGIN_DIR = fileURLToPath(new URL("../../../plugin/", import.meta.url));

/** Subagent frontmatter keys a plugin agent may use (camelCase). Plugins ignore hooks, mcpServers and permissionMode. */
export const AGENT_KEYS = new Set(["name", "description", "tools", "disallowedTools", "model", "effort", "maxTurns", "omitClaudeMd", "skills", "isolation", "color", "background", "initialPrompt"]);
export const IGNORED_IN_PLUGINS = new Set(["hooks", "mcpServers", "permissionMode"]);
/** Skill frontmatter keys (kebab-case, plus the documented snake_case `when_to_use`). */
export const SKILL_KEYS = new Set(["name", "description", "when_to_use", "disable-model-invocation", "user-invocable", "allowed-tools", "disallowed-tools", "context", "agent", "model", "effort", "hooks", "argument-hint", "arguments", "background", "paths", "shell", "metadata", "license", "compatibility"]);
export const MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable", "inherit"]);
export const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface Definition {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface Agent {
  name: string;
  description: string;
  model: string;
  effort: string;
  tools: string[];
  disallowedTools: string[];
  maxTurns: number;
  omitClaudeMd: boolean;
  prompt: string;
}

export function readDefinition(path: string): Definition {
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error(`${path}: missing frontmatter`);
  const frontmatter: unknown = parse(match[1] ?? "");
  if (typeof frontmatter !== "object" || frontmatter === null) throw new Error(`${path}: frontmatter is not a mapping`);
  return { path, frontmatter: frontmatter as Record<string, unknown>, body: (match[2] ?? "").trim() };
}

const list = (v: unknown): string[] => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter((s) => s !== "") : []);

export function toAgent(def: Definition): Agent {
  const f = def.frontmatter;
  return {
    name: typeof f["name"] === "string" ? f["name"] : "",
    description: typeof f["description"] === "string" ? f["description"] : "",
    model: typeof f["model"] === "string" ? f["model"] : "",
    effort: typeof f["effort"] === "string" ? f["effort"] : "",
    tools: list(f["tools"]),
    disallowedTools: list(f["disallowedTools"]),
    maxTurns: typeof f["maxTurns"] === "number" ? f["maxTurns"] : 0,
    omitClaudeMd: f["omitClaudeMd"] === true,
    prompt: def.body,
  };
}

export function agentFiles(pluginDir: string = PLUGIN_DIR): string[] {
  const dir = join(pluginDir, "agents");
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => join(dir, f));
}

export function skillFiles(pluginDir: string = PLUGIN_DIR): string[] {
  const dir = join(pluginDir, "skills");
  return readdirSync(dir).sort().map((d) => join(dir, d, "SKILL.md"));
}

export const agentName = (path: string): string => basename(path, ".md");
