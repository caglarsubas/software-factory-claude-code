// Task leases (ROADMAP P2-03). Whoever runs a task, `run` attended or a `serve` worker, first
// takes its lease; every write it makes carries the lease's epoch, and the store refuses a write
// from any other epoch (store/events.ts). A lease is renewed every LEASE_RENEW_MS and lapses
// LEASE_TTL_MS after the last renewal. It is taken over only when its holder is gone, or when it
// lapsed and its holder is stopped first: the old process group, its runner containers and its
// gate containers are all killed before the new epoch is granted, so two writers never act for
// one task at once.
import { removeTaskContainers } from "../../../gates/src/container.ts";
import type { Home } from "../home.ts";
import { isLive, reap, self, type ProcRef } from "../proc.ts";
import { removeTaskRunnerContainers } from "../runner/container.ts";
import { LeaseHeldError, StaleEpochError, type EventStore, type Lease } from "../store/events.ts";

/** Long enough to outlast a blocking git clone of a large target: a lease lapses only when its writer is hung or gone. */
export const LEASE_TTL_MS = 300_000;
export const LEASE_RENEW_MS = 15_000;
const STOP_GRACE_MS = 10_000;

export const holderId = (p: ProcRef = self()): string => `${String(p.pid)}@${p.start_time ?? ""}`;

export function parseHolder(holder: string): ProcRef | null {
  const at = holder.indexOf("@");
  const pid = Number(holder.slice(0, at));
  if (at < 1 || !Number.isInteger(pid) || pid <= 0) return null;
  const start = holder.slice(at + 1);
  return { pid, start_time: start === "" ? null : start };
}

const holderLive = (lease: Lease): boolean => {
  const p = parseHolder(lease.holder);
  return p !== null && isLive(p);
};

/** Whether a lease is free to take: nobody holds it, its holder is gone, or it lapsed (its holder is then stopped). */
export function leaseState(lease: Lease | null, now: number): "free" | "held" | "lapsed" {
  if (lease === null || lease.expires_at <= 0 || !holderLive(lease)) return "free";
  return lease.expires_at <= now ? "lapsed" : "held";
}

async function waitGone(p: ProcRef, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isLive(p) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return !isLive(p);
}

/**
 * Stops whatever acts for a task under a lease that is being taken over: the holder (SIGTERM,
 * then SIGKILL after a grace period), the session process groups it leaves (reaping), its
 * runner containers and its gate containers.
 */
export async function stopHolder(home: Home, lease: Lease, log: (line: string) => void = () => undefined): Promise<void> {
  const p = parseHolder(lease.holder);
  if (p !== null && isLive(p)) {
    log(`stopping ${lease.task_id}'s lease holder (pid ${String(p.pid)}, epoch ${String(lease.epoch)})`);
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      // Gone between the check and the signal.
    }
    if (!(await waitGone(p, STOP_GRACE_MS))) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // Gone.
      }
      await waitGone(p, STOP_GRACE_MS);
    }
  }
  for (const c of reap(home)) log(`reaped ${c.task_id} ${c.label} (pid ${String(c.pid)})`);
  for (const name of removeTaskRunnerContainers(lease.task_id)) log(`removed runner container ${name}`);
  const gates = removeTaskContainers(lease.task_id);
  if (gates > 0) log(`removed ${String(gates)} gate container(s) of ${lease.task_id}`);
}

export interface TakeOptions {
  /** Stop a live holder whose lease has not lapsed (cancel, reject): the operator's say-so. */
  force?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Takes a task's lease for this process. A live holder's lease is refused unless it lapsed or
 * `force` is set; in either case the holder is stopped first. The grant is checked again in the
 * store's transaction, so a third process cannot slip in between.
 */
export async function takeLease(home: Home, store: EventStore, taskId: string, o: TakeOptions = {}): Promise<Lease> {
  const now = o.now ?? Date.now;
  const current = store.lease(taskId);
  const state = leaseState(current, now());
  if (current !== null && state === "held" && o.force !== true) throw new LeaseHeldError(`${taskId} is running under ${current.holder} (epoch ${String(current.epoch)}); lease held`);
  if (current !== null && current.holder !== holderId()) await stopHolder(home, current, o.log);
  return store.acquireLease(taskId, holderId(), LEASE_TTL_MS, (found) => current !== null && found.epoch === current.epoch && !holderLive(found));
}

/** Renews a lease until stopped; `lost` runs once if it was taken over. */
export function keepLease(store: EventStore, lease: Lease, lost: (e: StaleEpochError) => void): { stop: () => void; current: () => Lease } {
  let held = lease;
  const timer = setInterval(() => {
    try {
      held = store.renewLease(held, LEASE_TTL_MS);
    } catch (e) {
      clearInterval(timer);
      if (e instanceof StaleEpochError) lost(e);
    }
  }, LEASE_RENEW_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      store.releaseLease(held);
    },
    current: () => held,
  };
}
