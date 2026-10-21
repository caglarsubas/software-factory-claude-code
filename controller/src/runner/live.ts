// Live sessions in the runner (P2-01), switched on once the gateway (P2-02) and the governance
// wiring (P2-05) were in: a task's live sessions run in runner containers on the task's own
// internal network. Their only exit is the task's egress proxy, whose one fixed route leads to
// the credential gateway on the host; the proxy logs every request under runs/<task>/egress/.
// The key, the App key and the engine socket never enter a container.
import { join } from "node:path";
import type { Home } from "../home.ts";
import { self } from "../proc.ts";
import { engineHasAppArmor, seccompPath, type RunnerSetup } from "./container.ts";
import { ensureRunnerImage } from "./image.ts";
import { ensureTaskNetwork, gatewayAddress, removeTaskNetwork } from "./network.ts";

export interface TaskRunner {
  /** Each session's setup, with its own gateway token. */
  setup: (tokenFile: string) => RunnerSetup;
  /** Removes the task's proxy and network; a run that dies leaves them to `reapTaskNetworks`. */
  stop: () => void;
}

/** Where the gateway must listen for runner sessions, and how their proxy reaches it. */
export const runnerGatewayAddress = gatewayAddress;

/**
 * Builds the runner image if it is missing, then starts the task's network and proxy with its
 * route to the gateway at `gateway` (an address `runnerGatewayAddress()` gave).
 */
export function startTaskRunner(o: { home: Home; releaseRoot: string; taskId: string; gateway: { host: string; port: number } }): TaskRunner {
  const image = ensureRunnerImage(o.releaseRoot);
  const upstream = process.env["FACTORY_EGRESS_UPSTREAM"];
  const net = ensureTaskNetwork({ taskId: o.taskId, image, owner: self(), logDir: join(o.home.runs, o.taskId, "egress"), gateway: o.gateway, ...(upstream === undefined || upstream === "" ? {} : { upstream }) });
  const baseUrl = net.gatewayUrl;
  if (baseUrl === undefined) throw new Error(`${o.taskId}: the egress proxy has no gateway route`);
  const apparmorUnconfined = engineHasAppArmor();
  const seccomp = seccompPath(o.releaseRoot);
  return {
    setup: (tokenFile) => ({ image, network: net.network, proxyUrl: net.proxyUrl, seccomp, tokenFile, baseUrl, noProxy: [net.proxy], apparmorUnconfined }),
    stop: () => {
      removeTaskNetwork(o.taskId);
    },
  };
}
