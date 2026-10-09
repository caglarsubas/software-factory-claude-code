// Fixture targets (P0-08 "done when": factoryctl task create accepts each seeded task), plus
// the checks that keep the fixtures honest without containers: manifests and profiles validate,
// the target repos are deterministic, every golden patch applies, the hidden tests stay out of
// the target, and the policy engine puts each golden change on its expected tier. The container
// suite (targets.int.test.ts) runs the gates and hidden tests.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { changedFiles } from "../git/repo.ts";
import { ensureHome, factoryHome } from "../home.ts";
import { evaluate } from "../policy/engine.ts";
import { loadRiskPolicy, REPO_ROOT } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { EventStore } from "../store/events.ts";
import { createTask, readTask } from "../task/task.ts";
import { buildTargetRepo, commitGolden, fixtureNames, hiddenFiles, loadFixture, taskText } from "./targets.ts";

const validator = createValidator();
const root = mkdtempSync(join(tmpdir(), "fixtures-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const names = fixtureNames();

it("ships the two fixture targets the roadmap names", () => {
  expect(names).toEqual(["py-mini", "ts-mini"]);
});

describe.each(names)("%s", (name) => {
  const f = loadFixture(name, validator);

  it("has a valid profile and a task file, golden patch and hidden test for every task", () => {
    expect(validator.validate("profile.schema.json", parse(readFileSync(f.profilePath, "utf8"))).errors).toEqual([]);
    expect(new Set(f.tasks.map((t) => t.key)).size).toBe(f.tasks.length);
    for (const t of f.tasks) {
      for (const p of [t.text, t.golden, t.hidden]) expect(existsSync(join(f.dir, p)), `${t.key}: ${p}`).toBe(true);
      expect(hiddenFiles(f, t).length, t.key).toBeGreaterThan(0);
    }
  });

  it("seeds an R0, an R1, an auth change, a sink and an injection", () => {
    const tiers = new Set(f.tasks.map((t) => t.expect.tier));
    expect(tiers).toEqual(new Set(["R0", "R1", "R3"]));
    expect(f.tasks.some((t) => t.expect.policy_spec_gate)).toBe(true);
    expect(f.tasks.some((t) => t.expect.sinks.length > 0)).toBe(true);
    expect(f.tasks.some((t) => t.expect.injection)).toBe(true);
  });

  it("builds the same base commit every time", () => {
    expect(buildTargetRepo(f, join(root, `${name}-a`))).toBe(buildTargetRepo(f, join(root, `${name}-b`)));
  });

  const risk = loadRiskPolicy(REPO_ROOT, f.profilePath);
  it.each(f.tasks.map((t) => [t.key, t] as const))("%s: the golden patch applies, the hidden tests stay out of the target, and the policy tier is as expected", (_key, t) => {
    const repo = join(root, `${name}-${t.key}`);
    const base = buildTargetRepo(f, repo);
    for (const h of hiddenFiles(f, t)) expect(existsSync(join(repo, h)), `${h} must not be in the target`).toBe(false);
    const golden = commitGolden(repo, f, t);
    const files = changedFiles(repo, base, golden);
    const facts = { files, secretMaterial: false, classificationUncertain: false, operationRequested: false, graphHopsToProtected: null };
    // Paths alone decide the spec gate; the gates' sink signals then raise the tier.
    expect(["R3", "Restricted"].includes(evaluate({ ...facts, sinksAdded: [] }, risk).tier)).toBe(t.expect.policy_spec_gate);
    expect(evaluate({ ...facts, sinksAdded: t.expect.sinks }, risk).tier).toBe(t.expect.tier);
  });

  it("is accepted by factoryctl task create, one task per seeded task", () => {
    const home = factoryHome({ FACTORY_HOME: join(root, `${name}-home`) });
    ensureHome(home);
    const remote = join(root, `${name}-remote.git`);
    buildTargetRepo(f, join(root, `${name}-seed`));
    spawnSync("git", ["clone", "--quiet", "--bare", join(root, `${name}-seed`), remote]);
    const store = EventStore.open(home.db);
    try {
      for (const t of f.tasks) {
        const task = createTask(home, store, validator, { profilePath: f.profilePath, title: t.title, body: taskText(f, t), trust: t.trust, admittedBy: "operator", remote });
        expect(validator.validate("task.schema.json", readTask(home, task.id)).errors).toEqual([]);
        expect(readFileSync(join(home.runs, task.id, "task.md"), "utf8")).toBe(`${taskText(f, t).trimEnd()}\n`);
      }
      expect(store.taskIds()).toHaveLength(f.tasks.length);
    } finally {
      store.close();
    }
  });
});

it("factoryctl task create accepts a seeded task from the command line", { timeout: 30_000 }, () => {
  const f = loadFixture("ts-mini", validator);
  const t = f.tasks[0];
  if (t === undefined) throw new Error("ts-mini has no tasks");
  const r = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(REPO_ROOT, "controller/src/cli/factoryctl.ts"), "task", "create", "--profile", f.profilePath, "--title", t.title, "--body-file", join(f.dir, t.text), "--untrusted"],
    { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: root, FACTORY_HOME: join(root, "cli-home") } },
  );
  expect(r.stderr).toBe("");
  expect(r.stdout.trim()).toBe("T-0001");
});

it("scripts/mirror-fixture.ts prints the deterministic base commit it would push", { timeout: 30_000 }, () => {
  const f = loadFixture("ts-mini", validator);
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/mirror-fixture.ts"), "ts-mini"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.trim()).toBe(buildTargetRepo(f, join(root, "mirror-check")));
});
