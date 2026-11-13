// A request a safety classifier flags, on the pinned CLI: by default Claude Code re-runs it on a
// fallback model the factory neither pins nor prices, and with the factory's session settings
// the session ends as a refusal on its pinned model instead. The real CLI runs through the SDK
// against the stub model on loopback, with the sandbox off: which model a request goes to does
// not depend on it. Zero tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage, type Settings } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureHome, factoryHome } from "../home.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { sessionSettings } from "./options.ts";
import { stubHandler, type Script } from "./stub-model.ts";

const root = mkdtempSync(join(tmpdir(), "models-int-"));
const validator = createValidator();
const release = loadRelease(validator);
const pins = release.config.model_pins;
const sonnet = pins["sonnet"] ?? "";
const keyFile = join(root, "key");
const script: Script = { flagged: [{ refusal: "cyber" }] };
const log: Record<string, unknown>[] = [];
const server = createServer(stubHandler(() => script, (e) => log.push(e)));
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

/** One Sonnet session whose first request the classifier flags: what it sent the model, and what it reported. */
async function flagged(label: string, settings: Settings): Promise<{ models: string[]; messages: SDKMessage[] }> {
  const config = join(root, label);
  mkdirSync(config);
  const from = log.length;
  const messages: SDKMessage[] = [];
  try {
    for await (const m of query({
      prompt: "[case:flagged] Review the change.",
      options: {
        cwd: root,
        settingSources: [],
        model: sonnet,
        tools: ["Read"],
        permissionMode: "dontAsk",
        maxTurns: 1,
        sandbox: { enabled: false },
        settings: { apiKeyHelper: `cat '${keyFile}'`, ...settings },
        env: {
          PATH: process.env["PATH"] ?? "", HOME: root, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          ANTHROPIC_DEFAULT_OPUS_MODEL: pins["opus"] ?? "", ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet, ANTHROPIC_DEFAULT_HAIKU_MODEL: pins["haiku"] ?? "",
        },
      },
    })) messages.push(m);
  } catch {
    // The SDK throws on the error result a refusal ends with; the messages before it are the evidence.
  }
  const models = log.slice(from).filter((e) => e["case"] === "flagged").map((e) => String(e["model"]));
  return { models: [...new Set(models)], messages };
}

const notice = (messages: SDKMessage[], subtype: string): SDKMessage | undefined => messages.find((m) => m.type === "system" && m.subtype === subtype);

describe("a request the classifier flags, on the pinned CLI", () => {
  it("is re-run on a model the factory does not pin, by default", async () => {
    const { models, messages } = await flagged("default", {});
    expect(models[0]).toBe(sonnet);
    expect(models.some((m) => !Object.values(pins).includes(m))).toBe(true);
    expect(notice(messages, "model_refusal_fallback")).toMatchObject({ original_model: sonnet, api_refusal_category: "cyber" });
  }, 120_000);

  it("ends a factory session as a refusal on its pinned model", async () => {
    const home = factoryHome({ FACTORY_HOME: join(root, "home") });
    ensureHome(home);
    const settings = sessionSettings({ home, taskId: "T-0001", release, validator, keyFile }, release);
    const { models, messages } = await flagged("factory", settings);
    expect(models).toEqual([sonnet]);
    expect(notice(messages, "model_refusal_fallback")).toBeUndefined();
    expect(notice(messages, "model_refusal_no_fallback")).toMatchObject({ original_model: sonnet, api_refusal_category: "cyber" });
    expect(messages.find((m) => m.type === "result")).toMatchObject({ is_error: true, stop_reason: "refusal" });
  }, 120_000);
});
