// Test-only injection for `factoryctl run|resume --replay DIR` (ROADMAP P1-02, the kill-point
// suite). A replay directory may hold `replay.json`:
//
//   { "kill_at": "build:session",                     SIGKILL this process at that probe point
//     "gates": { "gates": { "passed": true, ... } } }  gate results by step label, no containers
//
// Neither exists without --replay, and replayed gates are refused unless nothing can leave the
// machine: the task's remote must be a local path, and the GitHub API, if a token is set, a
// loopback address.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateEntry, GatesResult } from "../../../gates/src/run.ts";
import type { Deps } from "../stages/pipeline.ts";

export interface Injection {
  kill_at?: string;
  gates?: Record<string, { passed: boolean; gates: GateEntry[] }>;
}

export function readInjection(replayDir: string): Injection {
  const path = join(replayDir, "replay.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Injection) : {};
}

/** A path on this machine, not a URL or an scp-style `host:path`. */
export const isLocalRemote = (remote: string): boolean => remote.startsWith("/") && !remote.includes("@");

/** The probe that ends this process, unannounced, at one named point. */
export function killAt(point: string | undefined): ((p: string) => void) | undefined {
  if (point === undefined) return undefined;
  return (p) => {
    if (p === point) process.kill(process.pid, "SIGKILL");
  };
}

/** Gate results by label; a label with no entry passes. The candidate is the worktree's HEAD, as the real runner reports it. */
export function replayedGates(results: NonNullable<Injection["gates"]>): Deps["runGates"] {
  return (o, label) => {
    const r = results[label] ?? { passed: true, gates: [{ name: "test", status: "pass", duration_ms: 1, summary: "replayed" }] };
    const head = spawnSync("git", ["-C", o.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const result: GatesResult = { schema_version: 1, task_id: o.taskId, candidate_commit: head, passed: r.passed, gates: r.gates, signals: { sink_added: [], secret_material: false } };
    return Promise.resolve(result);
  };
}
