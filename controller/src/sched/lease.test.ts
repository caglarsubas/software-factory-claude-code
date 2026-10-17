// Leases and fencing (ROADMAP P2-03, done when stale-epoch writes are rejected): a writer whose
// lease was taken over can write nothing more, a live holder's lease is refused unless it lapsed
// or the operator forces it, and taking a lease over stops the old holder first.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureHome, factoryHome } from "../home.ts";
import { isLive, startTime } from "../proc.ts";
import { EventStore, LeaseHeldError, StaleEpochError } from "../store/events.ts";
import { currentState, transition } from "../task/lifecycle.ts";
import { holderId, leaseState, LEASE_TTL_MS, takeLease } from "./lease.ts";

const scratch = mkdtempSync(join(tmpdir(), "lease-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let n = 0;
function stores(now: () => Date = () => new Date()) {
  const db = join(scratch, `factory-${String(++n)}.db`);
  return { a: EventStore.open(db, { now }), b: EventStore.open(db, { now }) };
}

const created = (s: EventStore, task: string) => s.append({ task_id: task, actor: { kind: "operator", id: "op" }, type: "task_created", payload: {} });
const factoryEvent = (task: string) => ({ task_id: task, actor: { kind: "factoryctl" as const, id: "factoryctl" }, type: "command" as const, payload: { command: "probe" } });

describe("fencing", () => {
  it("rejects every write from a lease that was taken over, and accepts the new holder's", () => {
    const { a, b } = stores();
    created(a, "T-0001");
    const first = a.acquireLease("T-0001", "1@a", LEASE_TTL_MS, () => false);
    expect(first.epoch).toBe(1);
    expect(a.append(factoryEvent("T-0001")).epoch).toBe(1);
    transition(a, "T-0001", "TRIAGED");

    // The old holder is gone (b decides so): b takes the lease at the next epoch.
    const second = b.acquireLease("T-0001", "2@b", LEASE_TTL_MS, () => true);
    expect(second.epoch).toBe(2);

    // The stale writer can neither append, transition nor renew; nothing it tried landed.
    const before = b.events("T-0001").length;
    expect(() => a.append(factoryEvent("T-0001"))).toThrow(StaleEpochError);
    expect(() => transition(a, "T-0001", "SPECIFIED")).toThrow(StaleEpochError);
    expect(() => a.renewLease(first, LEASE_TTL_MS)).toThrow(StaleEpochError);
    expect(b.events("T-0001")).toHaveLength(before);
    // An explicit epoch is no way around it.
    expect(() => a.append({ ...factoryEvent("T-0001"), epoch: 1 })).toThrow(StaleEpochError);
    expect(() => a.append({ ...factoryEvent("T-0001"), epoch: 3 })).toThrow(StaleEpochError);

    // The new holder writes at its epoch; the operator's own commands are not fenced.
    transition(b, "T-0001", "SPECIFIED");
    expect(b.events("T-0001").at(-1)).toMatchObject({ type: "state_changed", to: "SPECIFIED", epoch: 2 });
    expect(a.append({ task_id: "T-0001", actor: { kind: "operator", id: "op" }, type: "command", payload: { command: "pause" } }).type).toBe("command");
    expect(currentState(b.events("T-0001"))).toBe("SPECIFIED");
    // Each grant is on the record.
    expect(b.events("T-0001").filter((e) => e.payload["command"] === "lease_acquired").map((e) => [e.payload["holder"], e.epoch])).toEqual([["1@a", 1], ["2@b", 2]]);
  });

  it("leaves tasks without a lease as they were, and fences only the task a lease names", () => {
    const { a, b } = stores();
    created(a, "T-0001");
    created(a, "T-0002");
    expect(a.append(factoryEvent("T-0001")).epoch).toBe(0);
    b.acquireLease("T-0002", "2@b", LEASE_TTL_MS, () => true);
    expect(a.append(factoryEvent("T-0001")).epoch).toBe(0);
    expect(() => a.append(factoryEvent("T-0002"))).toThrow(StaleEpochError);
  });

  it("refuses a lease its holder still holds unless the taker may take it, and a release keeps the epoch", () => {
    let t = Date.parse("2026-10-17T00:00:00Z");
    const { a, b } = stores(() => new Date(t));
    created(a, "T-0001");
    const held = a.acquireLease("T-0001", "1@a", 1000, () => false);
    expect(() => b.acquireLease("T-0001", "2@b", 1000, () => false)).toThrow(LeaseHeldError);
    t += 5000;
    // Lapsed is not free: the taker must have stopped the holder (mayTake).
    expect(() => b.acquireLease("T-0001", "2@b", 1000, () => false)).toThrow(/lapsed, but its holder was not stopped/);
    a.releaseLease(a.renewLease(held, 1000));
    expect(b.acquireLease("T-0001", "2@b", 1000, (l) => l.expires_at === 0).epoch).toBe(2);
  });
});

describe("taking a lease over", () => {
  const home = factoryHome({ FACTORY_HOME: join(scratch, "home") });
  ensureHome(home);

  /** A stand-in holder: a live process this test owns. */
  async function holder(): Promise<{ pid: number; id: string }> {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    for (let i = 0; i < 50 && startTime(pid) === null; i++) await new Promise((r) => setTimeout(r, 20));
    return { pid, id: holderId({ pid, start_time: startTime(pid) }) };
  }

  it("refuses a live holder's lease, stops it when forced or when its lease lapsed, and takes a dead holder's", async () => {
    let t = Date.now();
    const store = EventStore.open(join(scratch, "take.db"), { now: () => new Date(t) });
    for (const id of ["T-0001", "T-0002", "T-0003"]) created(store, id);

    const live = await holder();
    store.acquireLease("T-0001", live.id, LEASE_TTL_MS, () => false);
    expect(leaseState(store.lease("T-0001"), t)).toBe("held");
    await expect(takeLease(home, store, "T-0001", { now: () => t })).rejects.toThrow(LeaseHeldError);
    expect(isLive({ pid: live.pid, start_time: null })).toBe(true);
    const forced = await takeLease(home, store, "T-0001", { force: true, now: () => t });
    expect(forced).toMatchObject({ epoch: 2, holder: holderId() });
    expect(isLive({ pid: live.pid, start_time: null })).toBe(false);

    // A hung holder: alive, but its lease lapsed. It is stopped before the new epoch.
    const hung = await holder();
    store.acquireLease("T-0002", hung.id, 1000, () => false);
    t += 5000;
    expect(leaseState(store.lease("T-0002"), t)).toBe("lapsed");
    expect((await takeLease(home, store, "T-0002", { now: () => t })).epoch).toBe(2);
    expect(isLive({ pid: hung.pid, start_time: null })).toBe(false);

    // A dead holder's lease is free.
    store.acquireLease("T-0003", "999999@gone", LEASE_TTL_MS, () => false);
    expect(leaseState(store.lease("T-0003"), t)).toBe("free");
    expect((await takeLease(home, store, "T-0003", { now: () => t })).epoch).toBe(2);
  }, 60_000);
});
