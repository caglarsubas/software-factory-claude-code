// factoryctl run: one task through triage → spec → build → gates → review → approve →
// summarize → publish (ROADMAP §2.1, P0 subset: one round, humans merge every tier). Each
// stage writes its artifact last, so a stage whose artifact exists is done and `resume`
// continues from the first missing one; each stage's exit transition is idempotent, so a
// crash between an artifact and its transition is repaired on resume.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { GatesResult, RunOptions as GateRunOptions } from "../../../gates/src/run.ts";
import { cacheVolumeFor } from "../../../gates/src/run.ts";
import { writeManifest } from "../bundle/manifest.ts";
import { changedFiles, commitAll, createTaskClone, diffPatch, head, pushFromMirror, resolveCommit, syncMirror, type GitAuth } from "../git/repo.ts";
import type { GitHub } from "../github/client.ts";
import { runDir, worktreeDir, type Home } from "../home.ts";
import { evaluate, type Decision, type RiskPolicy, type Tier } from "../policy/engine.ts";
import { loadRiskPolicy } from "../policy/load.ts";
import type { Release } from "../release.ts";
import type { Validator } from "../schemas/validate.ts";
import { prepareSession, type SessionStage, type StageSpec } from "../session/options.ts";
import type { SessionRunner, StageOutcome } from "../session/runner.ts";
import type { EventStore, State } from "../store/events.ts";
import { currentState, currentStatePayload, isTerminal, transition } from "../task/lifecycle.ts";
import { loadProfile, readTask, type Profile, type Task } from "../task/task.ts";
import { OUTPUTS } from "./outputs.ts";
import { approvePrompt, buildPrompt, reviewPrompt, specPrompt, summarizePrompt, triagePrompt, type TaskText } from "./prompts.ts";

export interface Deps {
  runner: SessionRunner;
  runGates: (o: GateRunOptions) => Promise<GatesResult>;
  gateImage: () => string;
  /** null: push only, the operator opens the PR (no GitHub token). */
  github: GitHub | null;
  auth: GitAuth | null;
  keyFile: string;
  gatesFetchNetwork?: string;
  gatesCaFile?: string;
  log: (line: string) => void;
}

export interface PipelineInputs {
  home: Home;
  store: EventStore;
  validator: Validator;
  release: Release;
  deps: Deps;
  taskId: string;
  abort?: AbortController;
}

interface Checkout {
  remote: string;
  mirror: string;
  branch: string;
  base_branch: string;
  base_commit: string;
}

interface Triage {
  kind: string;
  proposed_tier: Tier;
  uncertain: boolean;
  duplicate_of: string | null;
  summary: string;
}

interface Spec {
  scope: { include: string[]; exclude: string[] };
  acceptance_criteria: { id: string; statement: string; verification: string }[];
  operation_requested?: boolean;
  human_gate: { required: boolean; reason?: string };
}

/** Thrown to end a run after the task reached a terminal or waiting state. */
class Stop extends Error {}

/** The P0 forward path; NEEDS_HUMAN ranks by its gate (spec 3, merge 8). */
const FORWARD: readonly State[] = ["RECEIVED", "TRIAGED", "SPECIFIED", "NEEDS_HUMAN", "BUILDING", "VERIFYING", "REVIEWING", "POLICY"];
const DIFF_LIMIT = 400_000;
const CLAUDE_MD_LIMIT = 20_000;
const PREFLIGHT_MS = 1_500_000;
const SDK_FAILURES: Record<string, string> = {
  error_max_turns: "max_turns",
  error_max_budget_usd: "budget_exceeded",
  error_max_structured_output_retries: "schema_invalid",
  error_during_execution: "api_error",
  no_result: "api_error",
};

export async function runTask(inputs: PipelineInputs): Promise<State> {
  const { home, store, validator, release, deps, taskId } = inputs;
  const task: Task = readTask(home, taskId);
  const profilePath = task.target.profile;
  const profile: Profile = loadProfile(profilePath, validator);
  const risk: RiskPolicy = loadRiskPolicy(release.root, profilePath);
  const dir = runDir(home, taskId);
  const worktree = worktreeDir(home, taskId);
  const bundleDir = join(dir, "bundle");
  const workDir = (label: string): string => {
    const d = join(dir, "work", label);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  };
  const created = store.events(taskId).find((e) => e.type === "task_created");
  const remote = typeof created?.payload["remote"] === "string" ? created.payload["remote"] : "";
  const protectedGlobs = [...profile.protected_paths.map((p) => p.glob), ...profile.restricted.map((r) => r.glob)];
  const text: TaskText = { title: task.title, body: readFileSync(join(dir, "task.md"), "utf8"), trust: task.text_trust };

  // --- small helpers -------------------------------------------------------------------
  const state = (): State => currentState(store.events(taskId));
  const emit = (type: "stage_started" | "stage_completed" | "stage_failed" | "side_effect_intent" | "side_effect_done", payload: Record<string, unknown>): void => {
    store.append({ task_id: taskId, actor: { kind: "factoryctl", id: "factoryctl" }, type, payload });
  };
  // Exit transitions only move forward: re-applying an earlier stage's exit on resume is a no-op.
  const rank = (s: State, gate: unknown): number => (s === "NEEDS_HUMAN" ? (gate === "merge" ? 8 : 3) : FORWARD.indexOf(s));
  const moveTo = (to: State, payload: Record<string, unknown> = {}): void => {
    const events = store.events(taskId);
    const now = currentState(events);
    if (now === to || (!isTerminal(now) && rank(now, currentStatePayload(events)["gate"]) >= rank(to, payload["gate"]) && rank(to, payload["gate"]) >= 0)) return;
    transition(store, taskId, to, payload);
  };
  const fail = (stage: string, category: string, reason: string): never => {
    emit("stage_failed", { stage, category, reason });
    if (!isTerminal(state())) transition(store, taskId, "FAILED", { stage, category, reason });
    deps.log(`${taskId}: ${stage} failed (${category}): ${reason}`);
    throw new Stop();
  };
  const has = (name: string): boolean => existsSync(join(dir, name));
  const readJson = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const writeArtifact = (name: string, data: unknown, schema: string | null): void => {
    if (schema !== null) {
      const check = validator.validate(schema, data);
      if (!check.valid) fail(name, "schema_invalid", `${name}: ${check.errors.slice(0, 5).join("; ")}`);
    }
    writeFileSync(join(dir, name), name.endsWith(".yaml") ? stringify(data) : `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  };
  const checkCancelled = (): void => {
    if (isTerminal(state())) throw new Stop();
  };

  async function session(spec: StageSpec): Promise<StageOutcome> {
    checkCancelled();
    const prepared = prepareSession({ home, taskId, release, validator, keyFile: deps.keyFile, ...(inputs.abort === undefined ? {} : { abort: inputs.abort }) }, spec);
    emit("stage_started", { stage: spec.stage, label: spec.label });
    deps.log(`${taskId}: ${spec.label}`);
    const transcript = join(dir, "transcripts", `${spec.label}.ndjson`);
    rmSync(transcript, { force: true });
    const outcome = await deps.runner.run({ label: spec.label, prompt: spec.prompt, options: prepared.options, transcript, denials: prepared.denials });
    const routing = release.config.routing[spec.agent];
    emit("stage_completed", {
      stage: spec.stage,
      label: spec.label,
      ok: outcome.ok,
      subtype: outcome.subtype,
      alias: routing?.model ?? "",
      models: outcome.models,
      cost_usd: outcome.costUsd,
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      num_turns: outcome.numTurns,
      denied: outcome.denied,
    });
    if (!outcome.ok) fail(spec.stage, SDK_FAILURES[outcome.subtype] ?? "api_error", `${spec.label} ended with ${outcome.subtype}${outcome.errors.length > 0 ? `: ${outcome.errors.join("; ")}` : ""}`);
    if (spec.outputSchema !== undefined && (typeof outcome.structured !== "object" || outcome.structured === null)) {
      fail(spec.stage, "schema_invalid", `${spec.label} returned no structured output`);
    }
    return outcome;
  }

  const readOnlyGuard = (root: string, taskDir: string, readable: string[] = []): StageSpec["guard"] => ({
    worktree: root,
    task_dir: taskDir,
    protected_paths: protectedGlobs,
    scope: null,
    writable_task_files: [],
    secret_paths: [],
    readable_roots: readable,
  });

  // --- checkout: the bare mirror and the task's own clone -------------------------------
  const checkout = (): Checkout => {
    if (has("checkout.json")) return readJson("checkout.json") as Checkout;
    const mirror = syncMirror(home.mirrors, task.target.repo, remote, deps.auth);
    const baseBranch = task.target.base_branch ?? profile.target.default_branch;
    const base = resolveCommit(mirror, `refs/heads/${baseBranch}`);
    rmSync(worktree, { recursive: true, force: true });
    createTaskClone(mirror, worktree, `factory/${taskId}`, base);
    const c: Checkout = { remote, mirror, branch: `factory/${taskId}`, base_branch: baseBranch, base_commit: base };
    writeArtifact("checkout.json", c, null);
    return c;
  };

  // --- stages ----------------------------------------------------------------------------
  const triage = async (): Promise<void> => {
    const outcome = await session({
      stage: "triage", agent: "triager", label: "triage", cwd: worktree, prompt: triagePrompt(text), outputSchema: OUTPUTS.triage(),
      extraDirs: [], guard: readOnlyGuard(worktree, workDir("triage")),
    });
    writeArtifact("triage.json", { schema_version: 1, task_id: taskId, ...(outcome.structured as object) }, "triage.schema.json");
  };

  const provisionalTier = (spec: Spec, t: Triage): Decision =>
    evaluate(
      {
        files: spec.scope.include.flatMap((p) => [p, `${p.replace(/\/$/, "")}/__scope__`]).map((path) => ({ path, additions: 1, deletions: 0 })),
        sinksAdded: [],
        secretMaterial: false,
        classificationUncertain: t.uncertain,
        operationRequested: spec.operation_requested === true,
        graphHopsToProtected: null,
        proposedTier: t.proposed_tier,
      },
      risk,
    );

  const spec = async (): Promise<void> => {
    const t = readJson("triage.json") as Triage;
    const claudeMdPath = join(worktree, "CLAUDE.md");
    const claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8").slice(0, CLAUDE_MD_LIMIT) : null;
    const outcome = await session({
      stage: "spec", agent: "spec-writer", label: "spec", cwd: worktree,
      prompt: specPrompt(text, { triageSummary: t.summary, invariants: (profile.invariants ?? []).map((i) => `${i.id}: ${i.text}`), claudeMd, specDir: profile.spec_dir }),
      outputSchema: OUTPUTS.spec(), extraDirs: [], guard: readOnlyGuard(worktree, workDir("spec")),
    });
    const { markdown, ...fields } = outcome.structured as { markdown: string } & Record<string, unknown>;
    const full = { schema_version: 1, id: taskId, ...fields };
    const check = validator.validate("spec.schema.json", full);
    if (!check.valid) fail("spec", "schema_invalid", `spec.yaml: ${check.errors.slice(0, 5).join("; ")}`);
    writeFileSync(join(dir, "spec.md"), `${markdown.trimEnd()}\n`, { mode: 0o600 });
    writeArtifact("spec.yaml", full, "spec.schema.json");
  };

  const specExit = (): void => {
    moveTo("SPECIFIED");
    const s = parse(readFileSync(join(dir, "spec.yaml"), "utf8")) as Spec;
    const t = readJson("triage.json") as Triage;
    const tier = provisionalTier(s, t).tier;
    const reasons = [
      ...(s.human_gate.required ? [`the spec asks for a human gate: ${s.human_gate.reason ?? "no reason given"}`] : []),
      ...(tier === "R3" || tier === "Restricted" ? [`provisional tier ${tier}`] : []),
    ];
    if (reasons.length === 0) return;
    const events = store.events(taskId);
    const gateIndex = events.findLastIndex((e) => e.type === "state_changed" && e.to === "NEEDS_HUMAN" && e.payload["gate"] === "spec");
    const approved = gateIndex >= 0 && events.slice(gateIndex).some((e) => e.type === "command" && e.payload["command"] === "approve" && e.payload["gate"] === "spec");
    if (approved) return;
    moveTo("NEEDS_HUMAN", { gate: "spec", reasons });
    deps.log(`${taskId}: waiting for a human at the spec gate (${reasons.join("; ")}); approve with: factoryctl approve ${taskId} --gate spec --reason "…"`);
    throw new Stop();
  };

  const build = async (c: Checkout): Promise<void> => {
    moveTo("BUILDING");
    const s = parse(readFileSync(join(dir, "spec.yaml"), "utf8")) as Spec;
    const work = workDir("build");
    const preflight = {
      argv: [process.execPath, "--disable-warning=ExperimentalWarning", release.gatesCli, "run", "--worktree", worktree, "--base", c.base_commit, "--task", taskId, "--profile", profilePath, "--out", join(work, "preflight-gates.json")],
      timeout_ms: PREFLIGHT_MS,
    };
    await session({
      stage: "build", agent: "builder", label: "build", cwd: worktree,
      prompt: buildPrompt({ specYaml: readFileSync(join(dir, "spec.yaml"), "utf8"), taskDir: work, findings: null }),
      extraDirs: [work],
      guard: { worktree, task_dir: work, protected_paths: protectedGlobs, scope: s.scope, writable_task_files: ["build-report.md", "build-failure.json"], secret_paths: [], readable_roots: [] },
      preflight,
    });
    if (existsSync(join(work, "build-failure.json"))) {
      const reason = (JSON.parse(readFileSync(join(work, "build-failure.json"), "utf8")) as { reason?: string }).reason ?? "no reason given";
      fail("build", "build_failed", `the builder recorded a failure: ${reason}`);
    }
    commitAll(worktree, `factory: ${taskId} changes the builder left uncommitted`);
    const candidate = head(worktree);
    if (candidate === c.base_commit) fail("build", "no_change", "the builder made no change");
    writeArtifact("build.json", { base_commit: c.base_commit, candidate_commit: candidate }, null);
  };

  const gates = async (c: Checkout): Promise<void> => {
    moveTo("VERIFYING");
    emit("stage_started", { stage: "gates", label: "gates" });
    const result = await deps.runGates({
      worktree, base: c.base_commit, taskId, profile, image: deps.gateImage(), cacheVolume: cacheVolumeFor(task.target.repo), osvVolume: "sf-gates-osv",
      ...(deps.gatesFetchNetwork === undefined ? {} : { fetchNetwork: deps.gatesFetchNetwork }),
      ...(deps.gatesCaFile === undefined ? {} : { caFile: deps.gatesCaFile }),
      log: (l) => {
        deps.log(`${taskId}: gates: ${l}`);
      },
    });
    writeArtifact("gates.json", result, "gates.schema.json");
    emit("stage_completed", { stage: "gates", label: "gates", ok: result.passed, failing: result.gates.filter((g) => g.status !== "pass").map((g) => g.name) });
  };

  const gatesExit = (): void => {
    const result = readJson("gates.json") as GatesResult;
    if (!result.passed) fail("gates", "gate_fail", `gates failed: ${result.gates.filter((g) => g.status !== "pass").map((g) => g.name).join(", ")}`);
  };

  const prepareBundle = (c: Checkout, candidate: string): void => {
    mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(bundleDir, "diff.patch"), diffPatch(worktree, c.base_commit, candidate, DIFF_LIMIT));
    writeFileSync(join(bundleDir, "changed-files.txt"), changedFiles(worktree, c.base_commit, candidate).map((f) => `${f.path}\t+${String(f.additions)}\t-${String(f.deletions)}`).join("\n") + "\n");
    for (const f of ["spec.yaml", "spec.md", "gates.json"]) copyFileSync(join(dir, f), join(bundleDir, f));
  };

  const REVIEWERS = [
    { label: "review-code", agent: "code-reviewer", focus: "correctness, maintainability and test adequacy, checked against every acceptance criterion and invariant in the spec" },
    { label: "review-security", agent: "security-reviewer", focus: "authorization, injection, secrets and data exposure; try to construct an exploit before you report one" },
  ] as const;

  const review = async (c: Checkout, candidate: string): Promise<void> => {
    moveTo("REVIEWING");
    prepareBundle(c, candidate);
    for (const r of REVIEWERS) {
      if (has(`${r.label}.json`)) continue;
      const outcome = await session({
        stage: "review", agent: r.agent, label: r.label, cwd: worktree, prompt: reviewPrompt({ bundleDir, focus: r.focus }),
        outputSchema: OUTPUTS.review(), extraDirs: [bundleDir], guard: readOnlyGuard(worktree, workDir(r.label), [bundleDir]),
      });
      const model = outcome.models[0] ?? release.config.model_pins[release.config.routing[r.agent]?.model ?? ""] ?? "unknown";
      writeArtifact(`${r.label}.json`, { schema_version: 1, task_id: taskId, reviewer: r.agent, model, candidate_commit: candidate, ...(outcome.structured as object) }, "review.schema.json");
    }
  };

  const policyDecision = (c: Checkout, candidate: string): Decision => {
    const g = readJson("gates.json") as GatesResult;
    const t = readJson("triage.json") as Triage;
    const s = parse(readFileSync(join(dir, "spec.yaml"), "utf8")) as Spec;
    return evaluate(
      {
        files: changedFiles(worktree, c.base_commit, candidate),
        sinksAdded: g.signals.sink_added,
        secretMaterial: g.signals.secret_material,
        classificationUncertain: t.uncertain,
        operationRequested: s.operation_requested === true,
        graphHopsToProtected: null,
        proposedTier: t.proposed_tier,
      },
      risk,
    );
  };

  const approve = async (c: Checkout, candidate: string): Promise<void> => {
    const decision = policyDecision(c, candidate);
    writeArtifact("policy.json", decision, null);
    mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
    for (const f of ["policy.json", ...REVIEWERS.map((r) => `${r.label}.json`)]) copyFileSync(join(dir, f), join(bundleDir, f));
    const outcome = await session({
      stage: "approve", agent: "approver", label: "approve", cwd: bundleDir, prompt: approvePrompt({ bundleDir }),
      outputSchema: OUTPUTS.verdict(), extraDirs: [], guard: readOnlyGuard(bundleDir, workDir("approve")),
    });
    writeArtifact("verdict.json", { schema_version: 1, task_id: taskId, candidate_commit: candidate, tier: decision.tier, ...(outcome.structured as object) }, "verdict.schema.json");
  };

  const approveExit = (): void => {
    const verdict = readJson("verdict.json") as { decision: string; rationale: string };
    if (verdict.decision === "reject") fail("approve", "review_block", `the approver rejected the change: ${verdict.rationale}`);
    moveTo("POLICY");
  };

  const summarize = async (): Promise<void> => {
    copyFileSync(join(dir, "verdict.json"), join(bundleDir, "verdict.json"));
    const outcome = await session({
      stage: "summarize", agent: "summarizer", label: "summarize", cwd: bundleDir, prompt: summarizePrompt({ bundleDir }),
      outputSchema: OUTPUTS.summary(), extraDirs: [], guard: readOnlyGuard(bundleDir, workDir("summarize")),
    });
    writeArtifact("summary.json", { schema_version: 1, task_id: taskId, ...(outcome.structured as object) }, "summary.schema.json");
  };

  const publish = async (c: Checkout, candidate: string): Promise<void> => {
    const decision = readJson("policy.json") as Decision;
    emit("side_effect_intent", { kind: "push", branch: c.branch, commit: candidate });
    const pushed = pushFromMirror(c.mirror, worktree, c.branch, c.remote, deps.auth);
    if (pushed !== candidate) fail("publish", "merge_conflict", `the mirror holds ${pushed} for ${c.branch}, not ${candidate}`);
    emit("side_effect_done", { kind: "push", branch: c.branch, commit: pushed });
    let pr: { number: number; url: string } | null = null;
    if (deps.github !== null) {
      const summary = readJson("summary.json") as { pr_body: string };
      const footer = `\n\n---\nFactory task ${taskId} · tier ${decision.tier} · candidate ${candidate.slice(0, 12)} · the policy engine, not a model, decides what may merge.`;
      emit("side_effect_intent", { kind: "pull_request", branch: c.branch });
      pr = (await deps.github.findPullRequest(task.target.repo, c.branch)) ?? (await deps.github.createPullRequest({
        repo: task.target.repo, head: c.branch, base: c.base_branch, title: `[factory] ${taskId}: ${task.title}`, body: summary.pr_body + footer, draft: decision.tier === "Restricted",
      }));
      emit("side_effect_done", { kind: "pull_request", number: pr.number, url: pr.url });
    }
    writeArtifact("publish.json", { branch: c.branch, head_commit: pushed, pr_number: pr?.number ?? null, pr_url: pr?.url ?? null }, null);
  };

  const publishExit = (): void => {
    const p = readJson("publish.json") as { pr_url: string | null };
    const decision = readJson("policy.json") as Decision;
    // P0–P1: a human merges every tier (ROADMAP §4).
    moveTo("NEEDS_HUMAN", { gate: "merge", tier: decision.tier, pr_url: p.pr_url });
    throw new Stop();
  };

  // --- the run loop ----------------------------------------------------------------------
  try {
    const initial = state();
    if (isTerminal(initial)) return initial;
    if (initial === "NEEDS_HUMAN" && currentStatePayload(store.events(taskId))["gate"] === "merge") return initial;

    const c = checkout();
    const candidate = (): string => (readJson("build.json") as { candidate_commit: string }).candidate_commit;
    const steps: { name: SessionStage | "gates" | "publish"; done: () => boolean; run: () => Promise<void>; exit: () => void }[] = [
      { name: "triage", done: () => has("triage.json"), run: triage, exit: () => {
        moveTo("TRIAGED");
      } },
      { name: "spec", done: () => has("spec.yaml"), run: spec, exit: specExit },
      { name: "build", done: () => has("build.json"), run: () => build(c), exit: () => undefined },
      { name: "gates", done: () => has("gates.json"), run: () => gates(c), exit: gatesExit },
      { name: "review", done: () => REVIEWERS.every((r) => has(`${r.label}.json`)), run: () => review(c, candidate()), exit: () => undefined },
      { name: "approve", done: () => has("verdict.json"), run: () => approve(c, candidate()), exit: approveExit },
      { name: "summarize", done: () => has("summary.json"), run: summarize, exit: () => undefined },
      { name: "publish", done: () => has("publish.json"), run: () => publish(c, candidate()), exit: publishExit },
    ];
    for (const step of steps) {
      checkCancelled();
      if (!step.done()) await step.run();
      step.exit();
    }
  } catch (e) {
    if (!(e instanceof Stop)) {
      if (!isTerminal(state())) {
        emit("stage_failed", { stage: "run", category: "api_error", reason: e instanceof Error ? e.message : String(e) });
        transition(store, taskId, "FAILED", { category: "api_error", reason: e instanceof Error ? e.message : String(e) });
      }
      throw e;
    }
  } finally {
    if (has("build.json")) writeManifest({ dir, taskId, store, validator, release, risk });
  }
  return state();
}
