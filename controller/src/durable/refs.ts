// What a task's record references in the object store (ADR 0003), so a purge deletes an object
// only when no remaining task needs it. Objects are content-addressed and shared: two tasks with
// the same body share their task.md, and a file unchanged across runs is one object. Three
// writers put objects, and each names them in an event: a task's task_created files, each
// artifact_committed artifact, and each run's evidence_stored tree with every file in it. Unlike
// a restore, which wants the latest version of each file, this takes every version ever named.
import type { FactoryEvent } from "../store/events.ts";
import { hasObject, readTree } from "./objects.ts";

/**
 * Retention's expiries (ADR 0003): a task's transcripts, or its whole bundle but task.json. Each
 * is recorded by an operator's `evidence_expired` command before anything is deleted, so every
 * store that holds the record (the home, the replica, a restore) deletes the same.
 */
export type ExpiryScope = "transcripts" | "bundle";

export const EVIDENCE_EXPIRED = "evidence_expired";

export function expiredScopes(events: readonly FactoryEvent[]): Set<ExpiryScope> {
  const scopes = new Set<ExpiryScope>();
  for (const e of events) {
    if (e.type === "command" && e.payload["command"] === EVIDENCE_EXPIRED) scopes.add(e.payload["scope"] as ExpiryScope);
  }
  return scopes;
}

/** Whether an expired scope covers a run-directory path (a tree, path null, is the bundle's). */
export function expires(scopes: ReadonlySet<ExpiryScope>, path: string | null): boolean {
  if (scopes.has("bundle")) return path !== "task.json";
  return scopes.has("transcripts") && path?.startsWith("transcripts/") === true;
}

/** One object a task's record names, at the run-directory path it was named for; a tree has none. */
export interface TaskFile {
  path: string | null;
  digest: string;
}

/**
 * Every object a task's record names, every version, by path. A tree the store lacks is listed in
 * missingTrees, its files unknown, unless the task's own bundle expiry deleted it.
 */
export function taskFiles(events: readonly FactoryEvent[], objects: string): { files: TaskFile[]; missingTrees: string[] } {
  const expired = expiredScopes(events).has("bundle");
  const files: TaskFile[] = [];
  const missingTrees: string[] = [];
  for (const e of events) {
    if (e.type === "task_created") {
      for (const [path, digest] of Object.entries((e.payload["files"] ?? {}) as Record<string, string>)) files.push({ path, digest });
    } else if (e.type === "artifact_committed") {
      for (const a of (e.payload["artifacts"] ?? []) as { path: string; digest: string }[]) files.push({ path: a.path, digest: a.digest });
    } else if (e.type === "command" && e.payload["command"] === "evidence_stored" && typeof e.payload["tree"] === "string") {
      const tree = e.payload["tree"];
      files.push({ path: null, digest: tree });
      if (!hasObject(objects, tree)) {
        if (!expired) missingTrees.push(tree);
        continue;
      }
      for (const [path, digest] of Object.entries(readTree(objects, tree).files)) files.push({ path, digest });
    }
  }
  return { files, missingTrees };
}

export interface TaskRefs {
  /** Every object the record names: files, artifacts, trees and the trees' files. */
  digests: Set<string>;
  /** The evidence trees it names, a subset of digests. */
  trees: Set<string>;
  /** What the task still holds: every digest but those its expired scopes cover. */
  live: Set<string>;
  /** Trees it names that the object store lacks: their files are unknown. */
  missingTrees: string[];
}

export function taskRefs(events: readonly FactoryEvent[], objects: string): TaskRefs {
  const { files, missingTrees } = taskFiles(events, objects);
  const scopes = expiredScopes(events);
  return {
    digests: new Set(files.map((f) => f.digest)),
    trees: new Set(files.filter((f) => f.path === null).map((f) => f.digest)),
    live: new Set(files.filter((f) => !expires(scopes, f.path)).map((f) => f.digest)),
    missingTrees,
  };
}

export class RefsError extends Error {}

/** What the kept tasks still hold; stops when any kept task's references are unknown. */
function keptDigests(kept: readonly (readonly FactoryEvent[])[], objects: string): Set<string> {
  const keep = new Set<string>();
  const missing: string[] = [];
  for (const events of kept) {
    const r = taskRefs(events, objects);
    for (const d of r.live) keep.add(d);
    missing.push(...r.missingTrees.map((t) => `${events[0]?.task_id ?? "?"}: ${t}`));
  }
  if (missing.length > 0) throw new RefsError(`a kept task's evidence tree is missing, so what it needs is unknown; nothing is deleted: ${missing.join(", ")}`);
  return keep;
}

/** Leaves sorted, then trees sorted. */
const treesLast = (digests: Iterable<string>, trees: ReadonlySet<string>): string[] => {
  const all = [...new Set(digests)];
  return [...all.filter((d) => !trees.has(d)).sort(), ...all.filter((d) => trees.has(d)).sort()];
};

/**
 * The objects retention may delete: what some task's expired scope names and no task still
 * holds, trees last. It stops, deleting nothing, while any task's references are unknown.
 */
export function expiredObjects(tasks: readonly (readonly FactoryEvent[])[], objects: string): string[] {
  const live = keptDigests(tasks, objects);
  const named = new Set<string>();
  const trees = new Set<string>();
  for (const events of tasks) {
    const scopes = expiredScopes(events);
    if (scopes.size === 0) continue;
    for (const f of taskFiles(events, objects).files) {
      if (!expires(scopes, f.path)) continue;
      named.add(f.digest);
      if (f.path === null) trees.add(f.digest);
    }
  }
  return treesLast([...named].filter((d) => !live.has(d) && hasObject(objects, d)), trees);
}

/**
 * The objects the purged tasks reference that no kept task does, trees last. A kept task whose
 * evidence tree is missing could need any object, so the whole plan stops: nothing is deleted on
 * a guess. `extra` adds digests the purged tasks hold outside their record (their run
 * directories' files, say), under the same rule.
 */
export function deletionSet(purged: readonly (readonly FactoryEvent[])[], kept: readonly (readonly FactoryEvent[])[], objects: string, extra: Iterable<string> = []): string[] {
  const keep = keptDigests(kept, objects);
  const leaves = new Set<string>();
  const trees = new Set<string>();
  for (const events of purged) {
    const r = taskRefs(events, objects);
    for (const d of r.digests) (r.trees.has(d) ? trees : leaves).add(d);
  }
  for (const d of extra) if (!trees.has(d)) leaves.add(d);
  return treesLast([...leaves, ...trees].filter((d) => !keep.has(d) && hasObject(objects, d)), trees);
}
