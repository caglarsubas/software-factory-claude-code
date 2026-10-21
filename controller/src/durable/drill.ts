// The kill switch and the drills (ROADMAP P2-07, G2-6). Both drills run on the operator's own
// system and write a record under `$FACTORY_HOME/drills/`, which the G2 evidence reads.
//
// - The kill-switch drill halts the factory exactly as `factoryctl halt` does, then times how
//   long until no agent activity is left on the host: no live lease holder or attended run, no
//   session process, no runner or gate container. It passes within 5 minutes and leaves the
//   factory halted.
// - The restore drill restores the replica, as it stands, into a scratch home and times it
//   (RTO). It compares the restored store with the live one: the events the replica lacked, and
//   how long before the live store's newest event the replica's newest was (RPO), and checks
//   that every file a restored task's record names came back with its digest.
// - The serve-kill drill (G2-3) SIGKILLs a serve that holds at least three live tasks and records
//   them; the G2 evidence then checks that each finished without a duplicate side effect.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE, killGateContainers, LABEL as GATES_LABEL } from "../../../gates/src/container.ts";
import { fileDigest, writeAtomic } from "../fsutil.ts";
import { describeHalt, setHalt, type Halt } from "../halt.ts";
import { factoryHome, liveHolder, runDir, type Home } from "../home.ts";
import { children, isLive } from "../proc.ts";
import { killRunnerContainers, listContainers } from "../runner/container.ts";
import { parseHolder } from "../sched/lease.ts";
import { liveServe } from "../serve/serve.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import { readReplicaConfig, restore, runFiles } from "./replica.ts";

export const KILL_SWITCH_LIMIT_MS = 5 * 60_000;
export const RPO_LIMIT_MS = 60_000;
export const RTO_LIMIT_MS = 60 * 60_000;

/**
 * The kill switch: the HALT file first, then every writer signalled and every container
 * stopped. Returns what it did, as lines for the operator.
 */
export function haltNow(home: Home, by: string, reason: string): { halt: Halt; lines: string[] } {
  const halt = setHalt(home, by, reason);
  const lines = [`factory ${describeHalt(halt)}`];
  // Only a runner that is still the process it was: a reused pid is someone else's.
  const lock = liveHolder(home);
  if (lock !== null) {
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch {
      // The runner already exited.
    }
  }
  // serve's workers (P2-03) hold leases, not the run lock: signal every live lease holder too.
  let workers = 0;
  try {
    const store = EventStore.open(home.db);
    try {
      if (lock !== null) store.append({ task_id: lock.task_id, actor: { kind: "operator", id: by }, type: "command", payload: { command: "halt", reason } });
      for (const l of store.leases()) {
        const p = parseHolder(l.holder);
        if (p === null || !isLive(p) || p.pid === lock?.pid) continue;
        try {
          process.kill(p.pid, "SIGTERM");
          workers++;
        } catch {
          // Gone.
        }
      }
    } finally {
      store.close();
    }
  } catch {
    // The store may not exist yet; nothing holds a lease then.
  }
  const containers = killGateContainers();
  const runners = killRunnerContainers();
  lines.push(lock === null ? "no attended task was running" : `signalled ${lock.task_id} (pid ${String(lock.pid)}); it stops without failing and resumes later`);
  if (workers > 0) lines.push(`signalled ${String(workers)} serve worker(s); their tasks stop without failing`);
  lines.push(`${String(containers)} gate container(s) and ${String(runners.length)} runner container(s) stopped`);
  return { halt, lines };
}

/** What still runs on this host for the factory. */
export interface Activity {
  writers: number;
  sessions: number;
  runners: number;
  gates: number;
}

export function activity(home: Home): Activity {
  let writers = liveHolder(home) === null ? 0 : 1;
  try {
    const store = EventStore.open(home.db);
    try {
      writers += store.leases().filter((l) => {
        const p = parseHolder(l.holder);
        return p !== null && l.expires_at > 0 && isLive(p);
      }).length;
    } finally {
      store.close();
    }
  } catch {
    // No store: no leases.
  }
  const sessions = children(home).filter((c) => isLive(c)).length;
  const gates = spawnSync(ENGINE, ["ps", "--quiet", "--filter", `label=${GATES_LABEL}`], { encoding: "utf8" });
  return { writers, sessions, runners: listContainers().length, gates: gates.status === 0 ? gates.stdout.split("\n").filter((l) => l !== "").length : 0 };
}

const idle = (a: Activity): boolean => a.writers + a.sessions + a.runners + a.gates === 0;

const drillsDir = (home: Home): string => join(home.root, "drills");

function record(home: Home, kind: string, data: Record<string, unknown>, now: Date): string {
  const dir = drillsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${kind}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
  writeAtomic(path, `${JSON.stringify({ schema_version: 1, kind, at: now.toISOString(), ...data }, null, 2)}\n`);
  return path;
}

export interface KillSwitchDrill {
  passed: boolean;
  before: Activity;
  after: Activity;
  stopped_ms: number;
  record: string;
  lines: string[];
}

export async function killSwitchDrill(home: Home, by: string, o: { limitMs?: number; pollMs?: number } = {}): Promise<KillSwitchDrill> {
  const limit = o.limitMs ?? KILL_SWITCH_LIMIT_MS;
  const started = new Date();
  const before = activity(home);
  const { lines } = haltNow(home, by, "kill-switch drill");
  let after = activity(home);
  while (!idle(after) && Date.now() - started.getTime() < limit) {
    await new Promise((r) => setTimeout(r, o.pollMs ?? 250));
    after = activity(home);
  }
  const stopped = Date.now() - started.getTime();
  const passed = idle(after) && stopped <= limit;
  const path = record(home, "kill-switch", { passed, limit_ms: limit, stopped_ms: stopped, before, after }, started);
  return { passed, before, after, stopped_ms: stopped, record: path, lines };
}

export interface RestoreDrill {
  passed: boolean;
  rto_ms: number;
  /** How far the replica's newest event was behind the live store's newest; 0 when it had them all. */
  rpo_ms: number;
  lag_events: number;
  tasks: number;
  events: number;
  files: number;
  /** Files a restored task's record names that did not come back with their digest. */
  damaged: string[];
  record: string;
}

const newest = (events: readonly FactoryEvent[]): number => events.reduce((m, e) => Math.max(m, Date.parse(e.ts)), 0);

export async function restoreDrill(home: Home, o: { scratch?: string; keep?: boolean } = {}): Promise<RestoreDrill> {
  const config = readReplicaConfig(home);
  if (config === null) throw new Error("no replica is set: factoryctl replica init DIR");
  const started = new Date();
  const scratch = o.scratch ?? mkdtempSync(join(tmpdir(), "sf-restore-drill-"));
  const target = factoryHome({ FACTORY_HOME: join(scratch, "home") });
  try {
    const t0 = Date.now();
    const restored = await restore(config.path, target);
    const rto = Date.now() - t0;
    const live = EventStore.open(home.db);
    const back = EventStore.open(target.db);
    let lag = 0;
    let liveNewest = 0;
    let backNewest = 0;
    const damaged: string[] = [...restored.missing];
    try {
      for (const id of live.taskIds()) {
        const mine = live.events(id);
        const theirs = back.events(id);
        lag += mine.length - theirs.length;
        liveNewest = Math.max(liveNewest, newest(mine));
        backNewest = Math.max(backNewest, newest(theirs));
        // What the replica has must be exactly what the live store had.
        theirs.forEach((e, i) => {
          if (JSON.stringify(e) !== JSON.stringify(mine[i])) damaged.push(`${id} event ${String(e.seq)}`);
        });
        for (const [path, digest] of runFiles(theirs, target.objects)) {
          const file = join(runDir(target, id), path);
          if (!existsSync(file) || fileDigest(file) !== digest) damaged.push(`${id}/${path}`);
        }
      }
    } finally {
      live.close();
      back.close();
    }
    const rpo = lag === 0 ? 0 : Math.max(0, liveNewest - backNewest);
    const passed = damaged.length === 0 && rto <= RTO_LIMIT_MS && rpo <= RPO_LIMIT_MS;
    const path = record(home, "restore", { passed, rto_ms: rto, rpo_ms: rpo, rto_limit_ms: RTO_LIMIT_MS, rpo_limit_ms: RPO_LIMIT_MS, lag_events: lag, tasks: restored.tasks, events: restored.events, files: restored.files, damaged, replica: config.path, replica_synced_at: restored.synced_at }, started);
    return { passed, rto_ms: rto, rpo_ms: rpo, lag_events: lag, tasks: restored.tasks, events: restored.events, files: restored.files, damaged, record: path };
  } finally {
    if (o.keep !== true) rmSync(scratch, { recursive: true, force: true });
  }
}

/** A drill's record, as `drills/<kind>-<time>.json` holds it. */
export interface DrillRecord {
  kind: string;
  at: string;
  path: string;
  data: Record<string, unknown>;
}

/** Every drill record, oldest first. */
export function readDrills(home: Home): DrillRecord[] {
  const dir = drillsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .flatMap((n): DrillRecord[] => {
      try {
        const data = JSON.parse(readFileSync(join(dir, n), "utf8")) as Record<string, unknown>;
        return typeof data["kind"] === "string" && typeof data["at"] === "string" ? [{ kind: data["kind"], at: data["at"], path: join(dir, n), data }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

export const SERVE_KILL_MIN_TASKS = 3;

export interface ServeKillDrill {
  killed: boolean;
  serve_pid: number;
  tasks: { task: string; epoch: number }[];
  record: string;
}

/** The tasks live workers hold leases on: what serve was running. */
function heldTasks(home: Home): { task: string; epoch: number }[] {
  const store = EventStore.open(home.db);
  try {
    return store.leases().filter((l) => {
      const p = parseHolder(l.holder);
      return p !== null && l.expires_at > 0 && isLive(p);
    }).map((l) => ({ task: l.task_id, epoch: l.epoch }));
  } finally {
    store.close();
  }
}

/** SIGKILLs serve while it runs at least three tasks, and records which; the tasks' workers are left running. */
export async function serveKillDrill(home: Home, o: { minTasks?: number; waitMs?: number } = {}): Promise<ServeKillDrill> {
  const serve = liveServe(home);
  if (serve === null) throw new Error("serve is not running: start it with factoryctl serve and wait until it runs three tasks");
  const tasks = heldTasks(home);
  const min = o.minTasks ?? SERVE_KILL_MIN_TASKS;
  if (tasks.length < min) throw new Error(`serve runs ${String(tasks.length)} task(s); the drill needs ${String(min)} at once`);
  const started = new Date();
  process.kill(serve.pid, "SIGKILL");
  const deadline = Date.now() + (o.waitMs ?? 10_000);
  while (isLive(serve) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const killed = !isLive(serve);
  const path = record(home, "serve-kill", { killed, serve_pid: serve.pid, tasks }, started);
  return { killed, serve_pid: serve.pid, tasks, record: path };
}
