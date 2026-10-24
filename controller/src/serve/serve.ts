// `factoryctl serve` (ROADMAP P2-03): the scheduler, and the single writer the CLI talks to.
//
// One serve per $FACTORY_HOME (serve.lock, written like the run lock). Every second it reads the
// tasks, stops the holder of any lease that lapsed, and starts a worker (`factoryctl worker
// T-…`) for each eligible task, within the concurrency limit and never beside a task whose scope
// overlaps on the same target (sched/schedule.ts). A worker takes its task's lease itself and
// writes under it, in its own process group: killing serve leaves running workers running, and
// the next serve finds their leases held and leaves them be. `pause` stops issuing work;
// `drain` also lets running workers finish and then exits.
//
// Until the governance wiring (P2-05) turns on live runner sessions, serve runs replayed sessions
// only: unattended live sessions belong in the runner, each behind its gateway token (P2-02).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { parse } from "yaml";
import { readHalt } from "../halt.ts";
import { runDir, type Home } from "../home.ts";
import { isLive, self, type ProcRef } from "../proc.ts";
import { leaseState, stopHolder, takeLease } from "../sched/lease.ts";
import { nextTasks, waitsOnGitHub, type Ledger, type TaskView } from "../sched/schedule.ts";
import type { EventStore } from "../store/events.ts";
import { currentPriority, currentState, currentStatePayload, isPaused, isTerminal, transition } from "../task/lifecycle.ts";
import { readTask } from "../task/task.ts";
import { apiHandler, type ApiCommand } from "./api.ts";

export const DEFAULT_PORT = 7317;
const TICK_MS = 1000;
const PRIORITY: Record<string, number> = { high: 2, normal: 1, low: 0 };

export interface ServeLock extends ProcRef {
  host: string;
  port: number;
}

export class ServeError extends Error {}

export const serveLockPath = (home: Home): string => join(home.root, "serve.lock");
export const tokenPath = (home: Home): string => join(home.secrets, "serve.token");

export function readServeLock(home: Home): ServeLock | null {
  try {
    return JSON.parse(readFileSync(serveLockPath(home), "utf8")) as ServeLock;
  } catch {
    return null;
  }
}

/** The running serve, if any: while it lives, the CLI is its client. */
export function liveServe(home: Home): ServeLock | null {
  const l = readServeLock(home);
  return l !== null && isLive(l) ? l : null;
}

/** One serve per home: written in full, then linked into place; a dead serve's lock is replaced. */
export function acquireServeLock(home: Home, host: string, port: number): () => void {
  const path = serveLockPath(home);
  const mine = `${path}.${String(process.pid)}`;
  writeFileSync(mine, JSON.stringify({ ...self(), host, port }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, path);
        return () => {
          rmSync(path, { force: true });
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const holder = liveServe(home);
        if (holder !== null) throw new ServeError(`serve is already running (pid ${String(holder.pid)}, ${holder.host}:${String(holder.port)})`);
        rmSync(path, { force: true });
      }
    }
    throw new ServeError("could not take the serve lock");
  } finally {
    rmSync(mine, { force: true });
  }
}

/** The API token, made on first use; it lives with the other secrets, denied to every session. */
export function serveToken(home: Home): string {
  const path = tokenPath(home);
  if (!existsSync(path)) writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  return readFileSync(path, "utf8").trim();
}

/** Loopback, or a tailnet address (100.64.0.0/10); never a public or LAN interface. */
export function bindable(host: string): boolean {
  if (host === "127.0.0.1" || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  const [a = 0, b = 0] = host.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export interface ServeOptions {
  home: Home;
  store: EventStore;
  /** The factoryctl entry point workers run. */
  cli: string;
  maxTasks: number;
  host: string;
  port: number;
  /** Replayed sessions: each task's transcripts in `<replay>/<task>/`. Absent: live sessions, each in the runner container. */
  replay?: string;
  log: (line: string) => void;
}

interface Worker {
  pid: number;
  view: TaskView;
}

export interface Serve {
  server: Server;
  /** Resolves when serve has stopped: drained, or signalled. */
  done: Promise<void>;
  stop: () => void;
}

export async function startServe(o: ServeOptions): Promise<Serve> {
  if (!bindable(o.host)) throw new ServeError(`serve binds to loopback or a tailnet address only, not ${o.host}`);
  const release = acquireServeLock(o.home, o.host, o.port);
  const token = serveToken(o.home);
  const { home, store } = o;
  const workers = new Map<string, Worker>();
  const finished = new Map<string, number>();
  const polled = new Map<string, number>();
  let paused = false;
  let draining = false;
  let ticking = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const lastSeq = (id: string): number => store.events(id).at(-1)?.seq ?? 0;

  function view(id: string, now: number): TaskView | null {
    const events = store.events(id);
    if (events.length === 0) return null;
    let task;
    try {
      task = readTask(home, id);
    } catch {
      return null;
    }
    const target = task.target.repo;
    const priority = PRIORITY[currentPriority(task.priority, events)] ?? 1;
    let scope: string[] | null = null;
    try {
      scope = (parse(readFileSync(join(runDir(home, id), "spec.yaml"), "utf8")) as { scope: { include: string[] } }).scope.include;
    } catch {
      // No spec yet: the task overlaps everything on its target.
    }
    const gate = currentStatePayload(events)["gate"];
    return { id, target, state: currentState(events), gate: typeof gate === "string" ? gate : null, paused: isPaused(events), scope, priority, lastSeq: events.at(-1)?.seq ?? 0, lease: leaseState(store.lease(id), now) };
  }

  function startWorker(t: TaskView): void {
    const logFile = openSync(join(runDir(home, t.id), "worker.log"), "a", 0o600);
    // Unattended live sessions run only in the runner (P2-01), with gateway tokens (P2-02) under the governance wiring (P2-05).
    const sessions = o.replay === undefined ? ["--runner", "container"] : ["--replay", join(o.replay, t.id)];
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", o.cli, "worker", t.id, ...sessions], { detached: true, stdio: ["ignore", logFile, logFile], env: process.env });
    closeSync(logFile);
    const pid = child.pid;
    if (pid === undefined) {
      o.log(`${t.id}: could not start a worker`);
      return;
    }
    workers.set(t.id, { pid, view: t });
    if (waitsOnGitHub(t)) polled.set(t.id, Date.now());
    o.log(`${t.id}: worker ${String(pid)} started (${t.state})`);
    child.once("exit", (code, signal) => {
      workers.delete(t.id);
      finished.set(t.id, lastSeq(t.id));
      o.log(`${t.id}: worker ${String(pid)} ended (${signal ?? `exit ${String(code)}`}), ${currentState(store.events(t.id))}`);
    });
    child.unref();
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const views = store.taskIds().flatMap((id) => {
        const v = view(id, now);
        return v === null ? [] : [v];
      });
      // A lapsed lease whose holder still runs is a hung writer: stop it, so the task can run again.
      for (const v of views) {
        if (v.lease !== "lapsed") continue;
        const lease = store.lease(v.id);
        if (lease !== null) await stopHolder(home, lease, o.log);
      }
      const halted = readHalt(home) !== null;
      if (!paused && !draining && !halted) {
        const ledger: Ledger = { finished, polled };
        const running = [...workers.values()].map((w) => w.view);
        for (const t of nextTasks(views, running, o.maxTasks, ledger, now)) startWorker(t);
      }
      if (draining && workers.size === 0) stop();
    } catch (e) {
      o.log(`scheduler: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      ticking = false;
    }
  }

  async function command(c: ApiCommand): Promise<{ ok: boolean; message: string }> {
    const operator = { kind: "operator" as const, id: process.env["USER"] ?? "operator" };
    switch (c.command) {
      case "pause":
        paused = true;
        return { ok: true, message: "serve issues no new work until: factoryctl resume" };
      case "resume":
        paused = false;
        return { ok: true, message: "serve is issuing work again" };
      case "drain":
        draining = true;
        return { ok: true, message: `serve stops once its ${String(workers.size)} running task(s) end` };
      default:
        break;
    }
    const id = c.task ?? "";
    const events = store.events(id);
    if (events.length === 0) return { ok: false, message: `no task ${id}` };
    if (isTerminal(currentState(events))) return { ok: false, message: `${id} has already ended` };
    if (c.command === "task-pause") {
      if (isPaused(events)) return { ok: true, message: `${id} is already paused` };
      store.append({ task_id: id, actor: operator, type: "command", payload: { command: "pause", reason: c.reason ?? "no reason given" } });
      return { ok: true, message: workers.has(id) ? `${id} pauses at its next step boundary` : `${id} paused` };
    }
    if (c.command === "priority") {
      let recorded;
      try {
        recorded = readTask(home, id).priority;
      } catch {
        return { ok: false, message: `${id} has no task record in its run directory` };
      }
      const now = currentPriority(recorded, events);
      if (c.priority === undefined || c.priority === now) return { ok: true, message: `${id} is already at ${now} priority` };
      store.append({ task_id: id, actor: operator, type: "command", payload: { command: "priority", priority: c.priority, from: now, ...(c.reason === undefined ? {} : { reason: c.reason }) } });
      return { ok: true, message: `${id}: priority ${now} → ${c.priority}` };
    }
    if (c.command === "task-resume") {
      if (isPaused(events)) store.append({ task_id: id, actor: operator, type: "command", payload: { command: "unpause" } });
      finished.delete(id);
      return { ok: true, message: `${id} is eligible again` };
    }
    // cancel: the command first (a running worker then stops without failing the task), then the lease, which stops it.
    store.append({ task_id: id, actor: operator, type: "command", payload: { command: "cancel" } });
    const lease = await takeLease(home, store, id, { force: true, log: o.log });
    try {
      transition(store, id, "CANCELLED", { by: operator.id });
    } finally {
      store.releaseLease(lease);
    }
    return { ok: true, message: `${id} CANCELLED` };
  }

  function status(): unknown {
    const now = Date.now();
    return {
      serve: { pid: process.pid, host: o.host, port: o.port, paused, draining, halted: readHalt(home) !== null, max_tasks: o.maxTasks, workers: [...workers.entries()].map(([task, w]) => ({ task, pid: w.pid })) },
      tasks: store.taskIds().flatMap((id) => {
        const v = view(id, now);
        return v === null ? [] : [{ id: v.id, state: v.state, gate: v.gate, paused: v.paused, priority: v.priority, lease: v.lease, epoch: store.lease(id)?.epoch ?? 0, running: workers.has(id) }];
      }),
    };
  }

  const hosts = o.host === "127.0.0.1" ? [`127.0.0.1:${String(o.port)}`, `localhost:${String(o.port)}`] : [`${o.host.includes(":") ? `[${o.host}]` : o.host}:${String(o.port)}`];
  const server = createServer(apiHandler({ token, hosts, status, command }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      resolve();
    });
  });
  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  let stopped = false;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    server.close();
    release();
    o.log("serve stopped");
    resolveDone();
  }
  void tick();
  return { server, done, stop };
}
