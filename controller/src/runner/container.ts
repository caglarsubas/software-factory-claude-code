// Runner containers (ROADMAP P2-01): each stage session's Claude Code process runs in its own
// container from the runner image, while the Agent SDK, the in-process guard and everything
// with a credential stay in factoryctl on the host. The SDK starts the CLI through
// spawnClaudeCodeProcess; containerSpawner turns that into `docker run -i` of the image's own
// `claude` with the same flags, so the SDK's stdio protocol, its hooks and its abort work as
// they do on the host.
//
// What a runner container gets:
// - the operator's uid:gid (never root), no capabilities, no-new-privileges, a read-only root,
//   and the runner seccomp profile, which lets bubblewrap (the Bash sandbox) make namespaces;
// - an internal network whose only exit is the task's egress proxy (network.ts);
// - bind mounts at the same paths as on the host, so the host guard's paths hold inside: the
//   worktree (writable only for the build), the task directory, the session's home, config and
//   temp, and read-only the bundle, the release's plugin, the mirror the worktree borrows its
//   objects from, and the guard config;
// - the session's token at TOKEN_PATH, read-only, denied to every tool and to the sandbox;
// - an env of exactly the session allowlist, plus the variables the SDK sets for its CLI.
// Never mounted: $FACTORY_HOME/secrets, the API key, the App key, the engine socket.
//
// Every runner container is named for its task and labelled with the factoryctl run that owns
// it, so abort, halt, reaping and a re-lease can remove it: killing the `docker run` client
// alone would leave the session running.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { ENGINE } from "../../../gates/src/container.ts";
import { isLive, self, type ProcRef } from "../proc.ts";
import { TOKEN_PATH } from "./managed.ts";

export const RUNNER_LABEL = "software-factory.runner=1";
const TASK_LABEL = "software-factory.task";
const OWNER_LABEL = "software-factory.owner";
/** The CLI inside the image. */
export const RUNNER_CLAUDE = "/usr/local/bin/claude";
/** The image's own PATH; the host's means nothing inside. */
export const RUNNER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** Variables the Agent SDK sets for its CLI, forwarded as they are. */
export const SDK_ENV = ["CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SDK_READS_SESSION_STATE"];

export const RUNNER_HARDENING: readonly string[] = [
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  // Docker masks parts of /proc, and the kernel then refuses the fresh /proc mount bubblewrap
  // makes for each sandboxed command's own pid namespace. Unmasking them lets the sandbox run
  // in its normal mode (enableWeakerNestedSandbox stays off); the runner still has no
  // capability to use what the masks hid.
  "--security-opt", "systempaths=unconfined",
  "--read-only",
  "--tmpfs", "/tmp:rw,nosuid,size=1g",
  "--pids-limit", "1024",
  "--memory", "4g",
  "--cpus", "2",
];

/** The runner's setup for one task: everything a session's container needs besides its mounts. */
export interface RunnerSetup {
  image: string;
  /** The task's internal network (network.ts). */
  network: string;
  /** http://<proxy>:<port>, the network's only exit. */
  proxyUrl: string;
  /** Host path of runner/seccomp/runner.json in the release. */
  seccomp: string;
  /** Host file mounted at TOKEN_PATH: the session's credential (a gateway token from P2-02). */
  tokenFile: string;
  /** ANTHROPIC_BASE_URL for the CLI (the gateway from P2-02; a stub model in the conformance suite). */
  baseUrl?: string;
  /** Hosts the CLI reaches directly on the internal network, not through the proxy. */
  noProxy?: readonly string[];
  /** Linux hosts with AppArmor: docker-default denies the mounts bubblewrap makes. */
  apparmorUnconfined?: boolean;
}

export interface Mount {
  path: string;
  readOnly: boolean;
}

const SAFE_PATH = /^\/[^,\n\r\0]*$/;

/** The operator's uid:gid. A root factoryctl gets an unprivileged id instead, never root in the runner. */
export function runnerUser(): string {
  const uid = process.getuid?.() ?? 10001;
  const gid = process.getgid?.() ?? 10001;
  return uid === 0 ? "10001:10001" : `${String(uid)}:${String(gid)}`;
}

/** The directories a worktree made with `git clone --shared` borrows its objects from. */
export function alternates(worktree: string): string[] {
  const file = join(worktree, ".git/objects/info/alternates");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#")).map((l) => resolve(join(worktree, ".git/objects"), l));
}

/** One mount per path, a writable mount winning over a read-only one of the same path. */
export function normalizeMounts(mounts: readonly Mount[]): Mount[] {
  const by = new Map<string, boolean>();
  for (const m of mounts) {
    const p = resolve(m.path);
    if (!SAFE_PATH.test(p)) throw new Error(`cannot mount ${JSON.stringify(m.path)}`);
    by.set(p, (by.get(p) ?? true) && m.readOnly);
  }
  return [...by.entries()].map(([path, readOnly]) => ({ path, readOnly })).sort((a, b) => a.path.localeCompare(b.path));
}

export const containerName = (taskId: string, label: string): string => `sf-runner-${taskId.toLowerCase()}-${label.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${randomBytes(3).toString("hex")}`;

const ownerValue = (p: ProcRef): string => `${String(p.pid)}@${p.start_time ?? ""}`;

function parseOwner(v: string): ProcRef | null {
  const at = v.indexOf("@");
  const pid = Number(v.slice(0, at));
  return at < 1 || !Number.isInteger(pid) ? null : { pid, start_time: v.slice(at + 1) === "" ? null : v.slice(at + 1) };
}

export interface RunArgsInput {
  name: string;
  taskId: string;
  owner: ProcRef;
  setup: RunnerSetup;
  mounts: readonly Mount[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  argv: readonly string[];
}

export function runArgs(i: RunArgsInput): string[] {
  const s = i.setup;
  if (!SAFE_PATH.test(s.seccomp) || !SAFE_PATH.test(s.tokenFile) || !SAFE_PATH.test(i.cwd)) throw new Error("unsafe runner path");
  const args = [
    "run", "-i", "--rm", "--name", i.name,
    "--label", RUNNER_LABEL, "--label", `${TASK_LABEL}=${i.taskId}`, "--label", `${OWNER_LABEL}=${ownerValue(i.owner)}`,
    ...RUNNER_HARDENING,
    "--security-opt", `seccomp=${s.seccomp}`,
    ...(s.apparmorUnconfined === true ? ["--security-opt", "apparmor=unconfined"] : []),
    "--user", runnerUser(),
    "--network", s.network,
  ];
  for (const m of normalizeMounts(i.mounts)) args.push("--mount", `type=bind,src=${m.path},dst=${m.path}${m.readOnly ? ",readonly" : ""}`);
  args.push("--mount", `type=bind,src=${s.tokenFile},dst=${TOKEN_PATH},readonly`);
  for (const [k, v] of Object.entries(i.env)) args.push("--env", `${k}=${v}`);
  args.push("--workdir", i.cwd, s.image, ...i.argv);
  return args;
}

/**
 * The session env inside the runner: the session's own names (prepareSession sets the runner's)
 * and the SDK's, with the image's PATH and the container's private /tmp (the sandbox's bridge
 * sockets live under TMPDIR, and a host path can exceed a socket path's length limit).
 */
export function runnerEnv(sdkEnv: Readonly<Record<string, string | undefined>>, allowed: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...allowed, ...SDK_ENV]) {
    const v = sdkEnv[k];
    if (v !== undefined) env[k] = v;
  }
  env["PATH"] = RUNNER_PATH;
  if ("TMPDIR" in env) env["TMPDIR"] = "/tmp";
  return env;
}

export function removeContainer(name: string): void {
  spawnSync(ENGINE, ["rm", "--force", name], { stdio: "ignore" });
}

/**
 * The SDK's spawnClaudeCodeProcess for a runner session. The `docker run` client is the SDK's
 * child; the container is removed when the client exits and when the session is aborted.
 */
export function containerSpawner(o: { taskId: string; label: string; setup: RunnerSetup; mounts: readonly Mount[]; allowedEnv: readonly string[]; logFile: string }): (s: SpawnOptions) => SpawnedProcess {
  return (s) => {
    if (!/(^|\/)claude(\.exe)?$/.test(s.command)) throw new Error(`the SDK started ${s.command}, not its claude binary`);
    const name = containerName(o.taskId, o.label);
    const cwd = s.cwd ?? o.mounts[0]?.path ?? "/";
    const args = runArgs({ name, taskId: o.taskId, owner: self(), setup: o.setup, mounts: o.mounts, env: runnerEnv(s.env, o.allowedEnv), cwd, argv: [RUNNER_CLAUDE, ...s.args] });
    // The engine client runs with factoryctl's own environment (DOCKER_HOST, contexts); the session's env goes in by --env only.
    const child = spawn(ENGINE, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true });
    child.stderr.pipe(createWriteStream(o.logFile, { flags: "a", mode: 0o600 }));
    const onAbort = (): void => {
      removeContainer(name);
    };
    s.signal.addEventListener("abort", onAbort, { once: true });
    child.once("exit", () => {
      s.signal.removeEventListener("abort", onAbort);
      removeContainer(name);
    });
    return child;
  };
}

interface Listed {
  name: string;
  task: string;
  owner: ProcRef | null;
}

/** Runner and egress containers on this host, with the task and run that own them. */
export function listContainers(label: string = RUNNER_LABEL): Listed[] {
  const r = spawnSync(ENGINE, ["ps", "--all", "--filter", `label=${label}`, "--format", `{{.Names}}\t{{.Label "${TASK_LABEL}"}}\t{{.Label "${OWNER_LABEL}"}}`], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((l) => l !== "").map((l) => {
    const [name = "", task = "", owner = ""] = l.split("\t");
    return { name, task, owner: parseOwner(owner) };
  });
}

/** Removes the runner containers a filter selects; returns their names. */
export function removeRunnerContainers(select: (c: Listed) => boolean): string[] {
  const doomed = listContainers().filter(select).map((c) => c.name);
  if (doomed.length > 0) spawnSync(ENGINE, ["rm", "--force", ...doomed], { stdio: "ignore" });
  return doomed;
}

/** Reaping (P1-02): runner containers whose factoryctl run is gone. */
export const reapRunnerContainers = (): string[] => removeRunnerContainers((c) => c.owner === null || !isLive(c.owner));

/** The kill switch: every runner container on this host. */
export const killRunnerContainers = (): string[] => removeRunnerContainers(() => true);

/** A task's runner containers, whoever owns them (cancel, and a re-lease from P2-03). */
export const removeTaskRunnerContainers = (taskId: string): string[] => removeRunnerContainers((c) => c.task === taskId);

/** The runner's seccomp profile in a release. */
export const seccompPath = (releaseRoot: string): string => join(releaseRoot, "runner/seccomp/runner.json");

/** Whether the engine applies AppArmor (Linux hosts with it on; Docker Desktop has none). */
export function engineHasAppArmor(): boolean {
  const r = spawnSync(ENGINE, ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("apparmor");
}
