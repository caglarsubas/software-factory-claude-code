// Schema migrations on old bundles (ROADMAP P2-11): homes that earlier releases wrote with their
// own factoryctl (testdata/generate.ts) open with this one. Each store migrates to this
// release's schema with every event kept and still append-only; every artifact still validates
// at the schema version it declares; today's commands read them; retention, a purge, the
// replica and a restore work on them; and a task too old to resume is refused, not crashed.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { restoreDrill } from "../durable/drill.ts";
import { hasObject, listObjects } from "../durable/objects.ts";
import { planPurge, runJournal } from "../durable/purge.ts";
import { initReplica, restore, syncReplica } from "../durable/replica.ts";
import { planRetention, prune } from "../durable/retention.ts";
import { ensureHome, factoryHome, runDir, type Home } from "../home.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { EventStore } from "./events.ts";
import { OLD_HOMES } from "./testdata/generate.ts";

const TESTDATA = join(REPO_ROOT, "controller/src/store/testdata");
const CLI = join(REPO_ROOT, "controller/src/cli/factoryctl.ts");
const scratch = mkdtempSync(join(tmpdir(), "old-homes-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The schema each versioned artifact an older release wrote was written against. */
const SCHEMAS: Record<string, string> = {
  "task.json": "task.schema.json",
  "triage.json": "triage.schema.json",
  "spec.yaml": "spec.schema.json",
  "gates.json": "gates.schema.json",
  "verdict.json": "verdict.schema.json",
  "summary.json": "summary.schema.json",
  "manifest.json": "manifest.schema.json",
};
const schemaOf = (file: string): string | undefined => SCHEMAS[file] ?? (/^review-[a-z-]+\.json$/.test(file) ? "review.schema.json" : undefined);

let n = 0;
/** A copy of an old home: its database from SQL, its run directories and objects as written. */
function oldHome(tag: string): Home {
  const home = factoryHome({ FACTORY_HOME: join(scratch, `${tag}-${String(++n)}`, "home") });
  ensureHome(home);
  const db = new DatabaseSync(home.db);
  db.exec(readFileSync(join(TESTDATA, tag, "factory.sql"), "utf8"));
  db.close();
  for (const dir of ["runs", "objects"] as const) if (existsSync(join(TESTDATA, tag, dir))) cpSync(join(TESTDATA, tag, dir), home[dir], { recursive: true });
  return home;
}

const rawEvents = (home: Home): number => {
  const db = new DatabaseSync(home.db, { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

const factoryctl = (home: Home, args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: join(home.root, ".."), FACTORY_HOME: home.root } });

describe.each(OLD_HOMES.map((h) => [h.tag, h.schema] as const))("a home %s wrote (store schema %i)", (tag, schema) => {
  it("migrates to this release's schema with every event kept and still append-only", () => {
    const home = oldHome(tag);
    const before = new DatabaseSync(home.db, { readOnly: true });
    expect(before.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: String(schema) });
    before.close();
    const count = rawEvents(home);
    const store = EventStore.open(home.db);
    try {
      expect(store.allEvents()).toHaveLength(count);
      expect(store.tombstones()).toEqual([]);
      expect(() => {
        store.unsafeExec("DELETE FROM events");
      }).toThrow(/append-only/);
      expect(() => {
        store.unsafeExec("UPDATE events SET type = 'command'");
      }).toThrow(/append-only/);
    } finally {
      store.close();
    }
    const after = new DatabaseSync(home.db, { readOnly: true });
    expect(after.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "4" });
    after.close();
  });

  it("holds artifacts that still validate at the schema version they declare", () => {
    const home = oldHome(tag);
    const validator = createValidator();
    let checked = 0;
    for (const task of readdirSync(home.runs)) {
      for (const file of readdirSync(runDir(home, task))) {
        const schemaFile = schemaOf(file);
        if (schemaFile === undefined) continue;
        const text = readFileSync(join(runDir(home, task), file), "utf8");
        const data = (file.endsWith(".yaml") ? parse(text) : JSON.parse(text)) as { schema_version?: number };
        expect(data.schema_version, `${tag} ${task}/${file}`).toBe(1);
        const r = validator.validate(schemaFile, data);
        expect(r.errors, `${tag} ${task}/${basename(file)}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(tag === "v0.1.2" ? 4 : 9);
  });

  it("is read by today's status, report and prune --dry-run", () => {
    const home = oldHome(tag);
    const status = factoryctl(home, ["status"]);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toMatch(/^T-0002 {2}CANCELLED {5}Cancelled before it ran$/m);
    const report = factoryctl(home, ["report", "T-0001"]);
    expect(report.status, report.stderr).toBe(0);
    const dry = factoryctl(home, ["prune", "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("dry run:");
  }, 60_000);

  it("can be pruned, purged, replicated and restored", async () => {
    const home = oldHome(tag);
    const store = EventStore.open(home.db);
    try {
      initReplica(home, join(home.root, "..", "replica"), "op");
      syncReplica(home);
      // Long after: every finished task's bundle is past any retention.
      const plan = planRetention({ store, config: { bundles: 180, transcripts: 30, otel: 30 }, policyFor: () => null, now: new Date("2027-12-01T00:00:00Z") });
      expect(plan.expire.map((x) => x.task_id).sort()).toEqual(tag === "v0.1.2" ? ["T-0002"] : ["T-0001", "T-0002"]);
      prune({ home, store, plan, by: "op" });
      for (const x of plan.expire) expect(readdirSync(runDir(home, x.task_id))).toEqual(["task.json"]);
      const restoredAfterPrune = await restoreDrill(home);
      expect(restoredAfterPrune.damaged).toEqual([]);
      // Then the whole home is purged, one task at a time.
      for (const id of store.taskIds()) runJournal(home, store, planPurge(home, store, [id], { by: "op", reason: "old home" }));
      expect(store.taskIds()).toEqual([]);
      expect(store.nextTaskId()).toBe("T-0003");
      expect(listObjects(home.objects).filter((d) => hasObject(home.objects, d))).toEqual([]);
      const back = factoryHome({ FACTORY_HOME: join(home.root, "..", "restored") });
      expect((await restore(join(home.root, "..", "replica"), back)).tasks).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("a task from before the commit protocol (v0.1.2)", () => {
  it("is refused on resume with what to do, not a crash", () => {
    const home = oldHome("v0.1.2");
    const replay = join(home.root, "..", "replay");
    mkdirSync(replay);
    const r = factoryctl(home, ["resume", "T-0001", "--replay", replay]);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("factoryctl: T-0001 was started by a factoryctl without the commit protocol (v0.1.x), which cannot open this store since v0.20.0: cancel it (factoryctl cancel T-0001) and create a new task");
  }, 60_000);
});
