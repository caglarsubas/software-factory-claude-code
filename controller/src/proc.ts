// Processes factoryctl owns (ROADMAP P1-02). A pid alone does not name a process: the system
// reuses pids, so a stale run lock or a stale child entry could point at an unrelated process.
// Each one is named by its pid and its start time, and only a process that still has both is
// signalled.
//
// Every session process runs in its own process group (sessionSpawner, the SDK's
// spawnClaudeCodeProcess) and is registered under $FACTORY_HOME/procs while it lives. A run that
// dies without cleaning up (SIGKILL, a crash, a power loss) leaves its groups behind; reap()
// kills the groups whose owner is gone, the next time a run starts.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { writeAtomic } from "./fsutil.ts";
import type { Home } from "./home.ts";

export interface ProcRef {
  pid: number;
  /** Opaque, from the system; null for a lock written before start times were recorded. */
  start_time: string | null;
}

export interface ChildEntry extends ProcRef {
  task_id: string;
  label: string;
  /** The factoryctl run that started it. */
  owner: ProcRef;
}

const PROC = "/proc";
const GRACE_MS = 5000;

/**
 * When the process started, or null when no such process is running. A zombie (exited, not yet
 * collected by its parent) counts as not running.
 */
export function startTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (existsSync(join(PROC, "self", "stat"))) {
    try {
      // Fields after the parenthesised command name: state is the 1st, starttime the 20th.
      const stat = readFileSync(join(PROC, String(pid), "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[0] === "Z" || fields[0] === "X" ? null : (fields[19] ?? null);
    } catch {
      return null;
    }
  }
  // macOS and other systems without /proc.
  const r = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8" });
  const line = r.status === 0 ? r.stdout.trim() : "";
  if (line === "" || line.startsWith("Z")) return null;
  return line.slice(line.indexOf(" ") + 1).trim();
}

export function self(): ProcRef {
  return { pid: process.pid, start_time: startTime(process.pid) };
}

/** Whether the process this names is still the one running. A reference without a start time falls back to the pid. */
export function isLive(p: ProcRef): boolean {
  const now = startTime(p.pid);
  return now !== null && (p.start_time === null || p.start_time === now);
}

const procsDir = (home: Home): string => join(home.root, "procs");

function register(home: Home, entry: ChildEntry): string {
  mkdirSync(procsDir(home), { recursive: true, mode: 0o700 });
  const path = join(procsDir(home), `${String(entry.pid)}.json`);
  writeAtomic(path, JSON.stringify(entry));
  return path;
}

export function children(home: Home): ChildEntry[] {
  if (!existsSync(procsDir(home))) return [];
  return readdirSync(procsDir(home)).filter((f) => /^[0-9]+\.json$/.test(f)).flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(procsDir(home), f), "utf8")) as ChildEntry];
    } catch {
      // A torn entry from a crash mid-write is not one writeAtomic leaves; drop it.
      rmSync(join(procsDir(home), f), { force: true });
      return [];
    }
  });
}

function killGroup(p: ProcRef, signal: NodeJS.Signals): void {
  if (!isLive(p)) return;
  try {
    process.kill(-p.pid, signal);
  } catch {
    try {
      process.kill(p.pid, signal);
    } catch {
      // Gone between the check and the signal.
    }
  }
}

/**
 * The SDK's spawnClaudeCodeProcess for one session: the process leads its own group, so the
 * group can be killed whole, and is registered until it exits. The SDK aborts the signal only
 * after its own graceful close; whatever is left then is terminated, then killed.
 */
export function sessionSpawner(home: Home, taskId: string, label: string): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], detached: true, windowsHide: true });
    const pid = child.pid;
    if (pid === undefined) return child;
    const ref: ProcRef = { pid, start_time: startTime(pid) };
    const entry = register(home, { ...ref, task_id: taskId, label, owner: self() });
    const onAbort = (): void => {
      killGroup(ref, "SIGTERM");
      setTimeout(() => {
        killGroup(ref, "SIGKILL");
      }, GRACE_MS).unref();
    };
    o.signal.addEventListener("abort", onAbort, { once: true });
    child.once("exit", () => {
      o.signal.removeEventListener("abort", onAbort);
      // The leader is gone; nothing it started may outlive it. While a group has members its id
      // is never reused as a pid, so this signal reaches only them.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // No member left.
      }
      rmSync(entry, { force: true });
    });
    return child;
  };
}

/** Kills every registered process group whose owning run is gone; returns what it reaped. */
export function reap(home: Home): ChildEntry[] {
  const reaped: ChildEntry[] = [];
  for (const c of children(home)) {
    if (isLive(c.owner)) continue;
    if (isLive(c)) {
      killGroup(c, "SIGKILL");
      reaped.push(c);
    }
    rmSync(join(procsDir(home), `${String(c.pid)}.json`), { force: true });
  }
  return reaped;
}
