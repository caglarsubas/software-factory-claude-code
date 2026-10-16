// `factoryctl gate G1`: the automated criteria pass on five merged R0 tasks across both fixtures,
// run with an installed release after the snapshot, and each one fails on what it guards.
// Sessions are replayed here; a runner that reports itself live stands in for the SDK.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GatesResult } from "../../../gates/src/run.ts";
import { calibrate, completedRuns } from "../budget/budget.ts";
import { buildTargetRepo, loadFixture } from "../fixtures/targets.ts";
import type { CheckRun } from "../github/client.ts";
import { memoryGitHub, type MemoryGitHub } from "../github/testing.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { ensureHome, factoryHome, worktreeDir, type Home } from "../home.ts";
import { loadRelease, type Release } from "../release.ts";
import { installRelease, makeWritable } from "../release/install.ts";
import { factorySource, RELEASE_TAG } from "../release/testing.ts";
import { createValidator } from "../schemas/validate.ts";
import { replayRunner } from "../session/replay.ts";
import type { SessionRunner } from "../session/runner.ts";
import { answer, assistant, result, toolUse } from "../session/transcript.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import { runTask, type Deps } from "../stages/pipeline.ts";
import { createTask } from "../task/task.ts";
import { beginGate, evidenceMarkdown } from "./g0.ts";
import { evaluateG1, killPoints, type G1Deps } from "./g1.ts";

const validator = createValidator();
const scratch = mkdtempSync(join(tmpdir(), "g1-"));
afterAll(() => {
  makeWritable(scratch);
  rmSync(scratch, { recursive: true, force: true });
});
const source = join(scratch, "source");
factorySource(source);

interface World {
  home: Home;
  store: EventStore;
  release: Release;
  checkout: string;
}

let n = 0;
async function world(): Promise<World> {
  const root = join(scratch, `world-${String(++n)}`);
  const home = factoryHome({ FACTORY_HOME: join(root, "factory") });
  ensureHome(home);
  const installed = await installRelease({ home, source, tag: RELEASE_TAG, by: "operator", validator, installDeps: () => undefined });
  const checkout = join(root, "operator-checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "src/app.ts"), "export const app = 1;\n");
  return { home, store: EventStore.open(home.db), release: loadRelease(validator, installed.dir), checkout };
}

const pins = loadRelease(validator).config.model_pins;
const live = (r: ReturnType<typeof replayRunner>): SessionRunner => ({ kind: "sdk", run: (req) => r.run(req) });
const gates = (o: { worktree: string; taskId: string }): Promise<GatesResult> =>
  Promise.resolve({
    schema_version: 1, task_id: o.taskId, passed: true, signals: { sink_added: [], secret_material: false },
    candidate_commit: spawnSync("git", ["-C", o.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    gates: [{ name: "test", status: "pass", duration_ms: 1, summary: "exit 0" }],
  });

/** One R0 docs task on a fixture, through every stage to its PR, then merged by the operator. */
async function mergedTask(w: World, name: string, kind: "sdk" | "replay" = "sdk"): Promise<string> {
  const f = loadFixture(name, validator);
  const seed = join(scratch, `seed-${String(++n)}`);
  buildTargetRepo(f, seed);
  const remote = `${seed}.git`;
  spawnSync("git", ["clone", "-q", "--bare", seed, remote]);
  const id = createTask(w.home, w.store, validator, { profilePath: f.profilePath, title: "Document a page", body: "Add docs/page.md.", trust: "operator", admittedBy: "operator", remote }).id;
  const replay = replayRunner({
    triage: answer(pins["haiku"] ?? "", { kind: "docs", proposed_tier: "R0", uncertain: false, duplicate_of: null, summary: "Add a docs page." }),
    spec: answer(pins["opus"] ?? "", {
      objective: "Document a page", scope: { include: ["docs/"], exclude: [] },
      acceptance_criteria: [{ id: "AC-1", statement: "docs/page.md exists", verification: "test -f docs/page.md" }],
      invariants: [], risk_signals: [], required_evidence: ["docs"], human_gate: { required: false }, markdown: "# Spec",
    }),
    build: [
      assistant(pins["sonnet"] ?? "", [
        toolUse("Write", { file_path: join(worktreeDir(w.home, id), "docs/page.md"), content: "# Page\n" }),
        toolUse("Write", { file_path: join(w.home.runs, id, "work/build/build-report.md"), content: "Added docs/page.md.\n" }),
      ]),
      result(pins["sonnet"] ?? "", { costUsd: 0.3, durationMs: 60_000 }),
    ],
    "review-code": answer(pins["sonnet"] ?? "", { findings: [{ id: "F-1", severity: "nit", category: "maintainability", file: "docs/page.md", line: 1, title: "Wording", failure_scenario: "None: the heading could be shorter.", fix: "Shorten it.", confidence: 60 }], summary: "Meets AC-1." }),
    "review-security": answer(pins["opus"] ?? "", { findings: [], summary: "Docs only." }),
    approve: answer(pins["opus"] ?? "", { decision: "approve", confidence: 95, criteria: [{ ac_id: "AC-1", met: true, evidence: "docs/page.md added" }], blocking_findings: [], rationale: "AC-1 met." }),
    summarize: answer(pins["haiku"] ?? "", { pr_body: "Adds docs/page.md.", changelog: "Document a page" }),
  });
  const github: MemoryGitHub = memoryGitHub();
  const deps: Deps = { runner: kind === "sdk" ? live(replay) : replay, runGates: gates, gateImage: () => "replay", github, auth: null, keyFile: join(w.home.secrets, "anthropic.key"), log: () => undefined };
  expect(await runTask({ home: w.home, store: w.store, validator, release: w.release, taskId: id, deps })).toBe("NEEDS_HUMAN");
  // The operator merges the PR; the next run records it.
  for (const pr of github.prs) Object.assign(pr, { state: "closed", merged: true });
  expect(await runTask({ home: w.home, store: w.store, validator, release: w.release, taskId: id, deps })).toBe("DONE");
  return id;
}

const ciGreen: CheckRun = { name: "ci", status: "completed", conclusion: "success", app: "github-actions" };
const evalsGreen: CheckRun = { name: "evals", status: "completed", conclusion: "success", app: "github-actions" };
const green = [ciGreen, evalsGreen];
const deps = (runs: CheckRun[] = green): G1Deps => ({ checks: { checkRuns: () => Promise.resolve(runs) }, repository: "caglarsubas/software-factory-claude-code" });

/** What `factoryctl budgets` records: the P1-01 rule over the event store. */
function recordBudgets(w: World): void {
  const byTask = new Map<string, FactoryEvent[]>();
  for (const e of w.store.allEvents()) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
  const runs = completedRuns(byTask);
  mkdirSync(join(w.home.root, "budgets"), { recursive: true });
  writeFileSync(join(w.home.root, "budgets/calibration.json"), JSON.stringify({ schema_version: 1, computed_at: "2026-10-16T18:00:00Z", tiers: calibrate(w.release.budgets, runs), runs: runs.length }));
}

const statuses = async (w: World, d: G1Deps = deps()) => (await evaluateG1({ home: w.home, store: w.store, validator, release: w.release, deps: d })).criteria.map((c) => `${c.id} ${c.status}`);

describe("gate G1", () => {
  it("reads the kill points from the suite itself", () => {
    const points = killPoints(readFileSync(join(REPO_ROOT, "controller/src/cli/killpoints.test.ts"), "utf8"));
    expect(points.length).toBeGreaterThanOrEqual(21);
    expect(points).toContain("publish:pull_request:acted");
    expect(killPoints("no suite here")).toEqual([]);
  });

  it("passes G1-1 to G1-5 on five merged R0 tasks across two targets, and drafts the evidence PR", { timeout: 120_000 }, async () => {
    const w = await world();
    const ids = [];
    for (const name of ["ts-mini", "py-mini", "ts-mini", "py-mini"]) ids.push(await mergedTask(w, name));
    beginGate(w.home, "G1", w.release, [w.checkout]);
    ids.push(await mergedTask(w, "ts-mini"));
    recordBudgets(w);

    const evidence = await evaluateG1({ home: w.home, store: w.store, validator, release: w.release, deps: deps(), now: new Date("2026-10-16T18:30:00Z") });
    expect(evidence.criteria.map((c) => `${c.id} ${c.status}`)).toEqual(["G1-1 pass", "G1-2 pass", "G1-3 pass", "G1-4 pass", "G1-5 pass", "G1-6 human"]);
    expect(evidence.passed).toBe(true);
    const g12 = evidence.criteria[1];
    expect(g12?.detail).toMatch(/^5 R0–R1 tasks merged across 2 targets/);
    // Per task: the PR, rounds, sessions, tokens, minutes, cost and findings.
    expect(g12?.evidence[0]).toMatch(/^T-0001 \(R0\) → <https:\/\/github\.com\/caglarsubas\/factory-fixture-ts-mini\/pull\/1>: 1 round\(s\), 7 sessions, [0-9]+ tokens, [0-9.]+ min, \$[0-9.]+; findings 0 blocking, 0 major, 0 minor, 1 nit$/);
    expect(evidence.criteria[2]?.evidence.join("\n")).toContain(`counted task(s) run inside the window: ${ids[4] ?? ""}`);

    const md = evidenceMarkdown(evidence);
    expect(md).toContain("## Gate G1 evidence");
    expect(md).toContain("Automated criteria (G1-1 to G1-5): **all pass**. G1-6 is the operator's signature: approving this PR.");
    expect(md).not.toContain(scratch);

    // Each criterion fails on what it guards.
    expect(await statuses(w, deps([{ name: "ci", status: "completed", conclusion: "failure", app: "github-actions" }, evalsGreen]))).toContain("G1-1 fail");
    expect(await statuses(w, deps([ciGreen]))).toContain("G1-4 fail");
    writeFileSync(join(w.checkout, "src/app.ts"), "export const app = 2;\n");
    expect(await statuses(w)).toContain("G1-3 fail");
    writeFileSync(join(w.checkout, "src/app.ts"), "export const app = 1;\n");
    // A task completed since the budgets were recorded makes the record stale.
    await mergedTask(w, "py-mini");
    expect(await statuses(w)).toContain("G1-5 fail");
    recordBudgets(w);
    expect(await statuses(w)).toContain("G1-5 pass");
    rmSync(join(w.home.root, "budgets/calibration.json"));
    expect(await statuses(w)).toContain("G1-5 fail");
    w.store.close();
  });

  it("counts only live, merged R0–R1 tasks across enough targets, and needs a task inside the snapshot window", { timeout: 120_000 }, async () => {
    const w = await world();
    for (let k = 0; k < 5; k++) await mergedTask(w, "ts-mini");
    await mergedTask(w, "py-mini", "replay");
    beginGate(w.home, "G1", w.release, [w.checkout]);
    const evidence = await evaluateG1({ home: w.home, store: w.store, validator, release: w.release, deps: deps() });
    expect(evidence.criteria[1]).toMatchObject({ id: "G1-2", status: "fail", detail: "5 counted task(s) across 1 target(s); G1-2 needs 5 across 2" });
    expect(evidence.criteria[1]?.evidence.at(-1)).toBe("not counted: T-0006: replayed sessions");
    expect(evidence.criteria[2]?.detail).toContain("no counted task ran after the snapshot");
    expect(evidence.criteria[4]?.detail).toBe("no recorded calibration: run `factoryctl budgets`");
    expect(evidence.passed).toBe(false);
    w.store.close();
  });
});
