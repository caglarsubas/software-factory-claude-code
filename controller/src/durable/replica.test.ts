// The object store, the replica and the restore (P2-07): objects are write-once and checked on
// read; the replica copies what it lacks, as often as it is asked, from any number of writers;
// a restore brings back every event and every file a task's record names, by digest.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { sha256 } from "../fsutil.ts";
import { ensureHome, factoryHome, runDir, type Home } from "../home.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { commitArtifacts } from "../stages/commit.ts";
import { EventStore } from "../store/events.ts";
import { hasObject, listObjects, objectPath, putObject, readObject, readTree, storeTree } from "./objects.ts";
import { initReplica, readReplicaState, replicaStatus, restore, syncReplica } from "./replica.ts";

const scratch = mkdtempSync(join(tmpdir(), "durable-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let n = 0;
function newHome(): Home {
  const home = factoryHome({ FACTORY_HOME: join(scratch, `home-${String(++n)}`) });
  ensureHome(home);
  return home;
}

const op = { kind: "operator" as const, id: "op" };
const ctl = { kind: "factoryctl" as const, id: "factoryctl" };

/** A task with its creation files, two committed artifacts and one stored evidence tree. */
function seedTask(home: Home, store: EventStore): string {
  const id = store.nextTaskId();
  const dir = runDir(home, id);
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  const files = { "task.md": putObject(home.objects, "Do the thing.\n"), "task.json": putObject(home.objects, "{}\n") };
  writeFileSync(join(dir, "task.md"), "Do the thing.\n");
  writeFileSync(join(dir, "task.json"), "{}\n");
  store.append({ task_id: id, actor: op, type: "task_created", payload: { remote: "/r", commit_protocol: 1, files } });
  commitArtifacts(store, dir, { taskId: id, stage: "triage", label: "triage", round: 1 }, {}, [{ path: "triage.json", content: '{"kind":"docs"}\n' }], undefined, home.objects);
  writeFileSync(join(dir, "transcripts/triage.ndjson"), '{"type":"result"}\n');
  mkdirSync(join(dir, "bundle"), { recursive: true });
  writeFileSync(join(dir, "bundle/diff.patch"), "derived\n");
  const stored = storeTree(home.objects, dir);
  store.append({ task_id: id, actor: ctl, type: "command", payload: { command: "evidence_stored", ...stored } });
  // A later commit of the same path wins over the tree's older copy.
  commitArtifacts(store, dir, { taskId: id, stage: "triage", label: "triage", round: 1 }, { "task.md": sha256("changed") }, [{ path: "triage.json", content: '{"kind":"feature"}\n' }], undefined, home.objects);
  return id;
}

describe("the object store", () => {
  it("stores content once by its digest, refuses a damaged object, and keeps the judges' bundle out of a run's tree", () => {
    const home = newHome();
    const d = putObject(home.objects, "hello\n");
    expect(d).toBe(sha256("hello\n"));
    expect(putObject(home.objects, "hello\n")).toBe(d);
    expect(listObjects(home.objects)).toEqual([d]);
    expect(readObject(home.objects, d).toString()).toBe("hello\n");
    writeFileSync(objectPath(home.objects, d), "tampered\n");
    expect(() => readObject(home.objects, d)).toThrow(/damaged/);
    expect(() => objectPath(home.objects, "md5:abc")).toThrow(/not a sha256 digest/);

    const dir = join(scratch, "run");
    mkdirSync(join(dir, "bundle"), { recursive: true });
    writeFileSync(join(dir, "spec.yaml"), "a: 1\n");
    writeFileSync(join(dir, "bundle/diff.patch"), "x\n");
    writeFileSync(join(dir, "spec.md.pending"), "half\n");
    const t = storeTree(home.objects, dir);
    expect(t.files).toBe(1);
    expect(readTree(home.objects, t.tree).files).toEqual({ "spec.yaml": sha256("a: 1\n") });
  });

  it("holds every committed artifact before its commit event exists", () => {
    const home = newHome();
    const store = EventStore.open(home.db);
    try {
      const id = seedTask(home, store);
      for (const e of store.events(id).filter((x) => x.type === "artifact_committed")) {
        for (const a of e.payload["artifacts"] as { digest: string }[]) expect(hasObject(home.objects, a.digest)).toBe(true);
      }
    } finally {
      store.close();
    }
  });
});

describe("the replica", () => {
  it("lives outside the home, belongs to one home, and copies only what it lacks", () => {
    const home = newHome();
    expect(() => initReplica(home, join(home.root, "replica"), "op")).toThrow(/outside/);
    expect(() => initReplica(home, "relative/dir", "op")).toThrow(/absolute/);
    const dir = join(scratch, `replica-${String(n)}`);
    const r = initReplica(home, dir, "op");
    expect(r.sameVolume).toBe(true);
    const store = EventStore.open(home.db);
    try {
      const id = seedTask(home, store);
      const first = syncReplica(home);
      expect(first).toMatchObject({ events: store.events(id).length });
      expect(first?.objects).toBe(listObjects(home.objects).length);
      expect(syncReplica(home)).toMatchObject({ events: 0, objects: 0 });
      store.append({ task_id: id, actor: op, type: "command", payload: { command: "pause", reason: "x" } });
      expect(replicaStatus(home)?.lag_events).toBe(1);
      expect(syncReplica(home)).toMatchObject({ events: 1 });
      expect(replicaStatus(home)?.lag_events).toBe(0);
      expect(readReplicaState(dir)).toMatchObject({ source: home.root, events: store.events(id).length });
      // A replica whose volume is gone is an error, never recreated on the home's own disk.
      rmSync(dir, { recursive: true, force: true });
      expect(() => syncReplica(home)).toThrow(/is its volume mounted/);
      expect(existsSync(dir)).toBe(false);
      mkdirSync(dir);
      expect(syncReplica(home)?.events).toBe(store.events(id).length);
      // Another home cannot write into this replica.
      const other = newHome();
      expect(() => initReplica(other, dir, "op")).toThrow(/is the replica of/);
    } finally {
      store.close();
    }
  });

  it("brings a replica made by an earlier release up to the store's schema before copying into it", () => {
    const home = newHome();
    const dir = join(scratch, `replica-${String(n)}`);
    initReplica(home, dir, "op");
    const store = EventStore.open(home.db);
    try {
      seedTask(home, store);
      syncReplica(home);
      // As an earlier release left it: no merge leases (P2-06), at the schema before them.
      const old = new DatabaseSync(join(dir, "factory.db"));
      old.exec("DROP TABLE merge_leases; UPDATE meta SET value = '2' WHERE key = 'schema_version'");
      old.close();
      expect(syncReplica(home)).toMatchObject({ events: 0 });
      const replica = new DatabaseSync(join(dir, "factory.db"), { readOnly: true });
      try {
        expect(replica.prepare("SELECT name FROM sqlite_master WHERE name = 'merge_leases'").get()).toBeDefined();
        expect(replica.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "3" });
      } finally {
        replica.close();
      }
    } finally {
      store.close();
    }
  });

  it("stays exact when several writers sync at once", async () => {
    const home = newHome();
    const dir = join(scratch, `replica-${String(n)}`);
    initReplica(home, dir, "op");
    const store = EventStore.open(home.db);
    try {
      const id = seedTask(home, store);
      for (let i = 0; i < 20; i++) store.append({ task_id: id, actor: op, type: "command", payload: { command: "pause", reason: String(i) } });
      // Four processes sync at the same moment, as a serve and its workers do.
      const script = `import { factoryHome } from ${JSON.stringify(join(REPO_ROOT, "controller/src/home.ts"))}; import { syncReplica } from ${JSON.stringify(join(REPO_ROOT, "controller/src/durable/replica.ts"))}; syncReplica(factoryHome());`;
      const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise<number | null>((resolve) => {
        spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { env: { ...process.env, FACTORY_HOME: home.root }, stdio: "ignore" }).once("close", resolve);
      })));
      expect(runs).toEqual([0, 0, 0, 0]);
      const replica = EventStore.open(join(dir, "factory.db"));
      try {
        expect(replica.events(id)).toEqual(store.events(id));
      } finally {
        replica.close();
      }
    } finally {
      store.close();
    }
  });
});

describe("restore", () => {
  it("brings back every event and the latest version of every file a task's record names", async () => {
    const home = newHome();
    const dir = join(scratch, `replica-${String(n)}`);
    initReplica(home, dir, "op");
    const store = EventStore.open(home.db);
    let id: string;
    try {
      id = seedTask(home, store);
      syncReplica(home);
    } finally {
      store.close();
    }
    const target = factoryHome({ FACTORY_HOME: join(scratch, "restored") });
    const r = await restore(dir, target);
    expect(r.missing).toEqual([]);
    expect(r.tasks).toBe(1);
    const back = EventStore.open(target.db);
    const live = EventStore.open(home.db);
    try {
      expect(back.events(id)).toEqual(live.events(id));
    } finally {
      back.close();
      live.close();
    }
    const run = runDir(target, id);
    expect(readFileSync(join(run, "task.md"), "utf8")).toBe("Do the thing.\n");
    expect(readFileSync(join(run, "triage.json"), "utf8")).toBe('{"kind":"feature"}\n');
    expect(readFileSync(join(run, "transcripts/triage.ndjson"), "utf8")).toBe('{"type":"result"}\n');
    expect(existsSync(join(run, "bundle"))).toBe(false);
    // Never over an existing store.
    await expect(restore(dir, target)).rejects.toThrow(/restore into an empty home/);
    await expect(restore(join(scratch, "nothing"), factoryHome({ FACTORY_HOME: join(scratch, "empty") }))).rejects.toThrow(/not a factory replica/);
  });

  it("reports a file whose object the replica lacks instead of inventing it", async () => {
    const home = newHome();
    const dir = join(scratch, `replica-${String(n)}`);
    initReplica(home, dir, "op");
    const store = EventStore.open(home.db);
    try {
      const id = store.nextTaskId();
      store.append({ task_id: id, actor: op, type: "task_created", payload: { remote: "/r", commit_protocol: 1, files: { "task.md": sha256("never stored") } } });
      syncReplica(home);
    } finally {
      store.close();
    }
    const r = await restore(dir, factoryHome({ FACTORY_HOME: join(scratch, `restored-${String(n)}`) }));
    expect(r.missing).toEqual(["T-0001/task.md"]);
  });
});
