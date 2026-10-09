// Disposable containers for the gate runner. Every container gets the same hardening, and
// gate containers mount only the run's own volumes: no host path, no network.
import { spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";

export const ENGINE = process.env["FACTORY_CONTAINER_ENGINE"] ?? "docker";
export const LABEL = "software-factory.gates=1";
const CA_PATH = "/etc/ssl/factory-ca.crt";
const CA_ENV = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "PIP_CERT"];
/** Proxy settings a fetch container inherits by name, so their values never reach argv. */
export const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

export const HARDENING: readonly string[] = [
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--read-only",
  "--tmpfs", "/tmp:rw,exec,nosuid,size=2g",
  "--user", "10001:10001",
  "--pids-limit", "2048",
  "--memory", "6g",
  "--cpus", "2",
  "--label", LABEL,
];

/** The kill switch (factoryctl halt) stops every gate container on this host; returns how many. */
export function killGateContainers(): number {
  const ps = spawnSync(ENGINE, ["ps", "--quiet", "--filter", `label=${LABEL}`], { encoding: "utf8" });
  if (ps.status !== 0) return 0;
  const ids = ps.stdout.split("\n").filter((id) => id !== "");
  if (ids.length > 0) spawnSync(ENGINE, ["kill", ...ids], { stdio: "ignore" });
  return ids.length;
}

export interface VolumeMount {
  volume: string;
  target: string;
  readOnly: boolean;
}

export interface ContainerSpec {
  name: string;
  image: string;
  /** "none" for every gate; only setup and the OSV refresh get a network. */
  network: string;
  volumes: readonly VolumeMount[];
  env?: Readonly<Record<string, string>>;
  /** Variable names copied from the runner's environment. */
  passEnv?: readonly string[];
  /** Extra CA bundle, bind-mounted read-only: fetch containers behind a TLS-inspecting proxy. */
  caFile?: string;
  stdin?: boolean;
  workdir?: string;
  argv: readonly string[];
}

const SAFE_MOUNT_VALUE = /^[^,=\s]+$/;

export function runArgs(spec: ContainerSpec): string[] {
  const args = ["run", "--rm", "--name", spec.name, ...HARDENING, "--network", spec.network];
  if (spec.stdin === true) args.push("-i");
  for (const v of spec.volumes) {
    if (!SAFE_MOUNT_VALUE.test(v.volume) || !SAFE_MOUNT_VALUE.test(v.target)) throw new Error(`unsafe mount ${v.volume}:${v.target}`);
    args.push("--mount", `type=volume,src=${v.volume},dst=${v.target}${v.readOnly ? ",readonly" : ""}`);
  }
  if (spec.caFile !== undefined) {
    if (!SAFE_MOUNT_VALUE.test(spec.caFile)) throw new Error(`unsafe CA bundle path ${spec.caFile}`);
    args.push("--mount", `type=bind,src=${spec.caFile},dst=${CA_PATH},readonly`);
    for (const k of CA_ENV) args.push("-e", `${k}=${CA_PATH}`);
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const k of spec.passEnv ?? []) if (process.env[k] !== undefined) args.push("-e", k);
  if (spec.workdir !== undefined) args.push("--workdir", spec.workdir);
  args.push(spec.image, ...spec.argv);
  return args;
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  /** The last 64 KiB only. */
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_STDOUT = 256 * 1024 * 1024;
const STDERR_TAIL = 64 * 1024;

export function exec(command: string, args: readonly string[], opts: { timeoutMs: number; stdin?: Readable; onTimeout?: () => void }): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) throw new Error("spawn did not open output pipes");
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    let err = "";
    let timedOut = false;
    if (opts.stdin !== undefined && child.stdin !== null) {
      // The reader may exit early (a failed extract); the runner judges by exit codes.
      child.stdin.on("error", () => undefined);
      opts.stdin.pipe(child.stdin);
    }
    stdout.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > MAX_STDOUT) overflow = true;
      else out.push(c);
    });
    stderr.on("data", (c: Buffer) => {
      err = (err + c.toString("utf8")).slice(-STDERR_TAIL);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      opts.onTimeout?.();
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        status: overflow ? null : status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: overflow ? `${err}\noutput exceeded ${String(MAX_STDOUT)} bytes` : err,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Run one container; on timeout, kill the container itself, not just the client. */
export function runContainer(spec: ContainerSpec, timeoutMs: number, stdin?: Readable): Promise<ExecResult> {
  return exec(ENGINE, runArgs(spec), {
    timeoutMs,
    ...(stdin === undefined ? {} : { stdin }),
    onTimeout: () => spawnSync(ENGINE, ["kill", spec.name], { stdio: "ignore" }),
  });
}

export function createVolume(name: string): void {
  const r = spawnSync(ENGINE, ["volume", "create", "--label", LABEL, name], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not create volume ${name}: ${r.stderr.trim()}`);
}

export function removeVolume(name: string): void {
  spawnSync(ENGINE, ["volume", "rm", "-f", name], { stdio: "ignore" });
}
