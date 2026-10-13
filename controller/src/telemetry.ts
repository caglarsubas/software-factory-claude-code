// OpenTelemetry per stage, and the model alias alarm (ROADMAP P1-06).
//
// Telemetry is optional: with FACTORY_OTEL_ENDPOINT set, every session exports Claude Code's
// metrics and events over OTLP, tagged with resource attributes that name the task, stage,
// label, round, tier, agent and release. The endpoint must be on this machine's loopback
// interface: a local collector forwards it on, under the operator's credentials, so no
// credential reaches a session's environment and nothing leaves the host from inside a session
// (profiles allow Anthropic egress only). Prompt and response text stay redacted, Claude Code's
// default; the variables that would log them never reach a session.
//
// The alias alarm needs no telemetry: every session's result reports the model IDs it ran on,
// and an alarm event is recorded when one is not the ID the config pins, or when an alias
// resolves to an ID no earlier live session of that alias ran on.
import type { FactoryEvent } from "./store/events.ts";

/** The names telemetry adds to a session's environment, and no others. */
export const OTEL_ENV = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_LOGS_EXPORT_INTERVAL",
] as const;

export type OtelEnv = Partial<Record<(typeof OTEL_ENV)[number], string>>;

const PROTOCOLS = ["grpc", "http/protobuf", "http/json"] as const;

export interface Telemetry {
  endpoint: string;
  protocol: (typeof PROTOCOLS)[number];
}

export class TelemetryError extends Error {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** FACTORY_OTEL_ENDPOINT and FACTORY_OTEL_PROTOCOL (default http/protobuf); null when telemetry is off. */
export function telemetryConfig(env: NodeJS.ProcessEnv = process.env): Telemetry | null {
  const endpoint = env["FACTORY_OTEL_ENDPOINT"];
  if (endpoint === undefined || endpoint === "") return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TelemetryError(`FACTORY_OTEL_ENDPOINT is not a URL: ${endpoint}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname) || url.username !== "" || url.password !== "") {
    throw new TelemetryError("FACTORY_OTEL_ENDPOINT must be a collector on this machine's loopback address (http://127.0.0.1:4318), without credentials");
  }
  const protocol = env["FACTORY_OTEL_PROTOCOL"] ?? "http/protobuf";
  if (!(PROTOCOLS as readonly string[]).includes(protocol)) throw new TelemetryError(`FACTORY_OTEL_PROTOCOL is one of ${PROTOCOLS.join(", ")}`);
  return { endpoint: endpoint.replace(/\/+$/, ""), protocol: protocol as Telemetry["protocol"] };
}

export interface SessionAttributes {
  task: string;
  stage: string;
  label: string;
  round: number;
  tier: string;
  agent: string;
  release: string;
}

/** A resource attribute value as OTEL_RESOURCE_ATTRIBUTES carries it: percent-encoded where it must be. */
const attr = (v: string): string => encodeURIComponent(v);

export function telemetryEnv(t: Telemetry, a: SessionAttributes): OtelEnv {
  const attributes: [string, string][] = [
    ["factory.task_id", a.task],
    ["factory.stage", a.stage],
    ["factory.label", a.label],
    ["factory.round", String(a.round)],
    ["factory.tier", a.tier],
    ["factory.agent_id", a.agent],
    ["factory.release", a.release],
  ];
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: t.protocol,
    OTEL_EXPORTER_OTLP_ENDPOINT: t.endpoint,
    OTEL_RESOURCE_ATTRIBUTES: attributes.map(([k, v]) => `${k}=${attr(v)}`).join(","),
    // Sessions are short: export often, so a session's numbers are out before it ends.
    OTEL_METRIC_EXPORT_INTERVAL: "10000",
    OTEL_LOGS_EXPORT_INTERVAL: "5000",
  };
}

// --- the alias alarm -------------------------------------------------------------------------
export interface ModelAlarm {
  kind: "unpinned_model" | "alias_new_id";
  alias: string;
  /** The ID config/factory.yaml pins the alias to. */
  pinned: string;
  resolved: string;
  /** For alias_new_id: the IDs earlier live sessions of the alias ran on. */
  seen?: string[];
}

/**
 * The alarms one session's resolved models raise. `history` is every earlier event in the
 * store; only live sessions count as having seen a model.
 */
export function modelAlarms(alias: string, models: readonly string[], pins: Readonly<Record<string, string>>, history: readonly FactoryEvent[]): ModelAlarm[] {
  const pinned = pins[alias] ?? "";
  const anyPin = new Set(Object.values(pins));
  const seen = new Set(
    history.flatMap((e) => (e.type === "stage_completed" && e.payload["runner"] === "sdk" && e.payload["alias"] === alias && Array.isArray(e.payload["models"]) ? (e.payload["models"] as unknown[]).filter((m): m is string => typeof m === "string") : [])),
  );
  const alarms: ModelAlarm[] = [];
  for (const m of models) {
    // A session may also call another pinned model for its own housekeeping; any other ID is not pinned at all.
    if (!anyPin.has(m)) alarms.push({ kind: "unpinned_model", alias, pinned, resolved: m });
    else if (m === pinned && seen.size > 0 && !seen.has(m)) alarms.push({ kind: "alias_new_id", alias, pinned, resolved: m, seen: [...seen].sort() });
  }
  return alarms;
}

export const describeAlarm = (a: ModelAlarm): string =>
  a.kind === "unpinned_model"
    ? `alias ${a.alias} ran on ${a.resolved}, which config/factory.yaml does not pin (${a.alias} is pinned to ${a.pinned})`
    : `alias ${a.alias} now resolves to ${a.resolved}; earlier live sessions ran on ${(a.seen ?? []).join(", ")}`;
