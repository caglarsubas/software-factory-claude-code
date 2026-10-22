// What a purge may delete (ADR 0003): only what the purged tasks referenced and no kept task
// does, every version of it, and nothing at all while a kept task's references are unknown.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FactoryEvent } from "../store/events.ts";
import { deleteObject, putObject } from "./objects.ts";
import { deletionSet, RefsError, taskRefs } from "./refs.ts";

const objects = mkdtempSync(join(tmpdir(), "refs-"));
afterAll(() => {
  rmSync(objects, { recursive: true, force: true });
});

let seq = 0;
const event = (task_id: string, type: FactoryEvent["type"], payload: Record<string, unknown>): FactoryEvent => ({ schema_version: 1, seq: ++seq, task_id, ts: "2026-10-22T00:00:00.000Z", epoch: 0, actor: { kind: "factoryctl", id: "factoryctl" }, type, payload });

/** A task's record: its creation files, two versions of one artifact, and an evidence tree over a transcript. */
function task(id: string, body: string, note: string): { events: FactoryEvent[]; shared: string; json: string; v1: string; v2: string; transcript: string; tree: string } {
  const shared = putObject(objects, body);
  const json = putObject(objects, `{"id":"${id}"}\n`);
  const v1 = putObject(objects, `${note} v1\n`);
  const v2 = putObject(objects, `${note} v2\n`);
  const transcript = putObject(objects, `${note} transcript\n`);
  const tree = putObject(objects, `${JSON.stringify({ schema_version: 1, files: { "transcripts/a.ndjson": transcript, "triage.json": v1 } })}\n`);
  const events = [
    event(id, "task_created", { files: { "task.md": shared, "task.json": json } }),
    event(id, "artifact_committed", { artifacts: [{ path: "triage.json", digest: v1 }] }),
    event(id, "command", { command: "evidence_stored", tree, files: 2 }),
    event(id, "artifact_committed", { artifacts: [{ path: "triage.json", digest: v2 }] }),
  ];
  return { events, shared, json, v1, v2, transcript, tree };
}

describe("a purge's deletion set", () => {
  const kept = task("T-0001", "Same body.\n", "kept");
  const gone = task("T-0002", "Same body.\n", "gone");

  it("names every version a task referenced, its trees' files included", () => {
    const r = taskRefs(gone.events, objects);
    for (const d of [gone.shared, gone.v1, gone.v2, gone.transcript, gone.tree]) expect(r.digests.has(d)).toBe(true);
    expect([...r.trees]).toEqual([gone.tree]);
    expect(r.missingTrees).toEqual([]);
  });

  it("deletes what only the purged tasks referenced, trees last, and keeps what is shared", () => {
    const set = deletionSet([gone.events], [kept.events], objects);
    expect(set).not.toContain(gone.shared);
    expect(new Set(set)).toEqual(new Set([gone.json, gone.v1, gone.v2, gone.transcript, gone.tree]));
    expect(set.at(-1)).toBe(gone.tree);
    // A digest the purged task holds outside its record goes under the same rule.
    const extra = putObject(objects, "gone, unrecorded\n");
    expect(deletionSet([gone.events], [kept.events], objects, [extra, kept.v1])).toEqual(expect.arrayContaining([extra]));
    expect(deletionSet([gone.events], [kept.events], objects, [kept.v1])).not.toContain(kept.v1);
  });

  it("deletes nothing while a kept task's evidence tree is missing", () => {
    const other = task("T-0003", "Other body.\n", "other");
    deleteObject(objects, other.tree);
    expect(() => deletionSet([gone.events], [kept.events, other.events], objects)).toThrow(RefsError);
    // A purged task's missing tree only means its files are not found through it.
    expect(() => deletionSet([other.events], [kept.events], objects)).not.toThrow();
  });
});
