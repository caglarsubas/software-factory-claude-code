// Plugin conformance: Claude Code ignores unknown frontmatter keys silently, so CI checks
// them, and keeps agents, tools.yaml, routing and hooks.json in agreement.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "../policy/load.ts";
import { AGENT_KEYS, agentFiles, agentName, EFFORTS, IGNORED_IN_PLUGINS, MODEL_ALIASES, PLUGIN_DIR, readDefinition, SKILL_KEYS, skillFiles, toAgent } from "./agents.ts";

interface ToolsPolicy {
  agents: Record<string, { allow: string[]; deny: string[] }>;
}
interface FactoryConfig {
  claude_code: { version: string };
  routing: Record<string, { model: string; effort: string }>;
}
const tools = parse(readFileSync(join(REPO_ROOT, "policies/tools.yaml"), "utf8")) as ToolsPolicy;
const config = parse(readFileSync(join(REPO_ROOT, "config/factory.yaml"), "utf8")) as FactoryConfig;
const KNOWN_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "Bash", "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite"]);
const agents = agentFiles();

describe("agent files", () => {
  it("cover every agent in tools.yaml and the routing table", () => {
    const names = agents.map(agentName).sort();
    expect(names).toEqual(Object.keys(tools.agents).sort());
    expect(names).toEqual(Object.keys(config.routing).sort());
  });

  describe.each(agents)("%s", (path) => {
    const def = readDefinition(path);
    const agent = toAgent(def);
    const name = agentName(path);

    it("uses only known frontmatter keys, none that plugins ignore", () => {
      for (const key of Object.keys(def.frontmatter)) {
        expect(IGNORED_IN_PLUGINS.has(key), `${key} is ignored in plugin agents`).toBe(false);
        expect(AGENT_KEYS.has(key), `unknown key ${key}`).toBe(true);
      }
    });

    it("is complete and well-formed", () => {
      expect(agent.name).toBe(name);
      expect(agent.description.length).toBeGreaterThan(20);
      expect(MODEL_ALIASES.has(agent.model)).toBe(true);
      expect(EFFORTS.has(agent.effort)).toBe(true);
      expect(agent.maxTurns).toBeGreaterThan(0);
      expect(agent.prompt.length).toBeGreaterThan(100);
      for (const t of [...agent.tools, ...agent.disallowedTools]) expect(KNOWN_TOOLS.has(t), t).toBe(true);
    });

    it("matches policies/tools.yaml exactly", () => {
      const policy = tools.agents[name];
      expect(policy).toBeDefined();
      expect([...agent.tools].sort()).toEqual([...(policy?.allow ?? [])].sort());
      expect([...agent.disallowedTools].sort()).toEqual([...(policy?.deny ?? [])].sort());
    });

    it("matches the routing table's model and effort", () => {
      expect({ model: agent.model, effort: agent.effort }).toEqual({ model: config.routing[name]?.model, effort: config.routing[name]?.effort });
    });

    it("never gets web access", () => {
      expect(agent.tools).not.toContain("WebFetch");
      expect(agent.tools).not.toContain("WebSearch");
    });

    it("references only rubrics that exist", () => {
      for (const m of agent.prompt.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w/-]+\.md)/g)) {
        expect(existsSync(join(PLUGIN_DIR, m[1] ?? "")), m[1]).toBe(true);
      }
    });
  });
});

describe("skill files", () => {
  it.each(skillFiles())("%s uses only known keys and stays user-invoked", (path) => {
    const def = readDefinition(path);
    for (const key of Object.keys(def.frontmatter)) expect(SKILL_KEYS.has(key), `unknown key ${key}`).toBe(true);
    expect(def.frontmatter["disable-model-invocation"]).toBe(true);
  });
});

describe("Claude Code pin", () => {
  it("CI validates the plugin with the version config/factory.yaml pins", () => {
    const pinned = config.claude_code.version;
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/factory-ci.yml"), "utf8");
    const used = [...workflow.matchAll(/@anthropic-ai\/claude-code@([0-9.]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const v of used) expect(v).toBe(pinned);
  });
});

describe("hooks.json", () => {
  interface HookEntry {
    type: string;
    command: string;
    timeout?: number;
  }
  const hooks = (JSON.parse(readFileSync(join(PLUGIN_DIR, "hooks/hooks.json"), "utf8")) as { hooks: Record<string, { hooks: HookEntry[] }[]> }).hooks;
  const commands = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, command: h.command }))));

  const scriptOf = (command: string) => /"\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([\w-]+)\.ts"/.exec(command)?.[1];
  const eventsOf = (script: string) => commands.filter((c) => scriptOf(c.command) === script).map((c) => c.event).sort();

  it("wires the four ROADMAP §3.2 hooks to their events", () => {
    expect(new Set(commands.map((c) => scriptOf(c.command)))).toEqual(new Set(["guard", "require-gates", "ledger", "format-typecheck"]));
    expect(eventsOf("guard")).toEqual(["PreToolUse"]);
    expect(eventsOf("require-gates")).toEqual(["Stop", "SubagentStop"]);
    expect(eventsOf("format-typecheck")).toEqual(["PostToolUse"]);
    expect(eventsOf("ledger")).toEqual(expect.arrayContaining(["SessionEnd", "SubagentStop"]));
  });

  it("gives require-gates longer than the longest preflight a guard config allows", () => {
    const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas/guard-config.schema.json"), "utf8")) as {
      properties: { preflight: { properties: { timeout_ms: { maximum: number } } } };
    };
    const longest = schema.properties.preflight.properties.timeout_ms.maximum;
    const timeouts = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.filter((h) => scriptOf(h.command) === "require-gates").map((h) => h.timeout ?? 60)));
    expect(timeouts).toHaveLength(2);
    for (const seconds of timeouts) expect(seconds * 1000).toBeGreaterThan(longest);
  });

  it("exits 2 on any error in every hook except the observing ledger", () => {
    for (const c of commands) {
      const suffix = scriptOf(c.command) === "ledger" ? "|| true" : "|| exit 2";
      expect(c.command.endsWith(suffix), c.command).toBe(true);
    }
  });

  it("guards every tool", () => {
    expect(hooks["PreToolUse"]?.[0]).toMatchObject({ matcher: "*" });
  });

  it("quotes the plugin root and points at scripts that exist", () => {
    for (const { command } of commands) {
      const script = /"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(command)?.[1];
      expect(script, command).toBeDefined();
      expect(existsSync(join(PLUGIN_DIR, script ?? "")), script).toBe(true);
    }
  });
});
