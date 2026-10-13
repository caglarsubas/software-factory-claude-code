// The kill-point suite (ROADMAP P1-02, gate G1-1): factoryctl is SIGKILLed at named instants of
// a run, in every stage, between each side effect's intent and its outcome, and inside a
// remediation round; then `resume` finishes the task. Each kill point checks that the resumed
// run:
//
//   - committed every step once and re-ran none that had finished;
//   - pushed the branch once and opened one PR;
//   - left no dangling outbox intent, no staged file and no session process behind.
//
// The real CLI runs as a separate process, against a bare remote whose post-receive hook logs
// every branch update and a stub GitHub API on a loopback port, with replayed sessions (each
// with a placeholder process standing in for Claude Code) and replayed gates.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { danglingIntents } from "../github/outbox.ts";
import { memoryGitHub, serveGitHub, type MemoryGitHub } from "../github/testing.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { children, isLive, startTime, type ChildEntry } from "../proc.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { answer, assistant, result, text, toolUse } from "../session/transcript.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import { currentState, currentStatePayload } from "../task/lifecycle.ts";
import { factoryHome } from "../home.ts";

const CLI = join(REPO_ROOT, "controller/src/cli/factoryctl.ts");
const FIXTURE = join(REPO_ROOT, "gates/fixtures/ts");
const CART = readFileSync(join(FIXTURE, "src/cart.ts"), "utf8");
const pins = loadRelease(createValidator()).config.model_pins;
const TASK = "T-0001";
const BRANCH = `factory/${TASK}`;

const scratch = mkdtempSync(join(tmpdir(), "killpoints-"));
const remotes = new Map<string, string>();
const gh: MemoryGitHub = memoryGitHub((repo, branch) => spawnSync("git", ["-C", remotes.get(repo) ?? "", "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim());
let api = { url: "", close: () => Promise.resolve() };
beforeAll(async () => {
  api = await serveGitHub(gh);
});
afterAll(async () => {
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

type Scenario = "clean" | "remediation";

interface World {
  root: string;
  home: string;
  repo: string;
  remote: string;
  pushLog: string;
  replay: string;
}

/** A fresh FACTORY_HOME, target and remote; the task is created, not yet run. */
function world(name: string, scenario: Scenario): World {
  const root = mkdtempSync(join(scratch, `${name.replace(/[^a-z0-9]+/gi, "-")}-`));
  const seed = join(root, "seed");
  cpSync(FIXTURE, seed, { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "base"]);
  const remote = join(root, "remote.git");
  git(root, ["clone", "-q", "--bare", seed, remote]);
  const pushLog = join(root, "pushes.log");
  writeFileSync(join(remote, "hooks/post-receive"), `#!/bin/sh\nwhile read old new ref; do echo "$ref $new" >> '${pushLog}'; done\n`);
  chmodSync(join(remote, "hooks/post-receive"), 0o755);
  const repo = `example/${name.replace(/[^a-z0-9]+/gi, "-")}`;
  remotes.set(repo, remote);

  const profile = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
  profile["target"] = { repo, default_branch: "main", visibility: "private" };
  const profilePath = join(root, "profile.yaml");
  writeFileSync(profilePath, stringify(profile));
  const body = join(root, "task.md");
  writeFileSync(body, "Add an isEmpty helper for carts, with a test.\n");
  const home = join(root, "factory");
  const w: World = { root, home, repo, remote, pushLog, replay: join(root, "replay") };
  const created = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "task", "create", "--profile", profilePath, "--title", "Add isEmpty", "--body-file", body, "--untrusted", "--remote", remote], { encoding: "utf8", env: env(w) });
  if (created.stdout.trim() !== TASK) throw new Error(`task create: ${created.stderr}`);
  writeTranscripts(w, scenario);
  return w;
}

function env(w: { root: string; home: string }): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: w.root, FACTORY_HOME: w.home, FACTORY_GITHUB_TOKEN: "test-token", FACTORY_GITHUB_API_URL: api.url };
}

function writeTranscripts(w: World, scenario: Scenario): void {
  mkdirSync(w.replay, { recursive: true });
  const wt = join(w.home, "worktrees", TASK);
  const write = (label: string, messages: SDKMessage[]) => {
    writeFileSync(join(w.replay, `${label}.ndjson`), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  };
  const build = (file: string, content: string): SDKMessage[] => [
    assistant(pins["sonnet"] ?? "", [text("Building."), toolUse("Write", { file_path: join(wt, file), content })]),
    result(pins["sonnet"] ?? "", { costUsd: 0.4 }),
  ];
  const clean = (label: string) => {
    write(label, answer(pins["sonnet"] ?? "", { findings: [], summary: "Meets AC-1." }));
  };
  write("triage", answer(pins["haiku"] ?? "", { kind: "feature", proposed_tier: "R1", uncertain: false, duplicate_of: null, summary: "Add an emptiness check for carts." }));
  write("spec", answer(pins["opus"] ?? "", {
    objective: "Report whether a cart is empty",
    scope: { include: ["src/", "test/"], exclude: [] },
    acceptance_criteria: [{ id: "AC-1", statement: "isEmpty returns true only for an empty cart", verification: "node --test" }],
    invariants: [],
    risk_signals: [],
    required_evidence: ["unit_tests"],
    human_gate: { required: false },
    markdown: "# Spec\n\nReport whether a cart is empty.",
  }));
  write("build", build("src/cart.ts", `${CART}\nexport const isEmpty = (lines: readonly Line[]): boolean => lines.length === 0;\n`));
  clean("review-security");
  write("approve", answer(pins["opus"] ?? "", { decision: "approve", confidence: 90, criteria: [{ ac_id: "AC-1", met: true, evidence: "the test gate passes" }], blocking_findings: [], rationale: "AC-1 is met." }));
  write("summarize", answer(pins["haiku"] ?? "", { pr_body: "Adds `isEmpty`.", changelog: "Add isEmpty" }));
  if (scenario === "clean") {
    clean("review-code");
  } else {
    // Round 1: a real gap the refuter upholds; round 2 adds the test.
    write("review-code", answer(pins["sonnet"] ?? "", { findings: [{ id: "F-1", severity: "blocking", category: "correctness", file: "src/cart.ts", line: 11, title: "isEmpty has no test", failure_scenario: "AC-1 is unverified.", fix: "Add a test.", confidence: 90 }], summary: "AC-1 lacks a test." }));
    write("refute-code-F-1", answer(pins["sonnet"] ?? "", { decision: "upheld", evidence: "No test exercises isEmpty." }));
    write("build-r2", build("test/empty.test.ts", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { isEmpty } from "../src/cart.ts";\n\ntest("empty", () => {\n  assert.equal(isEmpty([]), true);\n});\n'));
    clean("review-code-r2");
    clean("review-security-r2");
  }
  writeFileSync(join(w.replay, "replay.json"), JSON.stringify({ gates: {} }));
}

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** The real CLI as its own process, without blocking this one: the stub GitHub API answers from here. */
function factoryctl(w: World, args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: env(w), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function events(w: World): FactoryEvent[] {
  const store = EventStore.open(join(w.home, "factory.db"));
  try {
    return store.events(TASK);
  } finally {
    store.close();
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const PUBLISH_STEPS = ["policy", "approve", "summarize", "publish"];
const LABELS: Record<Scenario, string[]> = {
  clean: ["checkout", "triage", "spec", "build", "gates", "review-code", "review-security", ...PUBLISH_STEPS],
  remediation: ["checkout", "triage", "spec", "build", "gates", "review-code", "review-security", "refute", "remediation", "build-r2", "gates-r2", "review-code-r2", "review-security-r2", ...PUBLISH_STEPS],
};

/** Every stage, both outbox effects, and a remediation round: [kill point, scenario]. */
const KILL_POINTS: [string, Scenario][] = [
  ["checkout:staged", "clean"],
  ["triage:session", "clean"],
  ["triage:committed", "clean"],
  ["triage:exit", "clean"],
  ["spec:session", "clean"],
  ["spec:staged", "clean"],
  ["build:session", "clean"],
  ["build:committed", "clean"],
  ["gates:running", "clean"],
  ["gates:staged", "clean"],
  ["review-code:session", "clean"],
  ["review-security:committed", "clean"],
  ["policy:staged", "clean"],
  ["approve:session", "clean"],
  ["approve:exit", "clean"],
  ["summarize:committed", "clean"],
  ["publish:push:intent", "clean"],
  ["publish:push:acted", "clean"],
  ["publish:pull_request:intent", "clean"],
  ["publish:pull_request:acted", "clean"],
  ["publish:committed", "clean"],
  ["publish:exit", "clean"],
  ["refute-code-F-1:session", "remediation"],
  ["remediation:committed", "remediation"],
  ["build-r2:session", "remediation"],
  ["gates-r2:staged", "remediation"],
];

describe.concurrent("the kill-point suite (P1-02, G1-1)", { timeout: 120_000 }, () => {
  it("covers at least 21 kill points across every stage", () => {
    expect(KILL_POINTS.length).toBeGreaterThanOrEqual(21);
    const stages = new Set(KILL_POINTS.map(([p]) => p.split(":")[0]?.replace(/-r[0-9]+$/, "").replace(/^refute-.*/, "refute")));
    for (const s of ["checkout", "triage", "spec", "build", "gates", "review-code", "review-security", "refute", "remediation", "policy", "approve", "summarize", "publish"]) expect(stages, s).toContain(s);
  });

  it.each(KILL_POINTS)("SIGKILL at %s, then resume", async (point, scenario) => {
    const w = world(point, scenario);
    const home = factoryHome({ FACTORY_HOME: w.home });
    writeFileSync(join(w.replay, "replay.json"), JSON.stringify({ gates: {}, kill_at: point }));
    const killed = await factoryctl(w, ["run", TASK, "--replay", w.replay]);
    expect(killed.signal, `${point} was never reached: ${killed.stdout}${killed.stderr}`).toBe("SIGKILL");

    // A session killed with its runner leaves its process behind, still running.
    const orphans: ChildEntry[] = children(home);
    if (point.endsWith(":session")) {
      expect(orphans.map((c) => c.label)).toEqual([point.split(":")[0]]);
      expect(isLive(orphans[0] ?? { pid: 0, start_time: null })).toBe(true);
    } else {
      expect(orphans).toEqual([]);
    }
    const before = events(w);
    const finishedBefore = new Set(before.filter((e) => e.type === "artifact_committed").map((e) => String(e.payload["label"])));

    writeFileSync(join(w.replay, "replay.json"), JSON.stringify({ gates: {} }));
    const resumed = await factoryctl(w, ["resume", TASK, "--replay", w.replay]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout.trim()).toBe(`${TASK} NEEDS_HUMAN (gate: merge) https://github.com/${w.repo}/pull/1`);

    const all = events(w);
    const after = all.slice(before.length);
    expect(currentState(all)).toBe("NEEDS_HUMAN");
    expect(currentStatePayload(all)).toMatchObject({ gate: "merge" });
    // Every step committed exactly once, and nothing finished before the kill ran again.
    expect(all.filter((e) => e.type === "artifact_committed").map((e) => String(e.payload["label"]))).toEqual(LABELS[scenario]);
    const rerun = after.filter((e) => e.type === "stage_started" && finishedBefore.has(String(e.payload["label"])));
    expect(rerun.map((e) => e.payload["label"])).toEqual([]);
    // One branch update and one PR, whatever the kill interrupted.
    const pushes = readFileSync(w.pushLog, "utf8").trim().split("\n").filter((l) => l.startsWith(`refs/heads/${BRANCH} `));
    expect(pushes).toHaveLength(1);
    expect(gh.prs.filter((p) => p.repo === w.repo)).toHaveLength(1);
    expect(gh.writes.filter((x) => x === `pull_request ${w.repo} ${BRANCH}`)).toHaveLength(1);
    // Nothing left half done: no dangling intent, no staged file, no session process.
    expect(danglingIntents(all)).toEqual([]);
    expect(walk(join(w.home, "runs", TASK)).map((f) => relative(w.home, f)).filter((f) => f.endsWith(".pending") || /\.tmp-[0-9]+$/.test(f))).toEqual([]);
    expect(children(home)).toEqual([]);
    for (const o of orphans) expect(startTime(o.pid) === o.start_time, `pid ${String(o.pid)} outlived the reap`).toBe(false);
    if (orphans.length > 0) expect(resumed.stderr).toContain(`reaped ${TASK} ${orphans[0]?.label ?? ""}`);
  });

  it("treats a lock whose pid now names another process as stale: never signalled, replaced on the next run", async () => {
    const w = world("stale-lock", "clean");
    const home = factoryHome({ FACTORY_HOME: w.home });
    const bystander = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      const pid = bystander.pid ?? 0;
      expect(startTime(pid)).not.toBeNull();
      // The pid is live, but its start time is not the one the lock recorded: another process.
      writeFileSync(home.lock, JSON.stringify({ pid, start_time: "0", task_id: TASK }));
      const halt = await factoryctl(w, ["halt", "--reason", "drill"]);
      expect(halt.stdout).toContain("no task was running");
      expect(startTime(pid)).not.toBeNull();
      expect((await factoryctl(w, ["unhalt", "--reason", "drill over"])).code).toBe(0);
      expect((await factoryctl(w, ["status"])).stdout).not.toContain("(running)");

      const run = await factoryctl(w, ["run", TASK, "--replay", w.replay]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toContain(`the run of ${TASK} (pid ${String(pid)}) ended without releasing its lock`);
      expect(startTime(pid)).not.toBeNull();
      expect(existsSync(home.lock)).toBe(false);
    } finally {
      bystander.kill("SIGKILL");
    }
  });
});
