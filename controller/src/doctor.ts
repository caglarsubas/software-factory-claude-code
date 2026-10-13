// factoryctl doctor: check the pins, the credential hygiene and the host prerequisites a run
// needs (ROADMAP §3.2, G0-4). Every check reports; any failure makes the command exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeHalt, readHalt } from "./halt.ts";
import type { Home } from "./home.ts";
import type { Release } from "./release.ts";
import { checkReleaseFiles } from "./release/install.ts";
import { EventStore } from "./store/events.ts";
import { describeAlarm, telemetryConfig, TelemetryError, type ModelAlarm } from "./telemetry.ts";

const ALARM_DAYS = 30;

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const which = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;

export function doctor(home: Home, release: Release, keyFile: string, env: NodeJS.ProcessEnv = process.env): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, severity: "warn" | "fail" = "fail"): void => {
    checks.push({ name, status: ok ? "ok" : severity, detail });
  };

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major === 24, `Node ${process.versions.node} (the factory pins Node 24 LTS)`);

  const pins = release.config.claude_code;
  try {
    // The package exports no ./package.json; it sits next to the entry point.
    const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version: string; claudeCodeVersion?: string };
    add("agent sdk pin", pkg.version === pins.agent_sdk, `installed ${pkg.version}, pinned ${pins.agent_sdk}`);
    add("claude code pin", pkg.claudeCodeVersion === pins.version, `the SDK runs Claude Code ${pkg.claudeCodeVersion ?? "?"}, pinned ${pins.version}`);
  } catch {
    add("agent sdk pin", false, "@anthropic-ai/claude-agent-sdk is not installed");
  }

  add("ANTHROPIC_API_KEY unset", env["ANTHROPIC_API_KEY"] === undefined, "sessions authenticate through apiKeyHelper; a key in the environment overrides it");
  for (const v of ["SSH_AUTH_SOCK", "GIT_ASKPASS"]) add(`${v} unset`, env[v] === undefined, "never passed to sessions, but better unset where factoryctl runs", "warn");
  const keyOk = existsSync(keyFile) && (statSync(keyFile).mode & 0o077) === 0;
  add("api key file", keyOk, existsSync(keyFile) ? `${keyFile} must be readable by you only (chmod 600)` : `create ${keyFile} (chmod 600) holding the Console key`);
  add("factory home", existsSync(home.root) && (statSync(home.root).mode & 0o077) === 0, `${home.root} must exist and be private (chmod 700)`);
  add("github token", env["FACTORY_GITHUB_TOKEN"] !== undefined, "FACTORY_GITHUB_TOKEN pushes branches and opens PRs; without it a run stops after pushing nothing", "warn");

  add("git", which("git"), "git is required");
  const docker = spawnSync(process.env["FACTORY_CONTAINER_ENGINE"] ?? "docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  add("container engine", docker.status === 0, docker.status === 0 ? `server ${docker.stdout.trim()}` : "Docker or Podman must be running for the gates");
  if (process.platform === "linux") {
    add("sandbox (bubblewrap, socat)", which("bwrap") && which("socat"), "Claude Code's Bash sandbox on Linux needs bwrap and socat; sessions require it (failIfUnavailable)");
  } else if (process.platform === "darwin") {
    add("sandbox (seatbelt)", which("sandbox-exec"), "Claude Code's Bash sandbox on macOS uses sandbox-exec");
  } else {
    add("platform", false, `${process.platform} is unsupported: native Windows runs unsandboxed`);
  }
  add("release", existsSync(release.pluginDir) && existsSync(release.gatesCli), `plugin ${release.version} at ${release.root}`);
  if (release.info === null) {
    add("installed release", false, "running from a development checkout: install a release (factoryctl release install vX.Y.Z) and run $FACTORY_HOME/bin/factoryctl", "warn");
  } else {
    const v = checkReleaseFiles(release.root, release.info);
    add("installed release", v.ok, `${release.info.tag} (${release.info.sha.slice(0, 12)}): ${v.detail}`);
  }
  const halt = readHalt(home);
  add("kill switch", halt === null, halt === null ? "not engaged" : `${describeHalt(halt)}; lift with factoryctl unhalt --reason "…"`, "warn");
  try {
    const t = telemetryConfig(env);
    add("telemetry", true, t === null ? "off; set FACTORY_OTEL_ENDPOINT to a local OTLP collector to export per-stage metrics" : `OTLP ${t.protocol} to ${t.endpoint}`);
  } catch (e) {
    add("telemetry", false, e instanceof TelemetryError ? e.message : String(e));
  }
  if (existsSync(home.db)) {
    // The alias alarm (P1-06): a model ID that drifted from its pin shows here until it is a month old.
    const since = new Date(Date.now() - ALARM_DAYS * 86_400_000).toISOString();
    const store = EventStore.open(home.db);
    const alarms = store.allEvents().filter((e) => e.type === "alarm" && e.ts >= since);
    store.close();
    const latest = alarms.reduce<(typeof alarms)[number] | undefined>((a, e) => (a === undefined || e.ts > a.ts ? e : a), undefined);
    add("model alarms", latest === undefined, latest === undefined ? `no alias alarm in ${String(ALARM_DAYS)} days` : `${String(alarms.length)} alias alarm(s) in ${String(ALARM_DAYS)} days; latest ${latest.task_id} ${String(latest.payload["label"])}: ${describeAlarm(latest.payload as unknown as ModelAlarm)}`, "warn");
  }
  return checks;
}
