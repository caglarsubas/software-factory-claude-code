// The plugin's factory-review workflow (P2-14) on the pinned CLI: in a person's own session the
// CLI loads it as /software-factory:factory-review, and in a factory session, with the factory's
// own session settings, it does not. The real CLI runs through the SDK against the stub model on
// loopback, with the sandbox off: what a session loads does not depend on it. Zero tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Settings } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureHome, factoryHome } from "../home.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { sessionSettings } from "../session/options.ts";
import { stubHandler } from "../session/stub-model.ts";

const COMMAND = "software-factory:factory-review";
const root = mkdtempSync(join(tmpdir(), "workflow-int-"));
const validator = createValidator();
const release = loadRelease(validator);
const keyFile = join(root, "key");
const server = createServer(stubHandler(() => ({}), () => undefined));
let baseUrl = "";

beforeAll(async () => {
  writeFileSync(keyFile, "stub-key\n", { mode: 0o600 });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

/** The slash commands the pinned CLI offers a session with the release's plugin and these settings. */
async function commands(label: string, settings: Settings): Promise<string[]> {
  const config = join(root, label);
  mkdirSync(config);
  for await (const m of query({
    prompt: "hello",
    options: {
      cwd: root,
      settingSources: [],
      plugins: [{ type: "local", path: release.pluginDir }],
      permissionMode: "dontAsk",
      maxTurns: 1,
      sandbox: { enabled: false },
      settings: { apiKeyHelper: `cat '${keyFile}'`, ...settings },
      env: { PATH: process.env["PATH"] ?? "", HOME: root, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    },
  })) {
    if (m.type === "system" && m.subtype === "init") return m.slash_commands;
  }
  throw new Error(`${label}: no init message`);
}

describe("the factory-review workflow on the pinned CLI (P2-14)", () => {
  it("loads in a person's own session as /software-factory:factory-review", async () => {
    expect(await commands("person", {})).toContain(COMMAND);
  }, 120_000);

  it("is not there in a factory session", async () => {
    const home = factoryHome({ FACTORY_HOME: join(root, "home") });
    ensureHome(home);
    const settings = sessionSettings({ home, taskId: "T-0001", release, validator, keyFile }, release);
    expect(settings.disableWorkflows).toBe(true);
    const offered = await commands("factory", settings);
    expect(offered).not.toContain(COMMAND);
    expect(offered).toContain("software-factory:status");
  }, 120_000);
});
