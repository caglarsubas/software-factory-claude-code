// The artifact commit protocol (ROADMAP P1-02, principle 10). A step's outputs are staged as
// `.pending` files, committed by one `artifact_committed` event that records their digests and
// the digests of the step's inputs, then moved into place. The event is the commit point:
//
//   - a step is done when its latest commit was made from the inputs it has now, and every file
//     it committed is on disk with the committed digest;
//   - recovery rolls a `.pending` file forward when a commit lists it, and deletes it otherwise.
//
// So a crash at any instant leaves a step either committed or not, never half-written, and a
// changed input re-runs every step downstream of it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileDigest, finalize, PENDING, sha256, TMP, writeAtomic } from "../fsutil.ts";
import type { EventStore, FactoryEvent } from "../store/events.ts";

export interface Output {
  /** Relative to the run directory. */
  path: string;
  content: string | Buffer;
}

export interface Commit {
  stage: string;
  label: string;
  round: number;
  attempt: number;
  input_digest: string;
  inputs: Record<string, string>;
  artifacts: { path: string; digest: string }[];
}

/** The digests of a step's input files; a missing input is recorded as such, so it never matches a commit. */
export function inputsOf(dir: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries([...paths].sort().map((p) => [p, existsSync(join(dir, p)) ? fileDigest(join(dir, p)) : "missing"]));
}

export function inputDigest(inputs: Record<string, string>): string {
  return sha256(JSON.stringify(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))));
}

const commits = (events: readonly FactoryEvent[]): Commit[] => events.filter((e) => e.type === "artifact_committed").map((e) => e.payload as unknown as Commit);

export function latestCommit(events: readonly FactoryEvent[], label: string): Commit | null {
  return commits(events).findLast((c) => c.label === label) ?? null;
}

export type Freshness = "done" | "never" | "inputs_changed" | "artifact_changed";

/** Why a step must run, or "done". */
export function freshness(dir: string, events: readonly FactoryEvent[], label: string, inputs: Record<string, string>): Freshness {
  const c = latestCommit(events, label);
  if (c === null) return "never";
  if (c.input_digest !== inputDigest(inputs)) return "inputs_changed";
  const intact = c.artifacts.every((a) => existsSync(join(dir, a.path)) && fileDigest(join(dir, a.path)) === a.digest);
  return intact ? "done" : "artifact_changed";
}

/** Whether a file on disk is the one its latest commit recorded: only such files feed decisions. */
export function isCommitted(dir: string, events: readonly FactoryEvent[], path: string): boolean {
  const c = commits(events).findLast((x) => x.artifacts.some((a) => a.path === path));
  const digest = c?.artifacts.find((a) => a.path === path)?.digest;
  return digest !== undefined && existsSync(join(dir, path)) && fileDigest(join(dir, path)) === digest;
}

export interface StepRef {
  taskId: string;
  stage: string;
  label: string;
  round: number;
}

/** Stage, commit, finalize. Returns the commit event's payload. `probe` marks the instants between (kill-point tests). */
export function commitArtifacts(store: EventStore, dir: string, step: StepRef, inputs: Record<string, string>, outputs: readonly Output[], probe: (point: string) => void = () => undefined): Commit {
  if (outputs.length === 0) throw new Error(`${step.label} committed no artifacts`);
  for (const o of outputs) {
    mkdirSync(dirname(join(dir, o.path)), { recursive: true, mode: 0o700 });
    writeAtomic(join(dir, `${o.path}${PENDING}`), o.content);
  }
  probe(`${step.label}:staged`);
  const attempt = commits(store.events(step.taskId)).filter((c) => c.label === step.label && c.round === step.round).length + 1;
  const commit: Commit = {
    stage: step.stage,
    label: step.label,
    round: step.round,
    attempt,
    input_digest: inputDigest(inputs),
    inputs,
    artifacts: outputs.map((o) => ({ path: o.path, digest: sha256(o.content) })),
  };
  store.append({ task_id: step.taskId, actor: { kind: "factoryctl", id: "factoryctl" }, type: "artifact_committed", payload: { ...commit } });
  probe(`${step.label}:committed`);
  for (const o of outputs) finalize(join(dir, o.path));
  return commit;
}

function walk(root: string, dir: string = root): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(root, full) : [relative(root, full)];
  });
}

/**
 * Finishes or undoes what a crash interrupted: a `.pending` file whose digest the latest
 * commit of its path lists is moved into place; any other `.pending` file, and every
 * temporary file of an interrupted atomic write, is deleted.
 */
export function recover(dir: string, events: readonly FactoryEvent[]): { rolledForward: string[]; removed: string[] } {
  const committed = new Map<string, string>();
  for (const c of commits(events)) for (const a of c.artifacts) committed.set(a.path, a.digest);
  const rolledForward: string[] = [];
  const removed: string[] = [];
  for (const rel of walk(dir)) {
    const full = join(dir, rel);
    if (TMP.test(rel)) {
      rmSync(full, { force: true });
      removed.push(rel);
    } else if (rel.endsWith(PENDING)) {
      const path = rel.slice(0, -PENDING.length);
      if (committed.get(path) === sha256(readFileSync(full))) {
        finalize(join(dir, path));
        rolledForward.push(path);
      } else {
        rmSync(full, { force: true });
        removed.push(rel);
      }
    }
  }
  return { rolledForward, removed };
}

/** What a spec approval is bound to: both spec files, so a re-run spec reopens the gate. */
export function specDigest(dir: string): string {
  return sha256(["spec.yaml", "spec.md"].map((f) => (existsSync(join(dir, f)) ? fileDigest(join(dir, f)) : "missing")).join("\n"));
}
