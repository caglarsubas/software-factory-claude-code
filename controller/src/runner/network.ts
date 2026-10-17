// A task's runner network (ROADMAP P2-01): an internal Docker network whose only other member is
// the task's egress proxy (runner/egress/proxy.ts). Internal networks have no route off the
// network, so a runner container reaches the outside world only through the proxy, and the
// proxy reaches it through one shared outbound network that no runner joins.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "../../../gates/src/container.ts";
import { REGISTRIES } from "../session/options.ts";
import { isLive, type ProcRef } from "../proc.ts";
import { runnerUser } from "./container.ts";

export const EGRESS_LABEL = "software-factory.egress=1";
export const OUTBOUND_NETWORK = "sf-egress-out";
export const PROXY_PORT = 3128;
/** Where the proxy writes its log inside its container (bind-mounted from the run directory). */
const LOG_DIR = "/var/log/egress";

export interface TaskNetwork {
  network: string;
  proxy: string;
  proxyUrl: string;
  /** Host path of the proxy's NDJSON log. */
  log: string;
}

const lower = (taskId: string): string => taskId.toLowerCase();
export const networkName = (taskId: string): string => `sf-run-${lower(taskId)}`;
export const proxyName = (taskId: string): string => `sf-egress-${lower(taskId)}`;

function engine(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(ENGINE, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

function must(args: string[]): void {
  const r = engine(args);
  if (!r.ok) throw new Error(`${ENGINE} ${args.slice(0, 3).join(" ")} failed: ${r.out.slice(-2000)}`);
}

const exists = (kind: "network" | "container", name: string): boolean => engine([kind, "inspect", name]).ok;

/**
 * Creates the task's network and starts its proxy, or reuses them. `allow` is the proxy's host
 * allowlist; an upstream proxy (FACTORY_EGRESS_UPSTREAM) is for hosts that only reach the
 * internet through one.
 */
export function ensureTaskNetwork(o: { taskId: string; image: string; owner: ProcRef; logDir: string; allow?: readonly string[]; upstream?: string }): TaskNetwork {
  const network = networkName(o.taskId);
  const proxy = proxyName(o.taskId);
  const net: TaskNetwork = { network, proxy, proxyUrl: `http://${proxy}:${String(PROXY_PORT)}`, log: join(o.logDir, "proxy.ndjson") };
  if (!exists("network", OUTBOUND_NETWORK)) must(["network", "create", "--label", EGRESS_LABEL, OUTBOUND_NETWORK]);
  if (!exists("network", network)) must(["network", "create", "--internal", "--label", EGRESS_LABEL, "--label", `software-factory.task=${o.taskId}`, network]);
  if (exists("container", proxy)) return net;
  mkdirSync(o.logDir, { recursive: true, mode: 0o700 });
  must([
    "run", "--detach", "--name", proxy,
    "--label", EGRESS_LABEL, "--label", `software-factory.task=${o.taskId}`, "--label", `software-factory.owner=${String(o.owner.pid)}@${o.owner.start_time ?? ""}`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=16m",
    "--pids-limit", "256", "--memory", "256m", "--cpus", "1", "--user", runnerUser(),
    "--network", network,
    "--mount", `type=bind,src=${o.logDir},dst=${LOG_DIR}`,
    "--env", `FACTORY_EGRESS_ALLOW=${(o.allow ?? REGISTRIES).join(",")}`,
    "--env", `FACTORY_EGRESS_PORT=${String(PROXY_PORT)}`,
    "--env", `FACTORY_EGRESS_LOG=${LOG_DIR}/proxy.ndjson`,
    ...(o.upstream === undefined || o.upstream === "" ? [] : ["--env", `FACTORY_EGRESS_UPSTREAM=${o.upstream}`]),
    o.image, "node", "/opt/software-factory/egress/proxy.ts",
  ]);
  must(["network", "connect", OUTBOUND_NETWORK, proxy]);
  return net;
}

/** Stops the task's proxy and removes its network (after its runner containers are gone). */
export function removeTaskNetwork(taskId: string): void {
  engine(["rm", "--force", proxyName(taskId)]);
  engine(["network", "rm", networkName(taskId)]);
}

/** Reaping: proxies (and their networks) whose factoryctl run is gone; returns the tasks. */
export function reapTaskNetworks(): string[] {
  const r = engine(["ps", "--all", "--filter", `label=${EGRESS_LABEL}`, "--format", '{{.Label "software-factory.task"}}\t{{.Label "software-factory.owner"}}']);
  if (!r.ok) return [];
  const reaped: string[] = [];
  for (const line of r.out.split("\n").filter((l) => l !== "")) {
    const [task = "", owner = ""] = line.split("\t");
    const at = owner.indexOf("@");
    const ref = { pid: Number(owner.slice(0, at)), start_time: owner.slice(at + 1) === "" ? null : owner.slice(at + 1) };
    if (at > 0 && isLive(ref)) continue;
    removeTaskNetwork(task);
    reaped.push(task);
  }
  return reaped;
}
