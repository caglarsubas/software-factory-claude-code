// The transcript-replay suite (P0-07 "done when": replay tests run in CI with zero tokens).
// Each test drives the real pipeline (event store, lifecycle, session options, the in-process
// guard, git mirror and clone, policy engine, bundle, manifest, push) against a local bare
// "GitHub" remote, with recorded transcripts in place of model sessions, stubbed gates and a
// fake GitHub API. The container gates run end to end in gates.int.test.ts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { GatesResult } from "../../../gates/src/run.ts";
import type { GitHub, PullRequestInput } from "../github/client.ts";
import { clearHalt, setHalt } from "../halt.ts";
import { ensureHome, factoryHome, runDir, worktreeDir, type Home } from "../home.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { ENV_ALLOWLIST } from "../session/env.ts";
import { replayRunner, type Transcripts } from "../session/replay.ts";
import type { SessionRunner } from "../session/runner.ts";
import { answer, assistant, result, text, toolUse } from "../session/transcript.ts";
import { EventStore } from "../store/events.ts";
import { currentState, currentStatePayload } from "../task/lifecycle.ts";
import { createTask } from "../task/task.ts";
import { CATEGORIES } from "../task/taxonomy.ts";
import { captureTask } from "../evals/capture.ts";
import { specDigest } from "./commit.ts";
import { ProtocolError, runTask, type Deps } from "./pipeline.ts";

const validator = createValidator();
const release = loadRelease(validator);
const pins = release.config.model_pins;
const FIXTURE = join(REPO_ROOT, "gates/fixtures/ts");
const scratch = mkdtempSync(join(tmpdir(), "pipeline-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function sh(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (name === ".git") continue;
      if (spawnSync("test", ["-d", full]).status === 0) walk(full);
      else h.update(full).update(readFileSync(full));
    }
  };
  walk(dir);
  return h.digest("hex");
}

interface World {
  home: Home;
  store: EventStore;
  remote: string;
  operatorCheckout: string;
  profilePath: string;
  github: GitHub & { prs: PullRequestInput[] };
}

let world: World;

beforeEach(() => {
  const root = mkdtempSync(join(scratch, "world-"));
  // The operator's checkout of the target, and a bare remote standing in for GitHub.
  const operatorCheckout = join(root, "checkout");
  cpSync(FIXTURE, operatorCheckout, { recursive: true });
  sh(operatorCheckout, ["init", "-q", "-b", "main"]);
  sh(operatorCheckout, ["add", "-A"]);
  sh(operatorCheckout, ["commit", "-qm", "base"]);
  const remote = join(root, "remote.git");
  sh(root, ["clone", "-q", "--bare", operatorCheckout, remote]);

  const profile = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
  profile["target"] = { repo: "example/ts-mini", default_branch: "main", visibility: "private" };
  profile["commands"] = { setup: "pnpm install --frozen-lockfile", typecheck: "pnpm exec tsc --noEmit", test: "node --test" };
  profile["gates"] = { adapters: ["typescript"] };
  const profilePath = join(root, "profile.yaml");
  writeFileSync(profilePath, stringify(profile));

  const home = factoryHome({ FACTORY_HOME: join(root, "factory") });
  ensureHome(home);
  const prs: PullRequestInput[] = [];
  const github = {
    prs,
    findPullRequest: (_repo: string, head: string) => {
      const i = prs.findIndex((p) => p.head === head);
      return Promise.resolve(i < 0 ? null : { number: i + 1, url: `https://github.com/example/ts-mini/pull/${String(i + 1)}` });
    },
    createPullRequest: (input: PullRequestInput) => {
      prs.push(input);
      return Promise.resolve({ number: prs.length, url: `https://github.com/example/ts-mini/pull/${String(prs.length)}` });
    },
  };
  world = { home, store: EventStore.open(home.db), remote, operatorCheckout, profilePath, github };
});

afterEach(() => {
  world.store.close();
});

function newTask(body = "Add an isEmpty helper for carts, with a test."): string {
  return createTask(world.home, world.store, validator, { profilePath: world.profilePath, title: "Add isEmpty", body, trust: "untrusted", admittedBy: "operator", remote: world.remote }).id;
}

const passingGates = (): Deps["runGates"] => async (o) => {
  const candidate = spawnSync("git", ["-C", o.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  return Promise.resolve<GatesResult>({
    schema_version: 1,
    task_id: o.taskId,
    candidate_commit: candidate,
    passed: true,
    gates: [{ name: "test", status: "pass", duration_ms: 1, summary: "exit 0" }],
    signals: { sink_added: [], secret_material: false },
  });
};

function deps(runner: SessionRunner, over: Partial<Deps> = {}): Deps {
  return {
    runner,
    runGates: passingGates(),
    gateImage: () => "software-factory-gates:replay",
    engineEnv: () => ({ DOCKER_HOST: "unix:///tmp/engine.sock" }),
    github: world.github,
    auth: null,
    keyFile: join(world.home.secrets, "anthropic.key"),
    log: () => undefined,
    ...over,
  };
}

const spec = (over: Record<string, unknown> = {}) => ({
  objective: "Report whether a cart is empty",
  scope: { include: ["src/", "test/"], exclude: [] },
  acceptance_criteria: [{ id: "AC-1", statement: "isEmpty returns true only for an empty cart", verification: "node --test" }],
  invariants: ["totalCents keeps its behaviour"],
  risk_signals: [],
  required_evidence: ["unit_tests"],
  human_gate: { required: false },
  markdown: "# Spec\n\nReport whether a cart is empty.",
  ...over,
});

const CART = readFileSync(join(FIXTURE, "src/cart.ts"), "utf8");

function transcripts(taskId: string, over: Partial<Transcripts> = {}): Transcripts {
  const wt = worktreeDir(world.home, taskId);
  const work = join(runDir(world.home, taskId), "work/build");
  return {
    triage: answer(pins["haiku"] ?? "", { kind: "feature", proposed_tier: "R1", uncertain: false, duplicate_of: null, summary: "Add an emptiness check for carts." }),
    spec: answer(pins["opus"] ?? "", spec()),
    build: [
      assistant(pins["sonnet"] ?? "", [
        text("Adding isEmpty and its test."),
        toolUse("Write", { file_path: join(wt, "src/cart.ts"), content: `${CART}\nexport const isEmpty = (lines: readonly Line[]): boolean => lines.length === 0;\n` }),
        toolUse("Write", { file_path: join(wt, "test/empty.test.ts"), content: 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { isEmpty } from "../src/cart.ts";\n\ntest("empty", () => {\n  assert.equal(isEmpty([]), true);\n});\n' }),
        toolUse("Bash", { command: "git add -A && git commit -m 'Add isEmpty'" }),
        toolUse("Write", { file_path: join(work, "build-report.md"), content: "Added isEmpty; AC-1 is covered by test/empty.test.ts.\n" }),
      ]),
      result(pins["sonnet"] ?? "", { costUsd: 1.2 }),
    ],
    "review-code": answer(pins["sonnet"] ?? "", { findings: [], summary: "The change meets AC-1." }),
    "review-security": answer(pins["opus"] ?? "", { findings: [], summary: "No security-relevant change." }),
    approve: answer(pins["opus"] ?? "", { decision: "approve", confidence: 90, criteria: [{ ac_id: "AC-1", met: true, evidence: "test/empty.test.ts passes in the test gate" }], blocking_findings: [], rationale: "AC-1 is met by a passing test." }),
    summarize: answer(pins["haiku"] ?? "", { pr_body: "## What changed\n\nAdds `isEmpty`.\n\n## Verification\n\n- AC-1: test/empty.test.ts", changelog: "Add an isEmpty helper for carts" }),
    ...over,
  };
}

/** The operator's spec approval, bound to the spec on disk as `factoryctl approve` binds it. */
const approveSpec = (taskId: string): void => {
  world.store.append({ task_id: taskId, actor: { kind: "operator", id: "operator" }, type: "command", payload: { command: "approve", gate: "spec", reason: "scope reviewed", spec_digest: specDigest(runDir(world.home, taskId)) } });
};
const states = (taskId: string): string[] => world.store.events(taskId).filter((e) => e.type === "state_changed").map((e) => e.to ?? "");
const run = (taskId: string, d: Deps) => runTask({ home: world.home, store: world.store, validator, release, deps: d, taskId });
const remoteBranch = (taskId: string): string => spawnSync("git", ["-C", world.remote, "rev-parse", "--verify", "-q", `refs/heads/factory/${taskId}`], { encoding: "utf8" }).stdout.trim();

describe("a task through every stage, replayed", () => {
  it("ends at the human merge gate with a PR, a full bundle and a valid manifest", async () => {
    const before = treeHash(world.operatorCheckout);
    const id = newTask();
    const runner = replayRunner(transcripts(id));
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");

    expect(states(id)).toEqual(["TRIAGED", "SPECIFIED", "BUILDING", "VERIFYING", "REVIEWING", "POLICY", "NEEDS_HUMAN"]);
    expect(currentStatePayload(world.store.events(id))).toMatchObject({ gate: "merge", tier: "R1", pr_url: "https://github.com/example/ts-mini/pull/1" });
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build", "review-code", "review-security", "approve", "summarize"]);

    const dir = runDir(world.home, id);
    for (const f of ["task.json", "task.md", "triage.json", "spec.yaml", "spec.md", "build.json", "gates.json", "review-code.json", "review-security.json", "policy.json", "verdict.json", "summary.json", "publish.json", "manifest.json", "work/build/build-report.md"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { artifacts: { path: string; digest: string }[]; candidate_commit: string; models: { stage: string; model_id: string }[]; costs: { stage: string; usd: number }[] };
    expect(validator.validate("manifest.schema.json", manifest).errors).toEqual([]);
    for (const a of manifest.artifacts) expect(a.digest).toBe(`sha256:${createHash("sha256").update(readFileSync(join(dir, a.path))).digest("hex")}`);
    // Two review sessions on two models: both are recorded.
    expect(manifest.models.map((m) => m.stage)).toEqual(["triage", "spec", "build", "review", "review", "approve", "summarize"]);
    expect(manifest.costs.find((c) => c.stage === "build")?.usd).toBe(1.2);

    // The builder's change reached the remote branch, pushed from the mirror.
    expect(remoteBranch(id)).toBe(manifest.candidate_commit);
    expect(spawnSync("git", ["-C", world.remote, "show", `${manifest.candidate_commit}:src/cart.ts`], { encoding: "utf8" }).stdout).toContain("export const isEmpty");
    expect(world.github.prs).toHaveLength(1);
    expect(world.github.prs[0]).toMatchObject({ head: `factory/${id}`, base: "main", draft: false, title: `[factory] ${id}: Add isEmpty` });
    expect(world.github.prs[0]?.body).toContain("Adds `isEmpty`");

    // Judges never get the builder's report; the operator checkout is untouched (G0-3).
    expect(readdirSync(join(dir, "bundle")).sort()).toEqual(["changed-files.txt", "diff.patch", "gates.json", "policy.json", "review-code.json", "review-security.json", "spec.md", "spec.yaml", "verdict.json"]);
    expect(treeHash(world.operatorCheckout)).toBe(before);
  });

  it("runs every session with explicit options and an env that equals the allowlist", async () => {
    process.env["ANTHROPIC_API_KEY"] = "must-not-leak";
    process.env["SSH_AUTH_SOCK"] = "/tmp/agent.sock";
    process.env["FACTORY_GITHUB_TOKEN"] = "must-not-leak-either";
    const id = newTask();
    const runner = replayRunner(transcripts(id));
    await run(id, deps(runner));
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["SSH_AUTH_SOCK"];
    delete process.env["FACTORY_GITHUB_TOKEN"];

    for (const req of runner.requests) {
      const o = req.options;
      const agent = o.agent ?? "";
      expect(o.permissionMode, req.label).toBe("dontAsk");
      expect(o.settingSources, req.label).toEqual([]);
      expect(Object.keys(o.env ?? {}).sort(), req.label).toEqual([...ENV_ALLOWLIST].sort());
      expect(JSON.stringify(o.env), req.label).not.toMatch(/must-not-leak|agent\.sock/);
      expect(o.env?.["CLAUDE_CONFIG_DIR"], req.label).toContain(join(world.home.sessions, id));
      // Judgment stages answer through StructuredOutput; the builder has no output schema.
      const allow = [...(release.tools.agents[agent]?.allow ?? []), ...(req.label === "build" ? [] : ["StructuredOutput"])];
      expect(o.allowedTools, req.label).toEqual(allow);
      expect(o.tools, req.label).toEqual(allow);
      expect(o.agents?.[agent]?.tools, req.label).toEqual(expect.arrayContaining(req.label === "build" ? [] : ["StructuredOutput"]));
      expect(o.disallowedTools, req.label).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Bash(git push*)"]));
      expect(o.plugins, req.label).toEqual([{ type: "local", path: release.pluginDir }]);
      expect(o.agents?.[agent]?.model, req.label).toMatch(/^claude-/);
      expect(o.agents?.[agent]?.prompt, req.label).not.toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(o.hooks?.PreToolUse?.length, req.label).toBe(1);
      expect(o.sandbox, req.label).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
      const settings = o.settings as { permissions: { disableBypassPermissionsMode: string }; disableWorkflows: boolean; apiKeyHelper: string };
      expect(settings.permissions.disableBypassPermissionsMode, req.label).toBe("disable");
      expect(settings.disableWorkflows, req.label).toBe(true);
      expect(settings.apiKeyHelper, req.label).toContain(world.home.secrets);
      expect(o.outputFormat === undefined, req.label).toBe(req.label === "build");
    }
    // The preflight gets a ready image and the engine endpoint: it runs in the builder's stripped env.
    const build = runner.requests.find((r) => r.label === "build");
    const guard = JSON.parse(readFileSync(build?.options.env?.["FACTORY_GUARD_CONFIG"] ?? "", "utf8")) as { preflight: { argv: string[] } };
    expect(guard.preflight.argv.slice(0, 2)).toEqual(["/usr/bin/env", "DOCKER_HOST=unix:///tmp/engine.sock"]);
    expect(guard.preflight.argv.join(" ")).toContain("--image software-factory-gates:replay");
    expect(guard.preflight.argv.join(" ")).not.toMatch(/must-not-leak|agent\.sock/);
    // The event store records each session's runner and env names, never values (G0-1, G0-3).
    const started = world.store.events(id).filter((e) => e.type === "stage_started" && e.payload["runner"] !== undefined);
    expect(started.map((e) => e.payload["label"])).toEqual(runner.requests.map((r) => r.label));
    for (const e of started) {
      expect(e.payload["runner"]).toBe("replay");
      expect(e.payload["env_keys"]).toEqual([...ENV_ALLOWLIST].sort());
    }
  });
});

describe("guardrails during replay", () => {
  it("denies tool calls outside a stage's tools, its scope and protected paths, and applies the rest", async () => {
    const id = newTask();
    const wt = worktreeDir(world.home, id);
    const base = transcripts(id);
    const runner = replayRunner({
      ...base,
      triage: [assistant(pins["haiku"] ?? "", [toolUse("Bash", { command: "cat .env" })]), ...(base["triage"] ?? [])],
      build: [
        assistant(pins["sonnet"] ?? "", [
          toolUse("Write", { file_path: join(wt, ".github/workflows/ci.yml"), content: "on: push\n" }),
          toolUse("Write", { file_path: join(wt, "package.json"), content: "{}\n" }),
          toolUse("Edit", { file_path: join(wt, "src/cart.ts"), old_string: "export function totalCents", new_string: "export const isEmpty = (lines: readonly Line[]): boolean => lines.length === 0;\n\nexport function totalCents" }),
        ]),
        result(pins["sonnet"] ?? ""),
      ],
    });
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");
    expect(existsSync(join(wt, ".github/workflows/ci.yml"))).toBe(false);
    expect(readFileSync(join(wt, "package.json"), "utf8")).not.toBe("{}\n");
    expect(readFileSync(join(wt, "src/cart.ts"), "utf8")).toContain("isEmpty");
    const completed = world.store.events(id).filter((e) => e.type === "stage_completed");
    const denied = (label: string) => (completed.find((e) => e.payload["label"] === label)?.payload["denied"] ?? []) as { tool: string; reason: string }[];
    expect(denied("triage").map((d) => d.tool)).toEqual(["Bash"]);
    const reasons = denied("build").map((d) => d.reason).join("\n");
    expect(reasons).toContain(".github/workflows/ci.yml is a protected path");
    expect(reasons).toContain("package.json is outside the spec's scope");
  });
});

describe("the commit protocol (P1-02)", () => {
  const gated = (id: string, over: Partial<Transcripts> = {}): Transcripts => transcripts(id, { spec: answer(pins["opus"] ?? "", spec({ human_gate: { required: true, reason: "touches billing" } })), ...over });
  const committed = (id: string): string[] => world.store.events(id).filter((e) => e.type === "artifact_committed").map((e) => String(e.payload["label"]));

  it("commits every step's artifacts once, and a resume runs nothing that is committed", async () => {
    const id = newTask();
    expect(await run(id, deps(replayRunner(gated(id))))).toBe("NEEDS_HUMAN");
    expect(committed(id)).toEqual(["checkout", "triage", "spec"]);
    approveSpec(id);
    const second = replayRunner(gated(id));
    expect(await run(id, deps(second))).toBe("NEEDS_HUMAN");
    expect(committed(id)).toEqual(["checkout", "triage", "spec", "build", "gates", "review-code", "review-security", "policy", "approve", "summarize", "publish"]);
    expect(second.requests.map((r) => r.label)).toEqual(["build", "review-code", "review-security", "approve", "summarize"]);
    // Every committed file is on disk with its committed digest; nothing is left staged.
    const dir = runDir(world.home, id);
    for (const e of world.store.events(id).filter((x) => x.type === "artifact_committed")) {
      for (const a of e.payload["artifacts"] as { path: string; digest: string }[]) expect(`sha256:${createHash("sha256").update(readFileSync(join(dir, a.path))).digest("hex")}`, a.path).toBe(a.digest);
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".pending"))).toEqual([]);
  });

  it("re-runs a step whose committed file was changed on disk, and nothing downstream when it comes out the same", async () => {
    const id = newTask();
    await run(id, deps(replayRunner(gated(id))));
    approveSpec(id);
    writeFileSync(join(runDir(world.home, id), "triage.json"), "{}\n");
    const runner = replayRunner(gated(id));
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "build", "review-code", "review-security", "approve", "summarize"]);
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("merge");
  });

  it("re-runs every step downstream of a changed input, and a changed spec reopens the spec gate", async () => {
    const id = newTask();
    await run(id, deps(replayRunner(gated(id))));
    approveSpec(id);
    rmSync(join(runDir(world.home, id), "triage.json"));
    const changed = gated(id, {
      triage: answer(pins["haiku"] ?? "", { kind: "feature", proposed_tier: "R1", uncertain: false, duplicate_of: null, summary: "Carts can report emptiness." }),
      spec: answer(pins["opus"] ?? "", spec({ objective: "Report empty carts", human_gate: { required: true, reason: "touches billing" } })),
    });
    const runner = replayRunner(changed);
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec"]);
    // The approval was for the earlier spec: the gate is open again until the new one is approved.
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("spec");
    const approvals = world.store.events(id).filter((e) => e.type === "command" && e.payload["command"] === "approve");
    expect(approvals.map((e) => e.payload["spec_digest"])).not.toContain(specDigest(runDir(world.home, id)));
    approveSpec(id);
    const after = replayRunner(changed);
    expect(await run(id, deps(after))).toBe("NEEDS_HUMAN");
    expect(after.requests.map((r) => r.label)).toEqual(["build", "review-code", "review-security", "approve", "summarize"]);
  });

  it("sends a spec that changed after the build started back to the spec gate", async () => {
    const id = newTask();
    const inner = replayRunner(transcripts(id));
    const halting: SessionRunner = {
      kind: "replay",
      run: (req) => {
        if (req.label === "build") setHalt(world.home, "operator", "drill");
        return inner.run(req);
      },
    };
    expect(await run(id, deps(halting))).toBe("BUILDING");
    clearHalt(world.home);
    writeFileSync(join(runDir(world.home, id), "spec.yaml"), "edited by hand\n");
    const runner = replayRunner(gated(id));
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");
    expect(runner.requests.map((r) => r.label)).toEqual(["spec"]);
    expect(states(id).slice(-3)).toEqual(["BLOCKED", "SPECIFIED", "NEEDS_HUMAN"]);
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("spec");
    approveSpec(id);
    expect(await run(id, deps(replayRunner(gated(id))))).toBe("NEEDS_HUMAN");
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("merge");
  });

  it("refuses a task an earlier factoryctl started without the commit protocol", async () => {
    const id = newTask();
    const old = "T-0099";
    const dir = runDir(world.home, old);
    cpSync(runDir(world.home, id), dir, { recursive: true });
    writeFileSync(join(dir, "task.json"), readFileSync(join(dir, "task.json"), "utf8").replaceAll(id, old));
    world.store.append({ task_id: old, actor: { kind: "operator", id: "operator" }, type: "task_created", payload: { remote: world.remote } });
    // Never run: an older task with no stage started adopts the protocol.
    const fresh = replayRunner(transcripts(old));
    expect(await run(old, deps(fresh))).toBe("NEEDS_HUMAN");
    const older = "T-0098";
    cpSync(runDir(world.home, id), runDir(world.home, older), { recursive: true });
    writeFileSync(join(runDir(world.home, older), "task.json"), readFileSync(join(runDir(world.home, older), "task.json"), "utf8").replaceAll(id, older));
    world.store.append({ task_id: older, actor: { kind: "operator", id: "operator" }, type: "task_created", payload: { remote: world.remote } });
    world.store.append({ task_id: older, actor: { kind: "factoryctl", id: "factoryctl" }, type: "stage_started", payload: { stage: "triage", label: "triage", runner: "sdk", env_keys: [] } });
    await expect(run(older, deps(replayRunner(transcripts(older))))).rejects.toThrow(ProtocolError);
  });
});

/** Round n's build: one more file in scope, and its report. */
const roundBuild = (taskId: string, n: number): SDKMessage[] => [
  assistant(pins["sonnet"] ?? "", [
    toolUse("Write", { file_path: join(worktreeDir(world.home, taskId), `src/round${String(n)}.ts`), content: `export const round = ${String(n)};\n` }),
    toolUse("Write", { file_path: join(runDir(world.home, taskId), `work/build-r${String(n)}`, "build-report.md"), content: `Round ${String(n)}.\n` }),
  ]),
  result(pins["sonnet"] ?? "", { costUsd: 0.5 }),
];
/** Gates whose result each call takes from the list, then passes. */
const gatesSequence = (summaries: (string | null)[], status: "fail" | "error" = "fail"): Deps["runGates"] => {
  let call = 0;
  return async (o) => {
    const summary = summaries[call++] ?? null;
    const green = await passingGates()(o);
    return summary === null ? green : { ...green, passed: false, gates: [{ name: "test", status, duration_ms: 1, summary }] };
  };
};
/** Round 2's clean reviews. */
const reviewsR2 = (): Partial<Transcripts> => ({
  "review-code-r2": answer(pins["sonnet"] ?? "", { findings: [], summary: "Fixed." }),
  "review-security-r2": answer(pins["opus"] ?? "", { findings: [], summary: "No security-relevant change." }),
});
const blocking = { id: "F-1", severity: "blocking", category: "correctness", file: "src/cart.ts", line: 3, title: "isEmpty treats a cart of zero-quantity lines as non-empty", failure_scenario: "isEmpty([{ sku: 'a', quantity: 0 }]) returns false.", fix: "Ignore lines with quantity 0.", confidence: 90 };
const committedLabels = (id: string): string[] => world.store.events(id).filter((e) => e.type === "artifact_committed").map((e) => String(e.payload["label"]));
const failure = (id: string): Record<string, unknown> | undefined => world.store.events(id).find((e) => e.type === "stage_failed")?.payload;

describe("remediation rounds (P1-01)", () => {
  it("sends red gates back to the builder with the failure, and publishes the round that passed", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id, { "build-r2": roundBuild(id, 2), ...reviewsR2() }));
    expect(await run(id, deps(runner, { runGates: gatesSequence(["2 of 7 tests failed: cart.test.ts:14 expected true"]) }))).toBe("NEEDS_HUMAN");
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build", "build-r2", "review-code-r2", "review-security-r2", "approve", "summarize"]);
    expect(states(id)).toEqual(["TRIAGED", "SPECIFIED", "BUILDING", "VERIFYING", "REMEDIATING", "BUILDING", "VERIFYING", "REVIEWING", "POLICY", "NEEDS_HUMAN"]);
    const prompt = runner.requests.find((r) => r.label === "build-r2")?.prompt ?? "";
    expect(prompt).toContain("<findings>\n- [gate test] the test gate failed\n  2 of 7 tests failed: cart.test.ts:14 expected true\n</findings>");
    const dir = runDir(world.home, id);
    const r1 = JSON.parse(readFileSync(join(dir, "build.json"), "utf8")) as { candidate_commit: string };
    const r2 = JSON.parse(readFileSync(join(dir, "rounds/2/build.json"), "utf8")) as { start_commit: string; candidate_commit: string; round: number };
    // Round 2 builds on round 1's candidate; the PR carries round 2's.
    expect(r2).toMatchObject({ round: 2, start_commit: r1.candidate_commit });
    expect(remoteBranch(id)).toBe(r2.candidate_commit);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).toMatchObject({ candidate_commit: r2.candidate_commit });
    expect(JSON.parse(readFileSync(join(dir, "remediation.json"), "utf8"))).toMatchObject({ round: 1, source: "gates", decision: "remediate" });
    expect(validator.validate("remediation.schema.json", JSON.parse(readFileSync(join(dir, "remediation.json"), "utf8"))).errors).toEqual([]);
    expect(committedLabels(id)).toEqual(["checkout", "triage", "spec", "build", "gates", "remediation", "build-r2", "gates-r2", "review-code-r2", "review-security-r2", "policy", "approve", "summarize", "publish"]);
  });

  it("sends a blocking finding back to the builder, and passes when the next round's reviews are clean", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id, {
      "review-code": answer(pins["sonnet"] ?? "", { findings: [blocking], summary: "One blocking bug." }),
      "build-r2": roundBuild(id, 2),
      ...reviewsR2(),
    }));
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build", "review-code", "review-security", "build-r2", "review-code-r2", "review-security-r2", "approve", "summarize"]);
    expect(runner.requests.find((r) => r.label === "build-r2")?.prompt).toContain("[finding code-reviewer F-1] src/cart.ts:3 isEmpty treats a cart of zero-quantity lines as non-empty");
    // The judges see round 2's reviews, under their usual names.
    expect(readFileSync(join(runDir(world.home, id), "bundle/review-code.json"), "utf8")).toContain('"summary": "Fixed."');
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("merge");
  });

  it("stops when the same failure comes back after a round, before any reviewer runs", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id, { "build-r2": roundBuild(id, 2) }));
    // The line number moved; the failure is the same.
    expect(await run(id, deps(runner, { runGates: gatesSequence(["2 of 7 tests failed: cart.test.ts:14", "2 of 8 tests failed: cart.test.ts:19"]) }))).toBe("FAILED");
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build", "build-r2"]);
    expect(failure(id)).toMatchObject({ stage: "gates", category: "gate_fail", cause: "repeated_finding" });
    expect(JSON.parse(readFileSync(join(runDir(world.home, id), "rounds/2/remediation.json"), "utf8"))).toMatchObject({ decision: "stop", repeated: [expect.stringMatching(/^gate:/) as string] });
    expect(remoteBranch(id)).toBe("");
  });

  it("stops a blocking finding that survives its remediation round as review_block", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id, {
      "review-code": answer(pins["sonnet"] ?? "", { findings: [blocking], summary: "One blocking bug." }),
      "build-r2": roundBuild(id, 2),
      "review-code-r2": answer(pins["sonnet"] ?? "", { findings: [{ ...blocking, id: "F-7", line: 9 }], summary: "Still there." }),
      "review-security-r2": answer(pins["opus"] ?? "", { findings: [], summary: "Fine." }),
    }));
    expect(await run(id, deps(runner))).toBe("FAILED");
    expect(failure(id)).toMatchObject({ stage: "review", category: "review_block", cause: "repeated_finding" });
  });

  it("stops after the policy's remediation rounds: at most four builds", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id, { "build-r2": roundBuild(id, 2), "build-r3": roundBuild(id, 3), "build-r4": roundBuild(id, 4) }));
    const red = gatesSequence(["alpha broke", "beta broke", "gamma broke", "delta broke"]);
    expect(await run(id, deps(runner, { runGates: red }))).toBe("FAILED");
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build", "build-r2", "build-r3", "build-r4"]);
    expect(failure(id)).toMatchObject({ category: "gate_fail", cause: "rounds_exhausted" });
    expect(release.budgets.max_remediation_rounds).toBe(3);
  });

  it("fails a gate infrastructure error without a remediation round (D5)", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id));
    expect(await run(id, deps(runner, { runGates: gatesSequence(["image pull failed"], "error") }))).toBe("FAILED");
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build"]);
    expect(failure(id)).toMatchObject({ stage: "gates", category: "gate_fail", cause: "gate_error" });
  });

  it("resumes mid-round without re-running a committed step", async () => {
    const id = newTask();
    const t = transcripts(id, { "build-r2": roundBuild(id, 2), ...reviewsR2() });
    const inner = replayRunner(t);
    // A halt during round 2's build stops the run; the resume runs only what round 2 still needs.
    const halting: SessionRunner = { kind: "replay", run: (req) => {
      if (req.label === "build-r2") setHalt(world.home, "operator", "drill");
      return inner.run(req);
    } };
    const red = gatesSequence(["2 of 7 tests failed"]);
    expect(await run(id, deps(halting, { runGates: red }))).toBe("BUILDING");
    clearHalt(world.home);
    const resumed = replayRunner(t);
    expect(await run(id, deps(resumed, { runGates: passingGates() }))).toBe("NEEDS_HUMAN");
    expect(resumed.requests.map((r) => r.label)).toEqual(["build-r2", "review-code-r2", "review-security-r2", "approve", "summarize"]);
  });
});

describe("budgets and limits (P1-01)", () => {
  const fraction = release.budgets.stage_fraction;

  it("gives every session an explicit turn limit and a budget cap from its stage's share", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id));
    await run(id, deps(runner));
    const caps = new Map(world.store.events(id).filter((e) => e.type === "stage_started" && e.payload["runner"] !== undefined).map((e) => [String(e.payload["label"]), e.payload["cap_usd"]]));
    for (const req of runner.requests) {
      const agent = req.options.agent ?? "";
      expect(req.options.maxTurns, req.label).toBe(req.options.agents?.[agent]?.maxTurns);
      expect(req.options.maxTurns, req.label).toBeGreaterThan(0);
      expect(req.options.maxBudgetUsd, req.label).toBe(caps.get(req.label));
    }
    // Before triage the task is budgeted at the highest tier; after it, at triage's R1.
    expect(runner.requests[0]?.options.maxBudgetUsd).toBe(fraction.triage * release.budgets.task_usd.Restricted);
    expect(runner.requests.find((r) => r.label === "build")?.options.maxBudgetUsd).toBe(fraction.build * release.budgets.task_usd.R1);
  });

  it("stops an over-budget task with budget_exceeded before the gates: no review session, no branch", async () => {
    const id = newTask();
    let gatesRan = false;
    const t = transcripts(id);
    const runner = replayRunner({ ...t, build: [...(t["build"] ?? []).slice(0, -1), result(pins["sonnet"] ?? "", { costUsd: release.budgets.task_usd.R1 + 1 })] });
    const gates: Deps["runGates"] = (o) => {
      gatesRan = true;
      return passingGates()(o);
    };
    expect(await run(id, deps(runner, { runGates: gates }))).toBe("FAILED");
    expect(failure(id)).toMatchObject({ stage: "build", category: "budget_exceeded" });
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build"]);
    expect(gatesRan).toBe(false);
    expect(remoteBranch(id)).toBe("");
  });

  it("pauses a task whose target has reached its monthly cap, without failing it; other targets run", async () => {
    const capped = join(world.operatorCheckout, "..", "capped.yaml");
    const other = join(world.operatorCheckout, "..", "other.yaml");
    const base = parse(readFileSync(world.profilePath, "utf8")) as Record<string, unknown>;
    writeFileSync(capped, stringify({ ...base, budgets: { monthly_usd: 2 } }));
    writeFileSync(other, stringify({ ...base, target: { repo: "example/other", default_branch: "main", visibility: "private" }, budgets: { monthly_usd: 2 } }));
    const make = (profilePath: string) => createTask(world.home, world.store, validator, { profilePath, title: "Add isEmpty", body: "Add isEmpty.", trust: "operator", admittedBy: "operator", remote: world.remote }).id;
    // Earlier live spend on the capped target this month, and replayed spend that does not count.
    const spent = make(capped);
    world.store.append({ task_id: spent, actor: { kind: "factoryctl", id: "factoryctl" }, type: "stage_started", payload: { stage: "build", label: "build", runner: "sdk", env_keys: [], cap_usd: 6 } });
    world.store.append({ task_id: spent, actor: { kind: "factoryctl", id: "factoryctl" }, type: "stage_completed", payload: { stage: "build", label: "build", cost_usd: 2.5, runner: "sdk" } });
    const id = make(capped);
    const runner = replayRunner(transcripts(id));
    expect(await run(id, deps(runner))).toBe("RECEIVED");
    expect(runner.requests).toHaveLength(0);
    expect(world.store.events(id).find((e) => e.type === "command" && e.payload["command"] === "paused")?.payload).toMatchObject({ reason: "monthly_cap", spent_usd: 2.5, cap_usd: 2 });
    expect(world.store.events(id).some((e) => e.type === "stage_failed")).toBe(false);
    const elsewhere = make(other);
    expect(await run(elsewhere, deps(replayRunner(transcripts(elsewhere))))).toBe("NEEDS_HUMAN");
  });

  it("counts only active time against the wall clock: a wait at the spec gate does not", async () => {
    let clock = Date.parse("2026-10-13T08:00:00Z");
    const ticking = (inner: SessionRunner, minutes: number): SessionRunner => ({ kind: "replay", run: (req) => {
      clock += minutes * 60_000;
      return inner.run(req);
    } });
    const now = () => new Date(clock);
    const gatedSpec = (id: string) => transcripts(id, { spec: answer(pins["opus"] ?? "", spec({ human_gate: { required: true, reason: "touches billing" } })) });

    const id = newTask();
    expect(await run(id, deps(ticking(replayRunner(gatedSpec(id)), 5), { now }))).toBe("NEEDS_HUMAN");
    clock += 300 * 60_000;
    approveSpec(id);
    expect(await run(id, deps(ticking(replayRunner(gatedSpec(id)), 5), { now }))).toBe("NEEDS_HUMAN");
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("merge");

    // 20 minutes a session: 40 before the gate, then build and the reviews pass 90.
    const slow = newTask();
    expect(await run(slow, deps(ticking(replayRunner(gatedSpec(slow)), 20), { now }))).toBe("NEEDS_HUMAN");
    clock += 300 * 60_000;
    approveSpec(slow);
    const runner = replayRunner(gatedSpec(slow));
    expect(await run(slow, deps(ticking(runner, 20), { now }))).toBe("FAILED");
    expect(failure(slow)).toMatchObject({ stage: "review", category: "wall_clock" });
    expect(runner.requests.map((r) => r.label)).toEqual(["build", "review-code", "review-security"]);
  });

  it("aborts a session in flight when the wall clock runs out", async () => {
    const id = newTask();
    let clock = Date.parse("2026-10-13T08:00:00Z");
    const now = () => new Date(clock);
    // A first run that used all but 50 ms of the wall clock, stopped at the spec gate.
    const t = transcripts(id, { spec: answer(pins["opus"] ?? "", spec({ human_gate: { required: true, reason: "touches billing" } })) });
    const first = replayRunner(t);
    const spending: SessionRunner = { kind: "replay", run: (req) => {
      clock += req.label === "spec" ? release.budgets.wall_clock_minutes * 60_000 - 50 : 0;
      return first.run(req);
    } };
    expect(await run(id, deps(spending, { now }))).toBe("NEEDS_HUMAN");
    approveSpec(id);
    // The build waits until it is aborted, as a live session does.
    const waiting: SessionRunner = { kind: "replay", run: (req) => new Promise((_, reject) => {
      req.options.abortController?.signal.addEventListener("abort", () => {
        reject(new Error("Claude Code process aborted by user"));
      });
    }) };
    expect(await run(id, deps(waiting, { now }))).toBe("FAILED");
    expect(failure(id)).toMatchObject({ stage: "build", category: "wall_clock" });
  });

  it("reconstructs a killed run's end from its heartbeat", async () => {
    const id = newTask();
    const at = (min: number) => new Date(Date.parse("2026-10-13T08:00:00Z") + min * 60_000).toISOString();
    const started = world.store.append({ task_id: id, actor: { kind: "factoryctl", id: "factoryctl" }, type: "command", payload: { command: "run_started", at: at(0), pid: 1 } });
    writeFileSync(join(runDir(world.home, id), "heartbeat.json"), JSON.stringify({ run_seq: started.seq, at: at(30) }));
    await run(id, deps(replayRunner(transcripts(id)), { now: () => new Date(at(500)) }));
    const ended = world.store.events(id).filter((e) => e.type === "command" && e.payload["command"] === "run_ended");
    expect(ended[0]?.payload).toMatchObject({ at: at(30), reason: "killed", reconstructed: true });
    expect(ended.at(-1)?.payload).toMatchObject({ reason: "waiting: merge gate" });
  });
});

describe("judges read their rubrics (found by the P1-05 evals)", () => {
  it("lets every session read the release's rubrics, and nothing else outside its roots", async () => {
    const id = newTask();
    const rubric = join(release.pluginDir, "rubrics", "review.md");
    const t = transcripts(id);
    const runner = replayRunner({
      ...t,
      "review-code": [assistant(pins["sonnet"] ?? "", [toolUse("Read", { file_path: rubric }), toolUse("Read", { file_path: join(release.pluginDir, "agents", "builder.md") })]), ...(t["review-code"] ?? [])],
    });
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");
    const review = world.store.events(id).find((e) => e.type === "stage_completed" && e.payload["label"] === "review-code");
    const denied = (review?.payload["denied"] ?? []) as { tool: string; reason: string }[];
    expect(denied.map((d) => d.reason).join("\n")).not.toContain("review.md");
    expect(denied.map((d) => d.reason).join("\n")).toContain("builder.md");
    for (const req of runner.requests) expect(req.options.additionalDirectories, req.label).toContain(join(release.pluginDir, "rubrics"));
  });
});

describe("eval capture (P1-05)", () => {
  it("turns a finished run's judgment stages into candidate cases, outside the repository", async () => {
    const id = newTask();
    await run(id, deps(replayRunner(transcripts(id))));
    const captured = captureTask(world.home, id, "caglarsubas/software-factory-claude-code");
    expect(captured.map((c) => c.label)).toEqual(["triage", "spec", "review-code", "review-security", "approve", "summarize"]);
    // example/ts-mini is neither this repository nor a fixture mirror: its cases are private.
    expect(new Set(captured.map((c) => c.target))).toEqual(new Set(["private"]));
    for (const c of captured) {
      expect(c.dir.startsWith(join(world.home.root, "evals", "captured"))).toBe(true);
      const prompt = readFileSync(join(c.dir, "prompt.md"), "utf8");
      const fm = parse(/^---\n([\s\S]*?)\n---\n/.exec(prompt)?.[1] ?? "") as { tags: string[] };
      expect(fm.tags).toEqual([`role:${c.role}`, "expect:TODO", "target:private"]);
      expect(prompt).toContain(`software-factory:${c.role}`);
      expect(existsSync(join(c.dir, "observed.json"))).toBe(true);
    }
    expect(readFileSync(join(captured.find((c) => c.label === "approve")?.dir ?? "", "graders/result.md"), "utf8")).toContain('"^RESULT: approve$"');
    expect(readFileSync(join(captured.find((c) => c.label === "review-code")?.dir ?? "", "prompt.md"), "utf8")).toContain("<diff.patch>");
  });
});

describe("resume, gates and cancellation", () => {
  it("stops at the spec gate for a human, then resumes without re-running finished stages", async () => {
    const id = newTask();
    const t = transcripts(id, { spec: answer(pins["opus"] ?? "", spec({ human_gate: { required: true, reason: "touches billing" } })) });
    const first = replayRunner(t);
    expect(await run(id, deps(first))).toBe("NEEDS_HUMAN");
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("spec");
    expect(first.requests.map((r) => r.label)).toEqual(["triage", "spec"]);

    // Without an approval, resuming does nothing.
    expect(await run(id, deps(replayRunner(t)))).toBe("NEEDS_HUMAN");
    approveSpec(id);
    const second = replayRunner(t);
    expect(await run(id, deps(second))).toBe("NEEDS_HUMAN");
    expect(second.requests.map((r) => r.label)).toEqual(["build", "review-code", "review-security", "approve", "summarize"]);
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("merge");
  });

  it("repairs a transition lost between a commit and its state change", async () => {
    const id = newTask();
    // The process dies right after triage commits: the TRIAGED transition, and every write after it, is lost.
    let dead = false;
    const dying = new Proxy(world.store, {
      get(target, key) {
        if (key === "append") {
          return (e: Parameters<EventStore["append"]>[0]) => {
            if (dead || (e.type === "state_changed" && e.to === "TRIAGED")) {
              dead = true;
              throw new Error("killed");
            }
            return target.append(e);
          };
        }
        const v: unknown = Reflect.get(target, key);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await expect(runTask({ home: world.home, store: dying, validator, release, deps: deps(replayRunner(transcripts(id))), taskId: id })).rejects.toThrow("killed");
    expect(states(id)).toEqual([]);
    expect(world.store.events(id).filter((e) => e.type === "artifact_committed").map((e) => e.payload["label"])).toEqual(["checkout", "triage"]);

    const runner = replayRunner(transcripts(id));
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");
    expect(runner.requests.map((r) => r.label)).not.toContain("triage");
    expect(states(id)[0]).toBe("TRIAGED");
  });

  it("fails a rejected verdict, a schema-invalid spec and a session that ran out of turns, each with its category", async () => {
    const cases: [Partial<Transcripts>, string][] = [
      [{ approve: answer(pins["opus"] ?? "", { decision: "reject", confidence: 80, criteria: [{ ac_id: "AC-1", met: false, evidence: "no test" }], blocking_findings: ["F-1"], rationale: "AC-1 unproven" }) }, "review_block"],
      [{ spec: answer(pins["opus"] ?? "", { ...spec(), acceptance_criteria: [] }) }, "schema_invalid"],
      [{ build: [result(pins["sonnet"] ?? "", { subtype: "error_max_turns" })] }, "max_turns"],
    ];
    for (const [over, category] of cases) {
      const id = newTask();
      expect(await run(id, deps(replayRunner(transcripts(id, over))))).toBe("FAILED");
      expect(world.store.events(id).find((e) => e.type === "stage_failed")?.payload["category"]).toBe(category);
      expect(remoteBranch(id)).toBe("");
    }
  });

  it("records each session's duration, runner and round on stage_completed (P1-07)", async () => {
    const id = newTask();
    const t = transcripts(id);
    await run(id, deps(replayRunner({ ...t, triage: [...(t["triage"] ?? []).slice(0, -1), result(pins["haiku"] ?? "", { structured: (t["triage"]?.at(-1) as { structured_output?: unknown } | undefined)?.structured_output, durationMs: 4321 })] })));
    const completed = world.store.events(id).filter((e) => e.type === "stage_completed");
    expect(completed.find((e) => e.payload["label"] === "triage")?.payload).toMatchObject({ duration_ms: 4321, runner: "replay", round: 1 });
    for (const e of completed) {
      expect(typeof e.payload["duration_ms"], String(e.payload["label"])).toBe("number");
      expect(e.payload["round"], String(e.payload["label"])).toBe(1);
    }
  });

  it("files every failure path under exactly one category of the taxonomy (P1-07)", async () => {
    const wtOf = (id: string): string => worktreeDir(world.home, id);
    const workOf = (id: string): string => join(runDir(world.home, id), "work/build");
    const cases: { name: string; over: (id: string) => Partial<Transcripts>; category: string; cause?: string; stage: string; setup?: (id: string) => void; runner?: (inner: SessionRunner) => SessionRunner }[] = [
      { name: "a builder that records a failure", stage: "build", category: "gate_fail", cause: "build_failed", over: (id) => ({
        build: [assistant(pins["sonnet"] ?? "", [toolUse("Write", { file_path: join(workOf(id), "build-failure.json"), content: '{"reason":"the tests stay red"}' })]), result(pins["sonnet"] ?? "")],
      }) },
      { name: "a builder that changes nothing", stage: "build", category: "gate_fail", cause: "no_change", over: () => ({ build: [result(pins["sonnet"] ?? "")] }) },
      { name: "a builder whose every edit is denied", stage: "build", category: "permission_denied", cause: "no_change", over: (id) => ({
        build: [assistant(pins["sonnet"] ?? "", [toolUse("Write", { file_path: join(wtOf(id), ".github/workflows/ci.yml"), content: "on: push\n" })]), result(pins["sonnet"] ?? "")],
      }) },
      { name: "a session over its budget", stage: "build", category: "budget_exceeded", cause: "error_max_budget_usd", over: () => ({ build: [result(pins["sonnet"] ?? "", { subtype: "error_max_budget_usd" })] }) },
      { name: "a session that errors", stage: "spec", category: "api_error", cause: "error_during_execution", over: () => ({ spec: [result(pins["opus"] ?? "", { subtype: "error_during_execution" })] }) },
      { name: "a runner that throws", stage: "run", category: "api_error", over: () => ({}), runner: (inner) => ({
        kind: "replay",
        run: (req) => (req.label === "review-code" ? Promise.reject(new Error("connection reset")) : inner.run(req)),
      }) },
      { name: "a branch that moved on the remote", stage: "publish", category: "merge_conflict", cause: "push_rejected", over: () => ({}), setup: (id) => {
        const other = join(world.operatorCheckout, "..", `other-${id}`);
        sh(world.operatorCheckout, ["clone", "-q", world.remote, other]);
        writeFileSync(join(other, "OTHER.md"), "someone else\n");
        sh(other, ["add", "-A"]);
        sh(other, ["commit", "-qm", "other"]);
        sh(other, ["push", "-q", "origin", `HEAD:refs/heads/factory/${id}`]);
      } },
    ];
    for (const c of cases) {
      const id = newTask();
      c.setup?.(id);
      const inner = replayRunner(transcripts(id, c.over(id)));
      await expect(run(id, deps(c.runner?.(inner) ?? inner)).catch(() => "FAILED"), c.name).resolves.toBe("FAILED");
      const failed = world.store.events(id).filter((e) => e.type === "stage_failed");
      expect(failed, c.name).toHaveLength(1);
      expect(failed[0]?.payload, c.name).toMatchObject({ stage: c.stage, category: c.category, ...(c.cause === undefined ? {} : { cause: c.cause }) });
      expect(CATEGORIES, c.name).toContain(failed[0]?.payload["category"]);
      expect(currentStatePayload(world.store.events(id)), c.name).toMatchObject({ category: c.category });
    }
  });

  it("stops at the next stage boundary once the task is cancelled", async () => {
    const id = newTask();
    const inner = replayRunner(transcripts(id));
    const cancelling: SessionRunner = {
      kind: "replay",
      async run(req) {
        const out = await inner.run(req);
        if (req.label === "build") world.store.append({ task_id: id, actor: { kind: "factoryctl", id: "factoryctl" }, type: "state_changed", from: "BUILDING", to: "CANCELLED", payload: { by: "operator" } });
        return out;
      },
    };
    expect(await run(id, deps(cancelling))).toBe("CANCELLED");
    expect(inner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build"]);
    expect(currentState(world.store.events(id))).toBe("CANCELLED");
  });

  it("halts mid-session without failing the task: tool calls are denied, and the task resumes after unhalt", async () => {
    const id = newTask();
    const inner = replayRunner(transcripts(id));
    const halting: SessionRunner = {
      kind: "replay",
      async run(req) {
        if (req.label === "build") setHalt(world.home, "operator", "drill");
        return inner.run(req);
      },
    };
    expect(await run(id, deps(halting))).toBe("BUILDING");
    expect(world.store.events(id).some((e) => e.type === "stage_failed")).toBe(false);
    const build = world.store.events(id).find((e) => e.type === "stage_completed" && e.payload["label"] === "build");
    const denied = (build?.payload["denied"] ?? []) as { tool: string; reason: string }[];
    expect(denied.map((d) => d.tool)).toEqual(["Write", "Write", "Bash", "Write"]);
    expect(denied[0]?.reason).toContain("the factory is halted since");
    expect(existsSync(join(worktreeDir(world.home, id), "test/empty.test.ts"))).toBe(false);

    // While halted, a run stops before any session; once lifted, the build runs again.
    const blocked = replayRunner(transcripts(id));
    expect(await run(id, deps(blocked))).toBe("BUILDING");
    expect(blocked.requests).toHaveLength(0);
    clearHalt(world.home);
    const resumed = replayRunner(transcripts(id));
    expect(await run(id, deps(resumed))).toBe("NEEDS_HUMAN");
    expect(resumed.requests.map((r) => r.label)).toEqual(["build", "review-code", "review-security", "approve", "summarize"]);
  });

  it("ends a run whose session is aborted by a halt, without failing the task", async () => {
    const id = newTask();
    const inner = replayRunner(transcripts(id));
    const aborted: SessionRunner = {
      kind: "replay",
      async run(req) {
        if (req.label !== "spec") return inner.run(req);
        setHalt(world.home, "operator", "drill");
        throw new Error("Claude Code process aborted by user");
      },
    };
    expect(await run(id, deps(aborted))).toBe("TRIAGED");
    expect(currentState(world.store.events(id))).toBe("TRIAGED");
    expect(world.store.events(id).some((e) => e.type === "stage_failed")).toBe(false);
    clearHalt(world.home);
  });

  it("records a live session's stream so it can be replayed", async () => {
    const id = newTask();
    await run(id, deps(replayRunner(transcripts(id))));
    const recorded = join(runDir(world.home, id), "transcripts");
    const lines = readFileSync(join(recorded, "triage.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SDKMessage);
    expect(lines.at(-1)?.type).toBe("result");
    // The recorded directory replays the same run for a new task with the same files.
    const again = newTask();
    rmSync(join(recorded, "build.ndjson"));
    const fromDisk = replayRunner(recorded);
    await expect(run(again, deps(fromDisk))).rejects.toThrow(/no transcript for build/);
    expect(fromDisk.requests.map((r) => r.label)).toEqual(["triage", "spec", "build"]);
  });
});
