// The preflight broker (ROADMAP P2-01). On the host, the builder's Stop hook runs the gate runner
// itself; inside the runner it cannot, because the gates need the container engine and the
// engine's socket would hand the session the host. So the hook asks instead: it writes a request
// (a nonce and nothing else) into the session's request spool and waits for the answer in the
// result spool, which the runner mounts read-only. factoryctl, on the host, runs the same
// preflight command it would have given the hook, on the worktree's committed HEAD, and writes
// the answer. No argv, path or option ever comes from the session.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../fsutil.ts";

export interface BrokerSpool {
  /** The runner writes requests here (mounted read-write). */
  requests: string;
  /** factoryctl writes answers here (mounted read-only in the runner). */
  results: string;
}

export interface PreflightResult {
  schema_version: 1;
  status: "pass" | "fail";
  /** Why it failed and the end of its output; empty when it passed. */
  output: string;
}

export const REQUEST = /^[a-z0-9-]{8,64}\.json$/;
const POLL_MS = 500;
const OUTPUT_TAIL = 4000;

export function makeSpool(dir: string): BrokerSpool {
  const spool = { requests: join(dir, "requests"), results: join(dir, "results") };
  for (const d of [spool.requests, spool.results]) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  return spool;
}

/** Runs one preflight: the argv factoryctl built, in its own environment, with a time limit. */
export function runPreflight(argv: readonly string[], cwd: string, timeoutMs: number): Promise<PreflightResult> {
  const [cmd = "", ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (d: Buffer): void => {
      out = (out + d.toString("utf8")).slice(-OUTPUT_TAIL * 4);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const done = (why: string | null): void => {
      clearTimeout(timer);
      resolve({ schema_version: 1, status: why === null ? "pass" : "fail", output: why === null ? "" : `${why}\n${out.trim().slice(-OUTPUT_TAIL)}`.trim() });
    };
    child.on("error", (e) => {
      done(e.message);
    });
    child.on("close", (code, signal) => {
      done(code === 0 ? null : signal === "SIGKILL" ? `timed out after ${String(timeoutMs / 1000)} s` : `exit ${String(code)}`);
    });
  });
}

/**
 * Answers the spool's requests, one at a time, until stopped. A request is answered once and
 * then removed; anything in the spool that is not a request is removed unanswered.
 */
export function startBroker(spool: BrokerSpool, run: () => Promise<PreflightResult>): { stop: () => Promise<void> } {
  let stopped = false;
  let busy: Promise<void> = Promise.resolve();
  const tick = (): void => {
    if (stopped || !existsSync(spool.requests)) return;
    for (const f of readdirSync(spool.requests)) {
      rmSync(join(spool.requests, f), { recursive: true, force: true });
      if (!REQUEST.test(f)) continue;
      busy = busy.then(async () => {
        if (stopped) return;
        const result = await run();
        // Readable by the runner whatever its uid; an answer holds a pass or the end of the gates' output, never a secret.
        writeAtomic(join(spool.results, f), `${JSON.stringify(result)}\n`, 0o644);
      });
    }
  };
  const timer = setInterval(tick, POLL_MS);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await busy;
    },
  };
}
