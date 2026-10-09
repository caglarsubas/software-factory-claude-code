// The transcript-replay suite (P0-07 "done when": replay tests run in CI with zero tokens).
// Each test drives the real pipeline (event store, lifecycle, session options, the in-process
// guard, git mirror and clone, policy engine, bundle, manifest, push) against a local bare
// "GitHub" remote, with recorded transcripts in place of model sessions, stubbed gates and a
// fake GitHub API. The container gates run end to end in gates.int.test.ts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { runTask, type Deps } from "./pipeline.ts";

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
      expect(o.allowedTools, req.label).toEqual(release.tools.agents[agent]?.allow);
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
    world.store.append({ task_id: id, actor: { kind: "operator", id: "operator" }, type: "command", payload: { command: "approve", gate: "spec", reason: "scope reviewed" } });
    const second = replayRunner(t);
    expect(await run(id, deps(second))).toBe("NEEDS_HUMAN");
    expect(second.requests.map((r) => r.label)).toEqual(["build", "review-code", "review-security", "approve", "summarize"]);
    expect(currentStatePayload(world.store.events(id))["gate"]).toBe("merge");
  });

  it("repairs a transition lost between an artifact and its state change", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id));
    // A crash after triage.json was written but before TRIAGED was recorded.
    mkdirSync(runDir(world.home, id), { recursive: true });
    writeFileSync(join(runDir(world.home, id), "triage.json"), JSON.stringify({ schema_version: 1, task_id: id, kind: "feature", proposed_tier: "R1", uncertain: false, duplicate_of: null, summary: "x" }));
    expect(await run(id, deps(runner))).toBe("NEEDS_HUMAN");
    expect(runner.requests.map((r) => r.label)).not.toContain("triage");
    expect(states(id)[0]).toBe("TRIAGED");
  });

  it("fails on red gates without spending reviewer tokens", async () => {
    const id = newTask();
    const runner = replayRunner(transcripts(id));
    const red: Deps["runGates"] = async (o) => ({ ...(await passingGates()(o)), passed: false, gates: [{ name: "test", status: "fail", duration_ms: 1, summary: "exit 1" }] });
    expect(await run(id, deps(runner, { runGates: red }))).toBe("FAILED");
    expect(runner.requests.map((r) => r.label)).toEqual(["triage", "spec", "build"]);
    expect(world.store.events(id).find((e) => e.type === "stage_failed")?.payload).toMatchObject({ category: "gate_fail" });
    expect(remoteBranch(id)).toBe("");
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
