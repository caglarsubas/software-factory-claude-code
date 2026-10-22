// What a task's record references in the object store (ADR 0003), so a purge deletes an object
// only when no remaining task needs it. Objects are content-addressed and shared: two tasks with
// the same body share their task.md, and a file unchanged across runs is one object. Three
// writers put objects, and each names them in an event: a task's task_created files, each
// artifact_committed artifact, and each run's evidence_stored tree with every file in it. Unlike
// a restore, which wants the latest version of each file, this takes every version ever named.
import type { FactoryEvent } from "../store/events.ts";
import { hasObject, readTree } from "./objects.ts";

export interface TaskRefs {
  /** Every object the record names: files, artifacts, trees and the trees' files. */
  digests: Set<string>;
  /** The evidence trees it names, a subset of digests. */
  trees: Set<string>;
  /** Trees it names that the object store lacks: their files are unknown. */
  missingTrees: string[];
}

export function taskRefs(events: readonly FactoryEvent[], objects: string): TaskRefs {
  const refs: TaskRefs = { digests: new Set(), trees: new Set(), missingTrees: [] };
  for (const e of events) {
    if (e.type === "task_created") {
      for (const digest of Object.values((e.payload["files"] ?? {}) as Record<string, string>)) refs.digests.add(digest);
    } else if (e.type === "artifact_committed") {
      for (const a of (e.payload["artifacts"] ?? []) as { digest: string }[]) refs.digests.add(a.digest);
    } else if (e.type === "command" && e.payload["command"] === "evidence_stored" && typeof e.payload["tree"] === "string") {
      const tree = e.payload["tree"];
      refs.digests.add(tree);
      refs.trees.add(tree);
      if (!hasObject(objects, tree)) {
        refs.missingTrees.push(tree);
        continue;
      }
      for (const digest of Object.values(readTree(objects, tree).files)) refs.digests.add(digest);
    }
  }
  return refs;
}

export class RefsError extends Error {}

/**
 * The objects the purged tasks reference that no kept task does, trees last. A kept task whose
 * evidence tree is missing could need any object, so the whole plan stops: nothing is deleted on
 * a guess. `extra` adds digests the purged tasks hold outside their record (their run
 * directories' files, say), under the same rule.
 */
export function deletionSet(purged: readonly (readonly FactoryEvent[])[], kept: readonly (readonly FactoryEvent[])[], objects: string, extra: Iterable<string> = []): string[] {
  const keep = new Set<string>();
  const missing: string[] = [];
  for (const events of kept) {
    const r = taskRefs(events, objects);
    for (const d of r.digests) keep.add(d);
    missing.push(...r.missingTrees.map((t) => `${events[0]?.task_id ?? "?"}: ${t}`));
  }
  if (missing.length > 0) throw new RefsError(`a kept task's evidence tree is missing, so what it needs is unknown; nothing is deleted: ${missing.join(", ")}`);
  const leaves = new Set<string>();
  const trees = new Set<string>();
  for (const events of purged) {
    const r = taskRefs(events, objects);
    for (const d of r.digests) (r.trees.has(d) ? trees : leaves).add(d);
  }
  for (const d of extra) if (!trees.has(d)) leaves.add(d);
  const gone = (d: string): boolean => !keep.has(d) && hasObject(objects, d);
  return [...[...leaves].filter(gone).sort(), ...[...trees].filter(gone).sort()];
}
