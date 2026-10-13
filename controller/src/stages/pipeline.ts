// factoryctl run: one task through triage → spec → build → gates → review → policy → approve →
// summarize → publish (ROADMAP §2.1; one round, humans merge every tier). Each step commits its
// artifacts through the commit protocol (commit.ts), so a crash leaves a step committed or not,
// and `resume` continues from the first step whose commit is missing or stale; each step's exit
// transition is idempotent, so a crash between a commit and its transition is repaired on resume.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { GatesResult, RunOptions as GateRunOptions } from "../../../gates/src/run.ts";
import { cacheVolumeFor } from "../../../gates/src/run.ts";
import { writeManifest } from "../bundle/manifest.ts";
import { changedFiles, commitAll, createTaskClone, diffPatch, GitError, head, pushFromMirror, resetClone, resolveCommit, syncMirror, type GitAuth } from "../git/repo.ts";
import type { GitHub } from "../github/client.ts";
import { describeHalt, readHalt } from "../halt.ts";
import { runDir, worktreeDir, type Home } from "../home.ts";
import { evaluate, type Decision, type RiskPolicy, type Tier } from "../policy/engine.ts";
import { loadRiskPolicy } from "../policy/load.ts";
import type { Release } from "../release.ts";
import type { Validator } from "../schemas/validate.ts";
import { prepareSession, type StageSpec } from "../session/options.ts";
import type { SessionRunner, StageOutcome } from "../session/runner.ts";
import type { EventStore, State } from "../store/events.ts";
import { canMove, currentState, currentStatePayload, isTerminal, transition } from "../task/lifecycle.ts";
import { loadProfile, readTask, type Profile, type Task } from "../task/task.ts";
import { buildCategory, sdkCategory, type Category } from "../task/taxonomy.ts";
import { commitArtifacts, freshness, inputsOf, recover, specDigest, type Output } from "./commit.ts";
import { OUTPUTS } from "./outputs.ts";
import { approvePrompt, buildPrompt, reviewPrompt, specPrompt, summarizePrompt, triagePrompt, type TaskText } from "./prompts.ts";

export interface Deps {
  runner: SessionRunner;
  runGates: (o: GateRunOptions) => Promise<GatesResult>;
  /** Builds the gate image if it is missing; called in factoryctl's own environment. */
  gateImage: () => string;
  /** Settings the build-stage preflight needs to reach the container engine (DOCKER_HOST and the FACTORY_* gate settings); never a credential. */
  engineEnv?: () => Record<string, string>;
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

/** Thrown before a run for a task an earlier factoryctl started without the commit protocol. */
export class ProtocolError extends Error {}

interface Step {
  label: string;
  stage: string;
  /** Committed files, relative to the run directory, whose digests key the step. */
  inputs: string[];
  run: () => Promise<Output[]>;
  /** The step's transition; idempotent and forward-only, so it is re-applied on every run. */
  exit: () => void;
}

/** The P0 forward path; NEEDS_HUMAN ranks by its gate (spec 3, merge 8). */
const FORWARD: readonly State[] = ["RECEIVED", "TRIAGED", "SPECIFIED", "NEEDS_HUMAN", "BUILDING", "VERIFYING", "REVIEWING", "POLICY"];
const DIFF_LIMIT = 400_000;
const CLAUDE_MD_LIMIT = 20_000;
const PREFLIGHT_MS = 1_500_000;
/** Phase 1 runs one round; remediation rounds arrive with P1-01. */
const ROUND = 1;

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
  if (created?.payload["commit_protocol"] !== 1 && store.events(taskId).some((e) => e.type === "stage_started")) {
    throw new ProtocolError(`${taskId} was started by a factoryctl without the commit protocol (v0.1.x); finish it on that release (factoryctl release use v0.1.2) or create a new task`);
  }

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
  // `cause` keeps what the pipeline saw when it differs from the category (P1-07).
  const fail = (stage: string, category: Category, reason: string, cause?: string): never => {
    const detail = { stage, category, reason, ...(cause === undefined ? {} : { cause }) };
    emit("stage_failed", detail);
    if (!isTerminal(state())) transition(store, taskId, "FAILED", detail);
    deps.log(`${taskId}: ${stage} failed (${category}): ${reason}`);
    throw new Stop();
  };
  const has = (name: string): boolean => existsSync(join(dir, name));
  const readJson = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"));
  let currentStage = "run";
  /** A validated artifact, serialized; nothing is written until the step commits. */
  const out = (path: string, data: unknown, schema: string | null): Output => {
    if (schema !== null) {
      const check = validator.validate(schema, data);
      if (!check.valid) fail(currentStage, "schema_invalid", `${path}: ${check.errors.slice(0, 5).join("; ")}`);
    }
    return { path, content: path.endsWith(".yaml") ? stringify(data) : `${JSON.stringify(data, null, 2)}\n` };
  };
  // A cancelled task ends; a halted factory stops without failing the task, which resumes later.
  const checkStop = (): void => {
    if (isTerminal(state())) throw new Stop();
    const halt = readHalt(home);
    if (halt === null) return;
    deps.log(`${taskId}: stopped, the factory is ${describeHalt(halt)}`);
    throw new Stop();
  };

  async function session(spec: StageSpec): Promise<StageOutcome> {
    checkStop();
    const prepared = prepareSession({ home, taskId, release, validator, keyFile: deps.keyFile, ...(inputs.abort === undefined ? {} : { abort: inputs.abort }) }, spec);
    // The runner kind and the env's names (never values) are the evidence for G0-1 and G0-3.
    emit("stage_started", { stage: spec.stage, label: spec.label, runner: deps.runner.kind, env_keys: Object.keys(prepared.env).sort() });
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
      duration_ms: outcome.durationMs,
      runner: deps.runner.kind,
      round: ROUND,
      denied: outcome.denied,
    });
    checkStop();
    if (!outcome.ok) fail(spec.stage, sdkCategory(outcome.subtype), `${spec.label} ended with ${outcome.subtype}${outcome.errors.length > 0 ? `: ${outcome.errors.join("; ")}` : ""}`, outcome.subtype);
    if (spec.outputSchema !== undefined && (typeof outcome.structured !== "object" || outcome.structured === null)) {
      fail(spec.stage, "schema_invalid", `${spec.label} returned no structured output`);
    }
    return outcome;
  }

  const denials = (o: StageOutcome): string => (o.denied.length === 0 ? "" : `; ${String(o.denied.length)} tool call(s) denied`);

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
  const checkoutInfo = (): Checkout => readJson("checkout.json") as Checkout;
  const candidate = (): string => (readJson("build.json") as { candidate_commit: string }).candidate_commit;

  const checkout = (): Promise<Output[]> => {
    const mirror = syncMirror(home.mirrors, task.target.repo, remote, deps.auth);
    const baseBranch = task.target.base_branch ?? profile.target.default_branch;
    const base = resolveCommit(mirror, `refs/heads/${baseBranch}`);
    rmSync(worktree, { recursive: true, force: true });
    createTaskClone(mirror, worktree, `factory/${taskId}`, base);
    const c: Checkout = { remote, mirror, branch: `factory/${taskId}`, base_branch: baseBranch, base_commit: base };
    return Promise.resolve([out("checkout.json", c, null)]);
  };

  // --- stages ----------------------------------------------------------------------------
  const triage = async (): Promise<Output[]> => {
    const outcome = await session({
      stage: "triage", agent: "triager", label: "triage", cwd: worktree, prompt: triagePrompt(text), outputSchema: OUTPUTS.triage(),
      extraDirs: [], guard: readOnlyGuard(worktree, workDir("triage")),
    });
    return [out("triage.json", { schema_version: 1, task_id: taskId, ...(outcome.structured as object) }, "triage.schema.json")];
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

  const spec = async (): Promise<Output[]> => {
    const t = readJson("triage.json") as Triage;
    const claudeMdPath = join(worktree, "CLAUDE.md");
    const claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8").slice(0, CLAUDE_MD_LIMIT) : null;
    const outcome = await session({
      stage: "spec", agent: "spec-writer", label: "spec", cwd: worktree,
      prompt: specPrompt(text, { triageSummary: t.summary, invariants: (profile.invariants ?? []).map((i) => `${i.id}: ${i.text}`), claudeMd, specDir: profile.spec_dir }),
      outputSchema: OUTPUTS.spec(), extraDirs: [], guard: readOnlyGuard(worktree, workDir("spec")),
    });
    const { markdown, ...fields } = outcome.structured as { markdown: string } & Record<string, unknown>;
    return [out("spec.yaml", { schema_version: 1, id: taskId, ...fields }, "spec.schema.json"), { path: "spec.md", content: `${markdown.trimEnd()}\n` }];
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
    // An approval holds for the spec it was given on: a spec that ran again needs a new one.
    const digest = specDigest(dir);
    const approved = store.events(taskId).some((e) => e.type === "command" && e.payload["command"] === "approve" && e.payload["gate"] === "spec" && e.payload["spec_digest"] === digest);
    if (approved) return;
    const gate = { gate: "spec", reasons };
    const now = state();
    // A spec that changed after the build started goes back to the gate through BLOCKED.
    if (now !== "NEEDS_HUMAN" && !canMove(now, "NEEDS_HUMAN")) {
      transition(store, taskId, "BLOCKED", gate);
      transition(store, taskId, "SPECIFIED", {});
    }
    moveTo("NEEDS_HUMAN", gate);
    deps.log(`${taskId}: waiting for a human at the spec gate (${reasons.join("; ")}); approve with: factoryctl approve ${taskId} --gate spec --reason "…"`);
    throw new Stop();
  };

  const build = async (): Promise<Output[]> => {
    moveTo("BUILDING");
    const c = checkoutInfo();
    const s = parse(readFileSync(join(dir, "spec.yaml"), "utf8")) as Spec;
    // A re-run build starts where the first one did: at the base, with an empty work directory.
    resetClone(worktree, c.base_commit);
    rmSync(join(dir, "work", "build"), { recursive: true, force: true });
    const work = workDir("build");
    // The preflight runs from the builder's Stop hook, in the session's stripped environment
    // (per-task HOME, allowlisted env), so it gets a ready image and the engine's endpoint
    // rather than building anything itself.
    const gateRun = [
      process.execPath, "--disable-warning=ExperimentalWarning", release.gatesCli, "run", "--worktree", worktree, "--base", c.base_commit, "--task", taskId,
      "--profile", profilePath, "--out", join(work, "preflight-gates.json"), "--image", deps.gateImage(), "--cache-volume", cacheVolumeFor(task.target.repo), "--osv-volume", "sf-gates-osv",
    ];
    const engine = Object.entries(deps.engineEnv?.() ?? {}).map(([k, v]) => `${k}=${v}`);
    const preflight = { argv: engine.length === 0 ? gateRun : ["/usr/bin/env", ...engine, ...gateRun], timeout_ms: PREFLIGHT_MS };
    const outcome = await session({
      stage: "build", agent: "builder", label: "build", cwd: worktree,
      prompt: buildPrompt({ specYaml: readFileSync(join(dir, "spec.yaml"), "utf8"), taskDir: work, findings: null }),
      extraDirs: [work],
      guard: { worktree, task_dir: work, protected_paths: protectedGlobs, scope: s.scope, writable_task_files: ["build-report.md", "build-failure.json"], secret_paths: [], readable_roots: [] },
      preflight,
    });
    if (existsSync(join(work, "build-failure.json"))) {
      const reason = (JSON.parse(readFileSync(join(work, "build-failure.json"), "utf8")) as { reason?: string }).reason ?? "no reason given";
      fail("build", buildCategory(outcome.denied.length), `the builder recorded a failure: ${reason}${denials(outcome)}`, "build_failed");
    }
    commitAll(worktree, `factory: ${taskId} changes the builder left uncommitted`);
    const built = head(worktree);
    if (built === c.base_commit) fail("build", buildCategory(outcome.denied.length), `the builder made no change${denials(outcome)}`, "no_change");
    return [out("build.json", { base_commit: c.base_commit, candidate_commit: built }, null)];
  };

  const gates = async (): Promise<Output[]> => {
    moveTo("VERIFYING");
    const c = checkoutInfo();
    emit("stage_started", { stage: "gates", label: "gates" });
    const started = Date.now();
    const result = await deps.runGates({
      worktree, base: c.base_commit, taskId, profile, image: deps.gateImage(), cacheVolume: cacheVolumeFor(task.target.repo), osvVolume: "sf-gates-osv",
      ...(deps.gatesFetchNetwork === undefined ? {} : { fetchNetwork: deps.gatesFetchNetwork }),
      ...(deps.gatesCaFile === undefined ? {} : { caFile: deps.gatesCaFile }),
      log: (l) => {
        deps.log(`${taskId}: gates: ${l}`);
      },
    });
    const artifact = out("gates.json", result, "gates.schema.json");
    emit("stage_completed", { stage: "gates", label: "gates", ok: result.passed, failing: result.gates.filter((g) => g.status !== "pass").map((g) => g.name), duration_ms: Date.now() - started, round: ROUND });
    return [artifact];
  };

  const gatesExit = (): void => {
    const result = readJson("gates.json") as GatesResult;
    if (!result.passed) fail("gates", "gate_fail", `gates failed: ${result.gates.filter((g) => g.status !== "pass").map((g) => g.name).join(", ")}`);
  };

  /** The judges' read-only bundle: derived from committed artifacts, rebuilt before every judging session. */
  const prepareBundle = (copies: readonly string[]): void => {
    const c = checkoutInfo();
    const cand = candidate();
    mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(bundleDir, "diff.patch"), diffPatch(worktree, c.base_commit, cand, DIFF_LIMIT));
    writeFileSync(join(bundleDir, "changed-files.txt"), changedFiles(worktree, c.base_commit, cand).map((f) => `${f.path}\t+${String(f.additions)}\t-${String(f.deletions)}`).join("\n") + "\n");
    for (const f of ["spec.yaml", "spec.md", "gates.json", ...copies]) copyFileSync(join(dir, f), join(bundleDir, f));
  };

  const REVIEWERS = [
    { label: "review-code", agent: "code-reviewer", focus: "correctness, maintainability and test adequacy, checked against every acceptance criterion and invariant in the spec" },
    { label: "review-security", agent: "security-reviewer", focus: "authorization, injection, secrets and data exposure; try to construct an exploit before you report one" },
  ] as const;

  const review = (r: (typeof REVIEWERS)[number]) => async (): Promise<Output[]> => {
    moveTo("REVIEWING");
    prepareBundle([]);
    const outcome = await session({
      stage: "review", agent: r.agent, label: r.label, cwd: worktree, prompt: reviewPrompt({ bundleDir, focus: r.focus }),
      outputSchema: OUTPUTS.review(), extraDirs: [bundleDir], guard: readOnlyGuard(worktree, workDir(r.label), [bundleDir]),
    });
    const model = outcome.models[0] ?? release.config.model_pins[release.config.routing[r.agent]?.model ?? ""] ?? "unknown";
    return [out(`${r.label}.json`, { schema_version: 1, task_id: taskId, reviewer: r.agent, model, candidate_commit: candidate(), ...(outcome.structured as object) }, "review.schema.json")];
  };

  // The policy engine, not a model, decides the tier: a deterministic step of its own.
  const policy = (): Promise<Output[]> => {
    const c = checkoutInfo();
    const g = readJson("gates.json") as GatesResult;
    const t = readJson("triage.json") as Triage;
    const s = parse(readFileSync(join(dir, "spec.yaml"), "utf8")) as Spec;
    const decision = evaluate(
      {
        files: changedFiles(worktree, c.base_commit, candidate()),
        sinksAdded: g.signals.sink_added,
        secretMaterial: g.signals.secret_material,
        classificationUncertain: t.uncertain,
        operationRequested: s.operation_requested === true,
        graphHopsToProtected: null,
        proposedTier: t.proposed_tier,
      },
      risk,
    );
    return Promise.resolve([out("policy.json", decision, null)]);
  };

  const approve = async (): Promise<Output[]> => {
    const decision = readJson("policy.json") as Decision;
    prepareBundle(["policy.json", ...REVIEWERS.map((r) => `${r.label}.json`)]);
    const outcome = await session({
      stage: "approve", agent: "approver", label: "approve", cwd: bundleDir, prompt: approvePrompt({ bundleDir }),
      outputSchema: OUTPUTS.verdict(), extraDirs: [], guard: readOnlyGuard(bundleDir, workDir("approve")),
    });
    return [out("verdict.json", { schema_version: 1, task_id: taskId, candidate_commit: candidate(), tier: decision.tier, ...(outcome.structured as object) }, "verdict.schema.json")];
  };

  const approveExit = (): void => {
    const verdict = readJson("verdict.json") as { decision: string; rationale: string };
    if (verdict.decision === "reject") fail("approve", "review_block", `the approver rejected the change: ${verdict.rationale}`);
    moveTo("POLICY");
  };

  const summarize = async (): Promise<Output[]> => {
    prepareBundle(["policy.json", ...REVIEWERS.map((r) => `${r.label}.json`), "verdict.json"]);
    const outcome = await session({
      stage: "summarize", agent: "summarizer", label: "summarize", cwd: bundleDir, prompt: summarizePrompt({ bundleDir }),
      outputSchema: OUTPUTS.summary(), extraDirs: [], guard: readOnlyGuard(bundleDir, workDir("summarize")),
    });
    return [out("summary.json", { schema_version: 1, task_id: taskId, ...(outcome.structured as object) }, "summary.schema.json")];
  };

  const publish = async (): Promise<Output[]> => {
    const c = checkoutInfo();
    const cand = candidate();
    const decision = readJson("policy.json") as Decision;
    emit("side_effect_intent", { kind: "push", branch: c.branch, commit: cand });
    const push = (): string => {
      try {
        return pushFromMirror(c.mirror, worktree, c.branch, c.remote, deps.auth);
      } catch (e) {
        // The branch moved on the remote: someone else's commits, never overwritten.
        if (e instanceof GitError && /\[rejected\]|non-fast-forward|fetch first/.test(e.message)) fail("publish", "merge_conflict", `the remote's ${c.branch} has commits the candidate lacks`, "push_rejected");
        throw e;
      }
    };
    const pushed = push();
    if (pushed !== cand) fail("publish", "merge_conflict", `the mirror holds ${pushed} for ${c.branch}, not ${cand}`);
    emit("side_effect_done", { kind: "push", branch: c.branch, commit: pushed });
    let pr: { number: number; url: string } | null = null;
    if (deps.github !== null) {
      const summary = readJson("summary.json") as { pr_body: string };
      const footer = `\n\n---\nFactory task ${taskId} · tier ${decision.tier} · candidate ${cand.slice(0, 12)} · the policy engine, not a model, decides what may merge.`;
      emit("side_effect_intent", { kind: "pull_request", branch: c.branch });
      pr = (await deps.github.findPullRequest(task.target.repo, c.branch)) ?? (await deps.github.createPullRequest({
        repo: task.target.repo, head: c.branch, base: c.base_branch, title: `[factory] ${taskId}: ${task.title}`, body: summary.pr_body + footer, draft: decision.tier === "Restricted",
      }));
      emit("side_effect_done", { kind: "pull_request", number: pr.number, url: pr.url });
    }
    return [out("publish.json", { branch: c.branch, head_commit: pushed, pr_number: pr?.number ?? null, pr_url: pr?.url ?? null }, null)];
  };

  const publishExit = (): void => {
    const p = readJson("publish.json") as { pr_url: string | null };
    const decision = readJson("policy.json") as Decision;
    // P0–P1: a human merges every tier (ROADMAP §4).
    moveTo("NEEDS_HUMAN", { gate: "merge", tier: decision.tier, pr_url: p.pr_url });
    throw new Stop();
  };

  // --- the run loop ----------------------------------------------------------------------
  // Each step names the committed files it reads: a step is done while its latest commit was
  // made from those inputs and its own files are intact (commit.ts).
  const noExit = (): void => undefined;
  const steps: Step[] = [
    { label: "checkout", stage: "checkout", inputs: ["task.json"], run: checkout, exit: noExit },
    { label: "triage", stage: "triage", inputs: ["task.json", "task.md"], run: triage, exit: () => {
      moveTo("TRIAGED");
    } },
    { label: "spec", stage: "spec", inputs: ["task.md", "triage.json"], run: spec, exit: specExit },
    { label: "build", stage: "build", inputs: ["checkout.json", "spec.yaml"], run: build, exit: noExit },
    { label: "gates", stage: "gates", inputs: ["build.json"], run: gates, exit: gatesExit },
    ...REVIEWERS.map((r): Step => ({ label: r.label, stage: "review", inputs: ["build.json", "gates.json", "spec.yaml", "spec.md"], run: review(r), exit: noExit })),
    { label: "policy", stage: "policy", inputs: ["build.json", "gates.json", "triage.json", "spec.yaml"], run: policy, exit: noExit },
    { label: "approve", stage: "approve", inputs: ["policy.json", ...REVIEWERS.map((r) => `${r.label}.json`)], run: approve, exit: approveExit },
    { label: "summarize", stage: "summarize", inputs: ["verdict.json"], run: summarize, exit: noExit },
    { label: "publish", stage: "publish", inputs: ["summary.json", "policy.json", "build.json"], run: publish, exit: publishExit },
  ];

  try {
    const initial = state();
    if (isTerminal(initial)) return initial;
    if (initial === "NEEDS_HUMAN" && currentStatePayload(store.events(taskId))["gate"] === "merge") return initial;
    const recovered = recover(dir, store.events(taskId));
    for (const p of recovered.rolledForward) deps.log(`${taskId}: recovered ${p}, committed before an interruption`);
    for (const p of recovered.removed) deps.log(`${taskId}: removed ${p}, never committed`);

    for (const step of steps) {
      checkStop();
      currentStage = step.stage;
      const stepInputs = inputsOf(dir, step.inputs);
      const fresh = freshness(dir, store.events(taskId), step.label, stepInputs);
      if (fresh !== "done") {
        if (fresh !== "never") deps.log(`${taskId}: ${step.label} runs again (${fresh === "inputs_changed" ? "its inputs changed" : "a committed file changed on disk"})`);
        const outputs = await step.run();
        commitArtifacts(store, dir, { taskId, stage: step.stage, label: step.label, round: ROUND }, stepInputs, outputs);
      }
      step.exit();
    }
  } catch (e) {
    if (!(e instanceof Stop)) {
      // A session aborted by `cancel` or `halt` ends the run; neither is a failure of the task.
      const halt = readHalt(home);
      if (halt !== null || state() === "CANCELLED") {
        deps.log(`${taskId}: stopped (${halt === null ? "cancelled" : `the factory is ${describeHalt(halt)}`}): ${e instanceof Error ? e.message : String(e)}`);
        return state();
      }
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
