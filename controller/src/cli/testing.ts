// Shared by the CLI suites that drive the real factoryctl with replayed sessions (the kill-point
// suite, P1-02, and the serve suite, P2-03): a fixture target with a logging bare remote, and the
// transcripts of one task's run.
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { REPO_ROOT } from "../policy/load.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { answer, assistant, result, text, toolUse } from "../session/transcript.ts";

export const CLI = join(REPO_ROOT, "controller/src/cli/factoryctl.ts");
export const FIXTURE = join(REPO_ROOT, "gates/fixtures/ts");
const CART = readFileSync(join(FIXTURE, "src/cart.ts"), "utf8");
const pins = loadRelease(createValidator()).config.model_pins;

export type Scenario = "clean" | "remediation";

export const git = (cwd: string, args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** The ts fixture as a target: a seed repository and a bare remote whose post-receive hook logs every branch update. */
export function seedTarget(root: string): { remote: string; pushLog: string } {
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
  return { remote, pushLog };
}

export function writeTranscripts(replay: string, home: string, task: string, scenario: Scenario): void {
  mkdirSync(replay, { recursive: true });
  const wt = join(home, "worktrees", task);
  const write = (label: string, messages: SDKMessage[]) => {
    writeFileSync(join(replay, `${label}.ndjson`), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
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
  writeFileSync(join(replay, "replay.json"), JSON.stringify({ gates: {} }));
}
