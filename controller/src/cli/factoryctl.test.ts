// factoryctl as an operator runs it: a separate process, its own FACTORY_HOME, and --replay
// in place of a model. The run to a merge gate with real container gates is in
// factoryctl.int.test.ts.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { REPO_ROOT } from "../policy/load.ts";
import { isoWeek, WEEK_HEADER } from "../report/report.ts";
import { answer, assistant, result, toolUse } from "../session/transcript.ts";

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

// Each test spawns factoryctl, which loads the SDK and the schemas: allow for a loaded machine.
describe("factoryctl", { timeout: 30_000 }, () => {
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

  it("halts every run until the operator lifts the halt (kill switch v0)", () => {
    const halted = factoryctl(["halt", "--reason", "drill"]);
    expect(halted.status, halted.stderr).toBe(0);
    expect(halted.stdout).toMatch(/^factory halted since \S+ by \S+: drill$/m);
    expect(halted.stdout).toContain("no attended task was running");
    expect(factoryctl(["status"]).stdout).toMatch(/^HALTED {2}halted since .*: drill$/m);
    expect(factoryctl(["doctor"]).stdout).toMatch(/^warn {2}kill switch: halted since .*: drill; lift with/m);
    const run = factoryctl(["run", "T-0001"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("the factory is halted since");

    expect(factoryctl(["unhalt", "--reason", "over"], { CLAUDECODE: "1" }).stderr).toContain("unhalt refuses to run inside a Claude Code session");
    expect(factoryctl(["unhalt"]).stderr).toContain("--reason is required");
    const lifted = factoryctl(["unhalt", "--reason", "drill over"]);
    expect(lifted.status, lifted.stderr).toBe(0);
    expect(lifted.stdout).toContain("factory running again (was halted since");
    expect(factoryctl(["unhalt", "--reason", "again"]).stderr).toContain("the factory is not halted");
    const log = readFileSync(join(home, "halt.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { command: string; reason: string });
    expect(log.map((l) => `${l.command}: ${l.reason}`)).toEqual(["halt: drill", "unhalt: drill over"]);
  });

  it("records an operator's rejection as human_rejected, and reports the task and its week (P1-07)", () => {
    expect(factoryctl(["task", "create", "--profile", profilePath, "--title", "Billing rounding", "--body-file", body, "--untrusted", "--remote", remote]).stdout.trim()).toBe("T-0002");
    expect(factoryctl(["run", "T-0002", "--replay", transcriptsDir()]).stdout.trim()).toBe("T-0002 NEEDS_HUMAN (gate: spec)");
    expect(factoryctl(["reject", "T-0002", "--reason", "wrong scope"], { CLAUDECODE: "1" }).stderr).toContain("reject refuses to run inside a Claude Code session");
    expect(factoryctl(["reject", "T-0002"]).stderr).toContain("--reason is required");
    const rejected = factoryctl(["reject", "T-0002", "--reason", "wrong scope"]);
    expect(rejected.status, rejected.stderr).toBe(0);
    expect(rejected.stdout.trim()).toBe("T-0002 FAILED (human_rejected)");
    expect(factoryctl(["reject", "T-0002", "--reason", "again"]).stderr).toContain("already ended");

    const report = factoryctl(["report", "T-0002"]);
    expect(report.status, report.stderr).toBe(0);
    expect(report.stdout).toMatch(/^T-0002 {2}FAILED {2}human_rejected {2}replayed {2}rounds 1$/m);
    expect(report.stdout).toMatch(/^triage +replay +1 +3 +1,200 +300 +0\.0 +0\.05$/m);
    expect(report.stdout).toMatch(/^total .* 0\.10$/m);

    const week = isoWeek(new Date());
    const row = factoryctl(["report", "--week", week]);
    expect(row.status, row.stderr).toBe(0);
    expect(row.stdout).toContain(WEEK_HEADER);
    // Both tasks ran replayed sessions: a week row never counts them.
    expect(row.stdout).toContain(`| ${week} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | $0.00 in total; 2 replayed, not counted |`);
    expect(factoryctl(["report", "--week", "2026-42"]).stderr).toContain("a week is YYYY-Www");
  });

  it("stops an over-budget task with budget_exceeded and records the tier budgets (P1-01)", () => {
    expect(factoryctl(["task", "create", "--profile", profilePath, "--title", "Billing rounding", "--body-file", body, "--untrusted", "--remote", remote]).stdout.trim()).toBe("T-0003");
    // Triage runs at the highest tier's budget; this one reports more than all of it.
    const dir = join(root, "over-budget");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "triage.ndjson"), answer("claude-haiku-5-5", { kind: "fix", proposed_tier: "R1", uncertain: false, duplicate_of: null, summary: "Adjust rounding." }).map((m) => JSON.stringify(m.type === "result" ? { ...m, total_cost_usd: 70 } : m)).join("\n") + "\n");
    const r = factoryctl(["run", "T-0003", "--replay", dir]);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe("T-0003 FAILED");
    expect(r.stderr).toMatch(/triage failed \(budget_exceeded\): the task spent \$70\.00 of its Restricted budget \$60\.00/);
    expect(factoryctl(["report", "T-0003"]).stdout).toMatch(/^T-0003 {2}FAILED {2}budget_exceeded/m);

    const b = factoryctl(["budgets"]);
    expect(b.status, b.stderr).toBe(0);
    expect(b.stdout).toMatch(/^R1 +\$12\.00 {2}initial +0 {2}—$/m);
    expect(b.stdout).toMatch(/^20[0-9]{2}-[0-9]{2} {2}example\/ts-mini: \$0\.00 of \$300\.00$/m);
    const recorded = JSON.parse(readFileSync(join(home, "budgets/calibration.json"), "utf8")) as { tiers: Record<string, { budget: number; source: string }> };
    expect(recorded.tiers["R0"]).toMatchObject({ budget: 3, source: "initial" });
  });

  it("installs releases only from the operator, and only from a version tag", () => {
    expect(factoryctl(["release", "status"]).stdout.trim()).toBe("no release installed");
    expect(factoryctl(["release", "install", "v0.1.0"], { CLAUDECODE: "1" }).stderr).toContain("release install refuses to run inside a Claude Code session");
    expect(factoryctl(["release", "use", "v0.1.0"], { CLAUDECODE: "1" }).stderr).toContain("release use refuses to run inside a Claude Code session");
    expect(factoryctl(["release", "install", "main", "--source", seed]).stderr).toContain("a release is a version tag like v0.1.0");
    expect(factoryctl(["release", "install", "v0.1.0", "--source", seed]).stderr).toContain("v0.1.0 is not a tag");
    expect(factoryctl(["release", "frobnicate"]).status).toBe(2);
  });

  it("opens the G0 evidence window on a checkout and drafts the evidence", { timeout: 120_000 }, () => {
    expect(factoryctl(["gate", "G2"]).status).toBe(2);
    const begin = factoryctl(["gate", "G0", "--begin", "--checkout", seed]);
    expect(begin.status, begin.stderr).toBe(0);
    expect(begin.stdout).toMatch(/^snapshot .*seed: [0-9]+ files, sha256:[0-9a-f]{64}$/m);
    expect(begin.stdout).toContain("(development checkout, not an installed release)");
    const gate = factoryctl(["gate", "G0"]);
    // From a development checkout with no dry runs, only the bypass suite can pass.
    expect(gate.status).toBe(1);
    expect(gate.stdout).toMatch(/^fail {3}G0-1 {2}py-mini: no dry run in the evidence window/m);
    expect(gate.stdout).toMatch(/^pass {3}G0-2 {2}[0-9]+ of [0-9]+ variants exit 2 through the released guard hook$/m);
    expect(gate.stdout).toMatch(/^human {2}G0-5 /m);
    expect(existsSync(join(home, "gates/G0/evidence.json"))).toBe(true);
    expect(readFileSync(join(home, "gates/G0/evidence.md"), "utf8")).toContain("## Gate G0 evidence");

    // G1 checks its own criteria, from a window of its own.
    const g1 = factoryctl(["gate", "G1"]);
    expect(g1.status).toBe(1);
    expect(g1.stdout).toMatch(/^fail {3}G1-3 {2}no snapshot: run `factoryctl gate G1 --begin` before the last counted task/m);
    expect(g1.stdout).toMatch(/^fail {3}G1-1 {2}factory CI: no installed release to check CI on$/m);
    expect(g1.stdout).toMatch(/^pass {3}G1-5 {2}recorded .* from [0-9]+ completed runs, and equal to the rule applied to the event store now$/m);
    expect(g1.stdout).toMatch(/^human {2}G1-6 /m);
    expect(readFileSync(join(home, "gates/G1/evidence.md"), "utf8")).toContain("## Gate G1 evidence");
  });

  it("keeps test-only injection off anything that leaves the machine, and the token off plain http (P1-02)", () => {
    expect(factoryctl(["task", "create", "--profile", profilePath, "--title", "Billing rounding", "--body-file", body, "--untrusted", "--remote", "https://github.com/example/ts-mini.git"]).stdout.trim()).toBe("T-0004");
    const dir = join(root, "injected");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "replay.json"), JSON.stringify({ gates: {} }));
    const remoteRun = factoryctl(["run", "T-0004", "--replay", dir]);
    expect(remoteRun.status).toBe(2);
    expect(remoteRun.stderr).toContain("replayed gates need a task with a local remote");
    const apiRun = factoryctl(["run", "T-0001", "--replay", dir], { FACTORY_GITHUB_TOKEN: "t", FACTORY_GITHUB_API_URL: "https://api.github.com" });
    expect(apiRun.stderr).toContain("a loopback FACTORY_GITHUB_API_URL");
    const http = factoryctl(["run", "T-0001"], { FACTORY_GITHUB_API_URL: "http://ghe.example" });
    expect(http.status).toBe(2);
    expect(http.stderr).toContain("FACTORY_GITHUB_API_URL must be https, or http on a loopback address");
  });

  it("pauses a task, streams it with --attach, and sends a takeover back through the gates (P1-04)", () => {
    expect(factoryctl(["task", "create", "--profile", profilePath, "--title", "Add isEmpty", "--body-file", body, "--untrusted", "--remote", remote]).stdout.trim()).toBe("T-0005");
    const dir = join(root, "full");
    mkdirSync(dir, { recursive: true });
    const write = (label: string, messages: SDKMessage[]) => {
      writeFileSync(join(dir, `${label}.ndjson`), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    };
    const wt = join(home, "worktrees", "T-0005");
    write("triage", answer("claude-haiku-5-5", { kind: "feature", proposed_tier: "R1", uncertain: false, duplicate_of: null, summary: "Add an emptiness check." }));
    write("spec", answer("claude-opus-5-5", { objective: "Report whether a cart is empty", scope: { include: ["src/", "test/"], exclude: [] }, acceptance_criteria: [{ id: "AC-1", statement: "isEmpty works", verification: "node --test" }], invariants: [], risk_signals: [], required_evidence: ["unit_tests"], human_gate: { required: false }, markdown: "# Spec" }));
    write("build", [assistant("claude-sonnet-5-5", [toolUse("Write", { file_path: join(wt, "src/empty.ts"), content: "export const isEmpty = (n: number): boolean => n === 0;\n" })]), result("claude-sonnet-5-5")]);
    for (const label of ["review-code", "review-security"]) write(label, answer("claude-sonnet-5-5", { findings: [], summary: "Fine." }));
    write("approve", answer("claude-opus-5-5", { decision: "approve", confidence: 90, criteria: [{ ac_id: "AC-1", met: true, evidence: "the test gate passes" }], blocking_findings: [], rationale: "Met." }));
    write("summarize", answer("claude-haiku-5-5", { pr_body: "Adds isEmpty.", changelog: "Add isEmpty" }));
    writeFileSync(join(dir, "replay.json"), JSON.stringify({ gates: {} }));

    // A paused task does not run until resume lifts the pause.
    expect(factoryctl(["pause", "T-0005", "--reason", "not yet"]).stdout).toContain("T-0005 paused; continue it with: factoryctl resume T-0005");
    expect(factoryctl(["status", "T-0005"]).stdout).toContain("(paused)");
    const refused = factoryctl(["run", "T-0005", "--replay", dir]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("T-0005 is paused; continue it with: factoryctl resume T-0005");
    const resumed = factoryctl(["resume", "T-0005", "--attach", "--replay", dir]);
    expect(resumed.stdout.trim()).toBe("T-0005 NEEDS_HUMAN (gate: merge)");
    expect(resumed.stderr).toContain(`  build │ → Write ${join(wt, "src/empty.ts")}`);
    expect(resumed.stderr).toMatch(/ {2}approve │ ■ success: 3 turns, \$0\.05, 1s/);

    // A stand-in for the operator's Claude Code: it records how it was started and edits the worktree.
    const seen = join(root, "takeover-seen.json");
    const fake = join(root, "fake-claude.mjs");
    writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { process.stdout.write(process.env.FAKE_VERSION ?? "2.1.286 (Claude Code)\\n"); process.exit(0); }
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env).sort(), cwd: process.cwd() }));
appendFileSync("src/empty.ts", "// reviewed by hand\\n");
`);
    chmodSync(fake, 0o755);
    expect(factoryctl(["takeover", "T-0005"], { FACTORY_CLAUDE_BIN: fake, CLAUDECODE: "1" }).stderr).toContain("takeover refuses to run inside a Claude Code session");
    expect(factoryctl(["takeover", "T-0005"], { FACTORY_CLAUDE_BIN: join(root, "nowhere") }).stderr).toContain("is not Claude Code 2.1.286");
    const took = factoryctl(["takeover", "T-0005"], { FACTORY_CLAUDE_BIN: fake, FACTORY_GITHUB_TOKEN: "must-not-reach-it", ANTHROPIC_API_KEY: "nor-this" });
    expect(took.status, took.stderr).toBe(0);
    expect(took.stdout).toMatch(/T-0005: candidate [0-9a-f]{12} → [0-9a-f]{12}; it goes through the gates and every review again: factoryctl resume T-0005/);
    const launched = JSON.parse(readFileSync(seen, "utf8")) as { args: string[]; env: string[]; cwd: string };
    expect(launched.cwd).toBe(wt);
    // Replayed sessions are not resumable: a new session, in auto mode, under the release's plugin and settings.
    expect(launched.args).not.toContain("--resume");
    expect(launched.args.join(" ")).toMatch(/--permission-mode auto --settings \S+takeover\.settings\.json --setting-sources {2}--strict-mcp-config --plugin-dir \S+/);
    expect(launched.env.filter((k) => /TOKEN|API_KEY|SSH_AUTH/.test(k))).toEqual([]);
    const settings = JSON.parse(readFileSync(launched.args[launched.args.indexOf("--settings") + 1] ?? "", "utf8")) as { permissions: { defaultMode: string; disableBypassPermissionsMode: string }; sandbox: { enabled: boolean; failIfUnavailable: boolean }; apiKeyHelper: string };
    expect(settings).toMatchObject({ permissions: { defaultMode: "auto", disableBypassPermissionsMode: "disable" }, sandbox: { enabled: true, failIfUnavailable: true } });
    expect(settings.apiKeyHelper).toContain(join(home, "secrets"));
    expect(factoryctl(["status", "T-0005"]).stdout).toContain("T-0005  BUILDING");

    const again = factoryctl(["resume", "T-0005", "--replay", dir]);
    expect(again.stdout.trim()).toBe("T-0005 NEEDS_HUMAN (gate: merge)");
    expect(spawnSync("git", ["-C", remote, "show", "factory/T-0005:src/empty.ts"], { encoding: "utf8" }).stdout).toContain("// reviewed by hand");
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
    expect(r.stdout).toMatch(/^ok {4}telemetry: off;/m);
    expect(r.stdout).toMatch(/^ok {4}model alarms: no alias alarm in 30 days$/m);
    expect(factoryctl(["doctor"], { FACTORY_OTEL_ENDPOINT: "http://127.0.0.1:4318" }).stdout).toMatch(/^ok {4}telemetry: OTLP http\/protobuf to http:\/\/127\.0\.0\.1:4318$/m);
    expect(factoryctl(["doctor"], { FACTORY_OTEL_ENDPOINT: "https://otel.example.com" }).stdout).toMatch(/^fail {2}telemetry: FACTORY_OTEL_ENDPOINT must be a collector on this machine's loopback address/m);
    // A run refuses a telemetry endpoint off this machine before it starts.
    const remote = factoryctl(["run", "T-0001"], { FACTORY_OTEL_ENDPOINT: "https://otel.example.com" });
    expect(remote.status).toBe(2);
    expect(remote.stderr).toContain("FACTORY_OTEL_ENDPOINT must be a collector");
  });
});
