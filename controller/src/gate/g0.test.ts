// `factoryctl gate G0`: the automated criteria pass on complete dry runs of both fixtures made
// with an installed release, and each one fails on what it guards. Sessions are replayed here;
// a runner that reports itself live stands in for the SDK, so G0-1 can tell the two apart.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GatesResult } from "../../../gates/src/run.ts";
import type { Check } from "../doctor.ts";
import { buildTargetRepo, fixtureNames, loadFixture, mirrorRepo } from "../fixtures/targets.ts";
import type { CheckRun, GitHub } from "../github/client.ts";
import { ensureHome, factoryHome, runDir, worktreeDir, type Home } from "../home.ts";
import { loadRelease, type Release } from "../release.ts";
import { installRelease, makeWritable } from "../release/install.ts";
import { factorySource } from "../release/testing.ts";
import { createValidator } from "../schemas/validate.ts";
import { replayRunner } from "../session/replay.ts";
import type { SessionRunner } from "../session/runner.ts";
import { answer, assistant, result, toolUse } from "../session/transcript.ts";
import { EventStore } from "../store/events.ts";
import { runTask } from "../stages/pipeline.ts";
import { createTask } from "../task/task.ts";
import { beginG0, evaluateG0, evidenceMarkdown, writeEvidence, type G0Deps } from "./g0.ts";

const validator = createValidator();
const scratch = mkdtempSync(join(tmpdir(), "g0-"));
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
  prs: string[];
}

let n = 0;
async function world(): Promise<World> {
  const root = join(scratch, `world-${String(++n)}`);
  const home = factoryHome({ FACTORY_HOME: join(root, "factory") });
  ensureHome(home);
  const installed = await installRelease({ home, source, tag: "v0.1.0", by: "operator", validator, installDeps: () => undefined });
  const checkout = join(root, "operator-checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(join(checkout, ".git"));
  writeFileSync(join(checkout, ".git/index"), "index");
  writeFileSync(join(checkout, "src/app.ts"), "export const app = 1;\n");
  return { home, store: EventStore.open(home.db), release: loadRelease(validator, installed.dir), checkout, prs: [] };
}

const pins = loadRelease(validator).config.model_pins;
const live = (r: ReturnType<typeof replayRunner>): SessionRunner => ({ kind: "sdk", run: (req) => r.run(req) });

/** One fixture task through every stage to its PR on the fixture repository. */
async function dryRun(w: World, name: string, kind: "sdk" | "replay" = "sdk"): Promise<string> {
  const f = loadFixture(name, validator);
  const repo = mirrorRepo(f);
  const seed = join(scratch, `seed-${String(++n)}`);
  buildTargetRepo(f, seed);
  const remote = `${seed}.git`;
  spawnSync("git", ["clone", "-q", "--bare", seed, remote]);
  const id = createTask(w.home, w.store, validator, { profilePath: f.profilePath, title: "Document the dry run", body: "Add docs/g0.md.", trust: "operator", admittedBy: "operator", remote }).id;
  const work = join(runDir(w.home, id), "work/build");
  const replay = replayRunner({
    triage: answer(pins["haiku"] ?? "", { kind: "docs", proposed_tier: "R0", uncertain: false, duplicate_of: null, summary: "Add a docs page." }),
    spec: answer(pins["opus"] ?? "", {
      objective: "Document the dry run", scope: { include: ["docs/"], exclude: [] },
      acceptance_criteria: [{ id: "AC-1", statement: "docs/g0.md exists", verification: "test -f docs/g0.md" }],
      invariants: [], risk_signals: [], required_evidence: ["docs"], human_gate: { required: false }, markdown: "# Spec",
    }),
    build: [
      assistant(pins["sonnet"] ?? "", [
        toolUse("Write", { file_path: join(worktreeDir(w.home, id), "docs/g0.md"), content: "# G0\n" }),
        toolUse("Write", { file_path: join(work, "build-report.md"), content: "Added docs/g0.md.\n" }),
      ]),
      result(pins["sonnet"] ?? "", { costUsd: 0.4 }),
    ],
    "review-code": answer(pins["sonnet"] ?? "", { findings: [], summary: "Meets AC-1." }),
    "review-security": answer(pins["opus"] ?? "", { findings: [], summary: "Docs only." }),
    approve: answer(pins["opus"] ?? "", { decision: "approve", confidence: 95, criteria: [{ ac_id: "AC-1", met: true, evidence: "docs/g0.md added" }], blocking_findings: [], rationale: "AC-1 met." }),
    summarize: answer(pins["haiku"] ?? "", { pr_body: "Adds docs/g0.md.", changelog: "Document the dry run" }),
  });
  const github: GitHub = {
    findPullRequest: () => Promise.resolve(null),
    createPullRequest: () => {
      w.prs.push(repo);
      return Promise.resolve({ number: w.prs.length, url: `https://github.com/${repo}/pull/${String(w.prs.length)}` });
    },
  };
  const gates = (o: { worktree: string; taskId: string }): Promise<GatesResult> =>
    Promise.resolve({
      schema_version: 1, task_id: o.taskId, passed: true, signals: { sink_added: [], secret_material: false },
      candidate_commit: spawnSync("git", ["-C", o.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      gates: [{ name: "test", status: "pass", duration_ms: 1, summary: "exit 0" }],
    });
  const state = await runTask({
    home: w.home, store: w.store, validator, release: w.release, taskId: id,
    deps: { runner: kind === "sdk" ? live(replay) : replay, runGates: gates, gateImage: () => "replay", github, auth: null, keyFile: join(w.home.secrets, "anthropic.key"), log: () => undefined },
  });
  expect(state).toBe("NEEDS_HUMAN");
  return id;
}

const ok = (name: string): Check => ({ name, status: "ok", detail: `${name} as pinned` });
const deps = (over: Partial<G0Deps> = {}, runs: CheckRun[] = [{ name: "ci", status: "completed", conclusion: "success", app: "github-actions" }]): G0Deps => ({
  bypass: () => ({ variants: 58, denied: 58, failures: [] }),
  checks: { checkRuns: () => Promise.resolve(runs) },
  doctor: [ok("node"), ok("agent sdk pin"), ok("claude code pin")],
  repository: null,
  ...over,
});
const statuses = async (w: World, d: G0Deps = deps(), release: Release = w.release) =>
  (await evaluateG0({ home: w.home, store: w.store, validator, release, deps: d })).criteria.map((c) => `${c.id} ${c.status}`);

describe("gate G0", () => {
  it("passes G0-1 to G0-4 on live dry runs of both fixtures with the installed release, and drafts the evidence PR", { timeout: 60_000 }, async () => {
    const w = await world();
    beginG0(w.home, w.release, [w.checkout]);
    const ids = [];
    for (const name of fixtureNames()) ids.push(await dryRun(w, name));
    const evidence = await evaluateG0({ home: w.home, store: w.store, validator, release: w.release, deps: deps(), now: new Date("2026-10-22T16:00:00Z") });
    expect(evidence.criteria.map((c) => `${c.id} ${c.status}`)).toEqual(["G0-1 pass", "G0-2 pass", "G0-3 pass", "G0-4 pass", "G0-5 human"]);
    expect(evidence.passed).toBe(true);
    expect(evidence.release?.tag).toBe("v0.1.0");
    expect(evidence.criteria[0]?.evidence.join("\n")).toContain(`https://github.com/caglarsubas/factory-fixture-ts-mini/pull/`);
    expect(evidence.criteria[2]?.evidence.join("\n")).toMatch(/14 sessions, each env exactly the [0-9]+-name allowlist/);
    expect(evidence.criteria[4]?.evidence.join("\n")).toContain("**/auth/** → R3");

    const md = evidenceMarkdown(evidence);
    expect(md).toContain("| G0-1 | Fixture dry runs produce the full artifact chain and a PR | done |");
    expect(md).toContain("| G0-5 | Operator signs; globs and budgets confirmed | review |");
    // The PR body goes into the public repository: no local paths.
    expect(md).not.toContain(scratch);
    const files = writeEvidence(w.home, evidence);
    expect(validator.validate("gate-evidence.schema.json", JSON.parse(readFileSync(files.json, "utf8"))).errors).toEqual([]);

    // Each criterion fails on what it guards.
    expect(await statuses(w, deps({}, [{ name: "ci", status: "completed", conclusion: "failure", app: "github-actions" }]))).toContain("G0-4 fail");
    expect(await statuses(w, deps({ doctor: [ok("node"), { name: "agent sdk pin", status: "fail", detail: "installed 0.3.287" }, ok("claude code pin")] }))).toContain("G0-4 fail");
    expect(await statuses(w, deps({ bypass: () => ({ variants: 58, denied: 57, failures: ["sh -c"] }) }))).toContain("G0-2 fail");
    expect(await statuses(w, deps({ bypass: () => ({ variants: 19, denied: 19, failures: [] }) }))).toContain("G0-2 fail");
    // A development checkout is not the release the dry runs must use.
    expect(await statuses(w, deps(), loadRelease(validator))).toEqual(["G0-1 fail", "G0-2 pass", "G0-3 fail", "G0-4 fail", "G0-5 human"]);

    writeFileSync(join(w.checkout, "src/app.ts"), "export const app = 2;\n");
    expect(await statuses(w)).toContain("G0-3 fail");
    writeFileSync(join(w.checkout, "src/app.ts"), "export const app = 1;\n");
    // Git's stat cache is not content: a prompt's `git status` must not fail the gate.
    writeFileSync(join(w.checkout, ".git/index"), "rewritten by git status");
    expect(await statuses(w)).toContain("G0-3 pass");
    writeFileSync(join(w.checkout, ".git/config"), "[core]\n");
    expect(await statuses(w)).toContain("G0-3 fail");

    const verdict = join(runDir(w.home, ids[0] ?? ""), "verdict.json");
    const original = readFileSync(verdict, "utf8");
    writeFileSync(verdict, original.replace('"approve"', '"approve" '));
    const tampered = await evaluateG0({ home: w.home, store: w.store, validator, release: w.release, deps: deps() });
    expect(tampered.criteria[0]).toMatchObject({ status: "fail" });
    expect(tampered.criteria[0]?.detail).toContain("artifacts differ from the manifest: verdict.json");
    writeFileSync(verdict, original);

    // A session whose env held anything beyond the allowlist fails G0-3 for good: events are append-only.
    w.store.append({ task_id: ids[0] ?? "", actor: { kind: "factoryctl", id: "factoryctl" }, type: "stage_started", payload: { stage: "build", label: "build", runner: "sdk", env_keys: ["ANTHROPIC_API_KEY", "PATH"] } });
    const leaked = await evaluateG0({ home: w.home, store: w.store, validator, release: w.release, deps: deps() });
    expect(leaked.criteria[2]?.detail).toContain("1 of 15 sessions had an env other than the allowlist");
    w.store.close();
  });

  it("counts only live sessions, and needs the snapshot taken before the runs", { timeout: 60_000 }, async () => {
    const w = await world();
    for (const name of fixtureNames()) await dryRun(w, name, "replay");
    const evidence = await evaluateG0({ home: w.home, store: w.store, validator, release: w.release, deps: deps() });
    expect(evidence.criteria[0]).toMatchObject({ id: "G0-1", status: "fail" });
    expect(evidence.criteria[0]?.detail).toContain("replayed sessions");
    expect(evidence.criteria[2]?.detail).toContain("no snapshot: run `factoryctl gate G0 --begin` before the dry runs");
    expect(evidence.passed).toBe(false);
    w.store.close();
  });

  it("finds no dry run before any task, and opens its window only on a named checkout", async () => {
    const w = await world();
    expect(() => beginG0(w.home, w.release, [])).toThrow(/at least one operator checkout/);
    beginG0(w.home, w.release, [w.checkout]);
    const evidence = await evaluateG0({ home: w.home, store: w.store, validator, release: w.release, deps: deps() });
    expect(evidence.criteria[0]?.detail).toBe("py-mini: no dry run in the evidence window | ts-mini: no dry run in the evidence window");
    expect(evidence.criteria[2]?.detail).toContain("no sessions recorded in the evidence window");
    w.store.close();
  });
});
