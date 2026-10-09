// $FACTORY_HOME (default ~/.factory): run state lives outside every repository (ROADMAP §2.4).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Home {
  root: string;
  db: string;
  runs: string;
  worktrees: string;
  mirrors: string;
  /** Per-task CLAUDE_CONFIG_DIR, HOME and TMPDIR for sessions. */
  sessions: string;
  /** Operator-provided credentials (the API key file); denied to every session. */
  secrets: string;
  /** Installed, read-only factory releases (`releases/<sha>`), and the operator's pin to one of them. */
  releases: string;
  current: string;
  bin: string;
  lock: string;
  /** The kill switch (halt.ts): while this file exists, no session acts and no run starts. */
  halt: string;
  /** Gate evidence drafted by `factoryctl gate` (`gates/<gate>/`). */
  gates: string;
}

export function factoryHome(env: NodeJS.ProcessEnv = process.env): Home {
  const root = env["FACTORY_HOME"] ?? join(homedir(), ".factory");
  return {
    root,
    db: join(root, "factory.db"),
    runs: join(root, "runs"),
    worktrees: join(root, "worktrees"),
    mirrors: join(root, "mirrors"),
    sessions: join(root, "sessions"),
    secrets: join(root, "secrets"),
    releases: join(root, "releases"),
    current: join(root, "current"),
    bin: join(root, "bin"),
    lock: join(root, "run.lock"),
    halt: join(root, "HALT"),
    gates: join(root, "gates"),
  };
}

export function ensureHome(home: Home): void {
  for (const dir of [home.root, home.runs, home.worktrees, home.mirrors, home.sessions, home.secrets, home.releases]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export const runDir = (home: Home, taskId: string): string => join(home.runs, taskId);
export const worktreeDir = (home: Home, taskId: string): string => join(home.worktrees, taskId);
export const sessionDir = (home: Home, taskId: string): string => join(home.sessions, taskId);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LockError extends Error {}

/** One task at a time (P0): an exclusive lock file holding the runner's pid and task. A dead holder's lock is stale. */
export function acquireRunLock(home: Home, taskId: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(home.lock, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, task_id: taskId }));
      closeSync(fd);
      return () => {
        rmSync(home.lock, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readLock(home);
      if (holder !== null && alive(holder.pid)) throw new LockError(`${holder.task_id} is running (pid ${String(holder.pid)}); one task at a time`);
      rmSync(home.lock, { force: true });
    }
  }
  throw new LockError("could not take the run lock");
}

export function readLock(home: Home): { pid: number; task_id: string } | null {
  if (!existsSync(home.lock)) return null;
  try {
    return JSON.parse(readFileSync(home.lock, "utf8")) as { pid: number; task_id: string };
  } catch {
    return null;
  }
}
