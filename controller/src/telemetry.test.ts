// Telemetry configuration, the variables a session gets, and the alias alarm (P1-06).
import { describe, expect, it } from "vitest";
import { allowedEnvKeys, ENV_ALLOWLIST, RUNNER_ENV } from "./session/env.ts";
import type { FactoryEvent } from "./store/events.ts";
import { describeAlarm, modelAlarms, OTEL_ENV, telemetryConfig, telemetryEnv } from "./telemetry.ts";

describe("telemetry configuration", () => {
  it("is off by default, and takes only a collector on loopback, without credentials", () => {
    expect(telemetryConfig({})).toBeNull();
    expect(telemetryConfig({ FACTORY_OTEL_ENDPOINT: "http://127.0.0.1:4318/" })).toEqual({ endpoint: "http://127.0.0.1:4318", protocol: "http/protobuf" });
    expect(telemetryConfig({ FACTORY_OTEL_ENDPOINT: "http://localhost:4317", FACTORY_OTEL_PROTOCOL: "grpc" })).toEqual({ endpoint: "http://localhost:4317", protocol: "grpc" });
    expect(() => telemetryConfig({ FACTORY_OTEL_ENDPOINT: "https://otel.example.com" })).toThrow(/loopback/);
    // Built, not written out: the secret scan rightly flags a URL with credentials in the source.
    const withCredentials = new URL("http://127.0.0.1:4318");
    withCredentials.username = "collector";
    withCredentials.password = "not-a-secret";
    expect(() => telemetryConfig({ FACTORY_OTEL_ENDPOINT: withCredentials.href })).toThrow(/without credentials/);
    expect(() => telemetryConfig({ FACTORY_OTEL_ENDPOINT: "file:///tmp/otel" })).toThrow(/loopback/);
    expect(() => telemetryConfig({ FACTORY_OTEL_ENDPOINT: "nope" })).toThrow(/not a URL/);
    expect(() => telemetryConfig({ FACTORY_OTEL_ENDPOINT: "http://127.0.0.1:4318", FACTORY_OTEL_PROTOCOL: "zipkin" })).toThrow(/one of grpc/);
  });

  it("gives a session exactly the telemetry names, with the stage's resource attributes", () => {
    const env = telemetryEnv({ endpoint: "http://127.0.0.1:4318", protocol: "http/json" }, { task: "T-0001", stage: "review", label: "review-code-r2", round: 2, tier: "R1", agent: "code-reviewer", release: "v0.2.0" });
    expect(Object.keys(env).sort()).toEqual([...OTEL_ENV].sort());
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("factory.task_id=T-0001,factory.stage=review,factory.label=review-code-r2,factory.round=2,factory.tier=R1,factory.agent_id=code-reviewer,factory.release=v0.2.0");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4318");
    // Nothing that would log prompt or response text, or carry a header.
    expect(Object.keys(env).join(" ")).not.toMatch(/LOG_USER_PROMPTS|LOG_TOOL|HEADERS/);
    // G0-3 and G1-3 accept the allowlist alone, or with every telemetry name; nothing in between or beyond.
    expect(allowedEnvKeys([...ENV_ALLOWLIST].sort())).toBe(true);
    expect(allowedEnvKeys([...ENV_ALLOWLIST, ...OTEL_ENV].sort())).toBe(true);
    expect(allowedEnvKeys([...ENV_ALLOWLIST, "OTEL_EXPORTER_OTLP_HEADERS"].sort())).toBe(false);
    expect(allowedEnvKeys([...ENV_ALLOWLIST, ...OTEL_ENV.slice(1)].sort())).toBe(false);
    // A runner session (P2-01) adds the proxy names, and the endpoint its CLI calls; never a key.
    expect(allowedEnvKeys([...ENV_ALLOWLIST, "HTTPS_PROXY", "NO_PROXY"].sort())).toBe(true);
    expect(allowedEnvKeys([...ENV_ALLOWLIST, ...RUNNER_ENV].sort())).toBe(true);
    expect(allowedEnvKeys([...ENV_ALLOWLIST, ...OTEL_ENV, ...RUNNER_ENV].sort())).toBe(true);
    expect(allowedEnvKeys([...ENV_ALLOWLIST, "ANTHROPIC_BASE_URL"].sort())).toBe(false);
    expect(allowedEnvKeys([...ENV_ALLOWLIST, ...RUNNER_ENV, "ANTHROPIC_API_KEY"].sort())).toBe(false);
  });
});

const PINS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
const completed = (alias: string, models: string[], runner = "sdk"): FactoryEvent => ({
  schema_version: 1, seq: 1, task_id: "T-0001", ts: "2026-10-13T00:00:00Z", epoch: 0, actor: { kind: "factoryctl", id: "factoryctl" },
  type: "stage_completed", payload: { alias, models, runner },
});

describe("the alias alarm", () => {
  it("is silent while sessions run on their pins, a pinned helper model included", () => {
    expect(modelAlarms("sonnet", ["claude-sonnet-5-5"], PINS, [])).toEqual([]);
    expect(modelAlarms("sonnet", ["claude-haiku-5-5", "claude-sonnet-5-5"], PINS, [completed("sonnet", ["claude-sonnet-5-5"])])).toEqual([]);
  });

  it("raises an alarm for a model no pin names", () => {
    const alarms = modelAlarms("sonnet", ["claude-sonnet-5-6"], PINS, []);
    expect(alarms).toEqual([{ kind: "unpinned_model", alias: "sonnet", pinned: "claude-sonnet-5-5", resolved: "claude-sonnet-5-6" }]);
    expect(alarms.map(describeAlarm)).toEqual(["alias sonnet ran on claude-sonnet-5-6, which config/factory.yaml does not pin (sonnet is pinned to claude-sonnet-5-5)"]);
  });

  it("raises an alarm when an alias resolves to an ID its earlier live sessions never ran on", () => {
    const history = [completed("sonnet", ["claude-sonnet-5-4"]), completed("sonnet", ["claude-sonnet-5-9"], "replay"), completed("opus", ["claude-opus-5-5"])];
    expect(modelAlarms("sonnet", ["claude-sonnet-5-5"], PINS, history)).toEqual([{ kind: "alias_new_id", alias: "sonnet", pinned: "claude-sonnet-5-5", resolved: "claude-sonnet-5-5", seen: ["claude-sonnet-5-4"] }]);
    // Replayed sessions are not evidence of what an alias resolves to.
    expect(modelAlarms("sonnet", ["claude-sonnet-5-5"], PINS, [completed("sonnet", ["claude-sonnet-5-9"], "replay")])).toEqual([]);
  });
});
