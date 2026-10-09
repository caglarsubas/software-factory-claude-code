// factoryctl as an operator runs it: a separate process, its own FACTORY_HOME, and --replay
// in place of a model. The run to a merge gate with real container gates is in
// factoryctl.int.test.ts.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { REPO_ROOT } from "../policy/load.ts";
import { answer } from "../session/transcript.ts";

const CLI = join(REPO_ROOT, "controller/src/cli/factoryctl.ts");
const root = mkdtempSync(join(tmpdir(), "factoryctl-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", ...args], { cwd, encoding: "utf8" });
const seed = join(root, "seed");
cpSync(join(REPO_ROOT, "gates/fixtures/ts"), seed, { recursive: true });
git(seed, ["init", "-q", "-b", "main"]);
git(seed, ["add", "-A"]);
git(seed, ["commit", "-qm", "base"]);
const remote = join(root, "remote.git");
git(root, ["clone", "-q", "--bare", seed, remote]);
const profile = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
profile["target"] = { repo: "example/ts-mini", default_branch: "main", visibility: "private" };
const profilePath = join(root, "profile.yaml");
writeFileSync(profilePath, stringify(profile));
const body = join(root, "task.md");
writeFileSync(body, "Change the billing rounding rule.\n");

const home = join(root, "factory");
const env = { PATH: process.env["PATH"] ?? "", HOME: root, FACTORY_HOME: home };
const factoryctl = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", env: { ...env, ...extra } });

function transcriptsDir(): string {
  const dir = join(root, "transcripts");
  mkdirSync(dir, { recursive: true });
  const write = (label: string, messages: SDKMessage[]) => {
    writeFileSync(join(dir, `${label}.ndjson`), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  };
  write("triage", answer("claude-haiku-5-5", { kind: "fix", proposed_tier: "R3", uncertain: false, duplicate_of: null, summary: "Adjust how billing rounds amounts." }));
  write("spec", answer("claude-opus-5-5", {
    objective: "Round billing amounts half-even",
    scope: { include: ["src/"], exclude: [] },
    acceptance_criteria: [{ id: "AC-1", statement: "Amounts round half-even", verification: "node --test" }],
    invariants: [],
    risk_signals: ["billing"],
    required_evidence: ["unit_tests"],
    human_gate: { required: true, reason: "billing logic" },
    markdown: "# Spec",
  }));
  return dir;
}

describe("factoryctl", () => {
  it("creates a task and lists it", () => {
    const created = factoryctl(["task", "create", "--profile", profilePath, "--title", "Billing rounding", "--body-file", body, "--untrusted", "--remote", remote]);
    expect(created.stderr).toBe("");
    expect(created.stdout.trim()).toBe("T-0001");
    expect(factoryctl(["status"]).stdout).toMatch(/^T-0001 {2}RECEIVED .* Billing rounding$/m);
  });

  it("runs a replayed task to the spec gate and stops for a human", () => {
    const r = factoryctl(["run", "T-0001", "--replay", transcriptsDir()]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("T-0001 NEEDS_HUMAN (gate: spec)");
    expect(factoryctl(["status", "T-0001"]).stdout).toContain("NEEDS_HUMAN  gate=spec");
  });

  it("refuses an approval from inside a Claude Code session, or without a reason", () => {
    const inside = factoryctl(["approve", "T-0001", "--gate", "spec", "--reason", "fine"], { CLAUDECODE: "1" });
    expect(inside.status).toBe(2);
    expect(inside.stderr).toContain("refuses to run inside a Claude Code session");
    expect(factoryctl(["approve", "T-0001", "--gate", "spec"]).stderr).toContain("--reason is required");
    expect(factoryctl(["approve", "T-0001", "--gate", "merge", "--reason", "x"]).stderr).toContain("GitHub review");
    const ok = factoryctl(["approve", "T-0001", "--gate", "spec", "--reason", "billing change reviewed"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("factoryctl resume T-0001");
  });

  it("cancels a task, which then ends every run at once", () => {
    expect(factoryctl(["cancel", "T-0001"]).stdout.trim()).toBe("T-0001 CANCELLED");
    expect(factoryctl(["resume", "T-0001", "--replay", transcriptsDir()]).stdout.trim()).toBe("T-0001 CANCELLED");
    expect(factoryctl(["cancel", "T-0001"]).stderr).toContain("already ended");
  });

  it("rejects unknown tasks and commands", () => {
    expect(factoryctl(["run", "T-9999"]).stderr).toContain("no task T-9999");
    expect(factoryctl(["frobnicate"]).status).toBe(2);
  });

  it("doctor reports every check and fails without an API key file", () => {
    const r = factoryctl(["doctor"], { ANTHROPIC_API_KEY: "set" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^fail {2}ANTHROPIC_API_KEY unset:/m);
    expect(r.stdout).toMatch(/^ok {4}agent sdk pin: installed 0\.3\.286, pinned 0\.3\.286$/m);
    expect(r.stdout).toMatch(/^ok {4}claude code pin:/m);
    expect(r.stdout).toMatch(/^fail {2}api key file:/m);
  });
});
