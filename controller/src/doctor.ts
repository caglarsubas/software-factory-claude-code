// factoryctl doctor: check the pins, the credential hygiene and the host prerequisites a run
// needs (ROADMAP §3.2, G0-4). Every check reports; any failure makes the command exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Home } from "./home.ts";
import type { Release } from "./release.ts";

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
  return checks;
}
