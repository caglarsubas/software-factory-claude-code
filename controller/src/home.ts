// $FACTORY_HOME (default ~/.factory): run state lives outside every repository (ROADMAP §2.4).
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLive, self, type ProcRef } from "./proc.ts";

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
  /** Gateway session tokens (P2-02), one file per live session while it runs; denied to every session. */
  tokens: string;
  /** The content-addressed object store (P2-07): every committed artifact and every run's evidence, by digest. */
  objects: string;
  /** Where the replica lives (P2-07), once the operator sets one: `factoryctl replica init <dir>`. */
  replicaConfig: string;
  /** Installed, read-only factory releases (`releases/<sha>`), and the operator's pin to one of them. */
  releases: string;
  current: string;
  bin: string;
  lock: string;
  /** The kill switch (halt.ts): while this file exists, no session acts and no run starts. */
  halt: string;
  /** Gate evidence drafted by `factoryctl gate` (`gates/<gate>/`). */
  gates: string;
  /** Purge journals (ADR 0003): a purge that stopped part-way resumes from its journal here. */
  purges: string;
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
    tokens: join(root, "tokens"),
    objects: join(root, "objects"),
    replicaConfig: join(root, "replica.json"),
    releases: join(root, "releases"),
    current: join(root, "current"),
    bin: join(root, "bin"),
    lock: join(root, "run.lock"),
    halt: join(root, "HALT"),
    gates: join(root, "gates"),
    purges: join(root, "purges"),
  };
}

export function ensureHome(home: Home): void {
  for (const dir of [home.root, home.runs, home.worktrees, home.mirrors, home.sessions, home.secrets, home.tokens, home.objects, home.releases]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export const runDir = (home: Home, taskId: string): string => join(home.runs, taskId);
export const worktreeDir = (home: Home, taskId: string): string => join(home.worktrees, taskId);
export const sessionDir = (home: Home, taskId: string): string => join(home.sessions, taskId);

export class LockError extends Error {}

export interface RunLock extends ProcRef {
  task_id: string;
}

/**
 * One task at a time: a lock file naming the runner (pid and start time) and its task. It is
 * written in full under a private name and then hard-linked into place, so it appears atomically
 * and a reader never sees a half-written lock. A lock whose process is gone, or whose pid now
 * names another process, is stale: it is replaced, and returned so the caller can clean up after
 * the run that died.
 */
export function acquireRunLock(home: Home, taskId: string): { release: () => void; stale: RunLock | null } {
  const mine = `${home.lock}.${String(process.pid)}`;
  writeFileSync(mine, JSON.stringify({ ...self(), task_id: taskId }), { mode: 0o600 });
  let stale: RunLock | null = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, home.lock);
        return {
          release: () => {
            rmSync(home.lock, { force: true });
          },
          stale,
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const holder = readLock(home);
        if (holder !== null && isLive(holder)) throw new LockError(`${holder.task_id} is running (pid ${String(holder.pid)}); one task at a time`);
        stale = holder;
        rmSync(home.lock, { force: true });
      }
    }
    throw new LockError("could not take the run lock");
  } finally {
    rmSync(mine, { force: true });
  }
}

export function readLock(home: Home): RunLock | null {
  if (!existsSync(home.lock)) return null;
  try {
    const l = JSON.parse(readFileSync(home.lock, "utf8")) as { pid: number; start_time?: string | null; task_id: string };
    return { pid: l.pid, start_time: l.start_time ?? null, task_id: l.task_id };
  } catch {
    return null;
  }
}

/** The lock's holder while it is still running: the only process halt, cancel and reject may signal. */
export function liveHolder(home: Home): RunLock | null {
  const lock = readLock(home);
  return lock !== null && isLive(lock) ? lock : null;
}
