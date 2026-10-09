// factoryctl end to end with the real gate runner (needs Docker; CI's gates job): a replayed
// task on the TypeScript fixture goes through container gates, reviews and the approver, is
// pushed from the mirror and stops at the human merge gate. Zero tokens.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { REPO_ROOT } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { answer, assistant, result, toolUse } from "../session/transcript.ts";

const CLI = join(REPO_ROOT, "controller/src/cli/factoryctl.ts");
const root = mkdtempSync(join(tmpdir(), "factoryctl-int-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, args: string[]) => spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", ...args], { cwd, encoding: "utf8" });

describe("factoryctl run with container gates", () => {
  it("takes a replayed TypeScript task to the merge gate", () => {
    const seed = join(root, "seed");
    cpSync(join(REPO_ROOT, "gates/fixtures/ts"), seed, { recursive: true });
    git(seed, ["init", "-q", "-b", "main"]);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "base"]);
    const remote = join(root, "remote.git");
    git(root, ["clone", "-q", "--bare", seed, remote]);
    const profile = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
    profile["target"] = { repo: "example/ts-mini", default_branch: "main", visibility: "private" };
    profile["commands"] = { setup: "pnpm install --frozen-lockfile", typecheck: "pnpm exec tsc --noEmit", test: "node --test" };
    profile["gates"] = { adapters: ["typescript"] };
    profile["invariants"] = [];
    const profilePath = join(root, "profile.yaml");
    writeFileSync(profilePath, stringify(profile));
    writeFileSync(join(root, "task.md"), "Add an isEmpty helper for carts, with a test.\n");

    const home = join(root, "factory");
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: root, FACTORY_HOME: home };
    for (const k of ["FACTORY_GATES_FETCH_NETWORK", "FACTORY_GATES_CA_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "DOCKER_HOST"]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    const factoryctl = (args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", env });

    expect(factoryctl(["task", "create", "--profile", profilePath, "--title", "Add isEmpty", "--body-file", join(root, "task.md"), "--remote", remote]).stdout.trim()).toBe("T-0001");

    const wt = join(home, "worktrees/T-0001");
    const cart = readFileSync(join(seed, "src/cart.ts"), "utf8");
    const dir = join(root, "transcripts");
    mkdirSync(dir);
    const write = (label: string, messages: SDKMessage[]) => {
      writeFileSync(join(dir, `${label}.ndjson`), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    };
    write("triage", answer("claude-haiku-5-5", { kind: "feature", proposed_tier: "R1", uncertain: false, duplicate_of: null, summary: "Add an emptiness check for carts." }));
    write("spec", answer("claude-opus-5-5", {
      objective: "Report whether a cart is empty",
      scope: { include: ["src/", "test/"], exclude: [] },
      acceptance_criteria: [{ id: "AC-1", statement: "isEmpty is true only for an empty cart", verification: "node --test" }],
      invariants: [], risk_signals: [], required_evidence: ["unit_tests"], human_gate: { required: false }, markdown: "# Spec",
    }));
    write("build", [
      assistant("claude-sonnet-5-5", [
        toolUse("Write", { file_path: join(wt, "src/cart.ts"), content: `${cart}\nexport const isEmpty = (lines: readonly Line[]): boolean => lines.length === 0;\n` }),
        toolUse("Write", { file_path: join(wt, "test/empty.test.ts"), content: 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { isEmpty } from "../src/cart.ts";\n\ntest("empty", () => {\n  assert.equal(isEmpty([]), true);\n  assert.equal(isEmpty([{ sku: "a", unitCents: 1, quantity: 1 }]), false);\n});\n' }),
      ]),
      result("claude-sonnet-5-5"),
    ]);
    write("review-code", answer("claude-sonnet-5-5", { findings: [], summary: "Meets AC-1." }));
    write("review-security", answer("claude-opus-5-5", { findings: [], summary: "No security-relevant change." }));
    write("approve", answer("claude-opus-5-5", { decision: "approve", confidence: 90, criteria: [{ ac_id: "AC-1", met: true, evidence: "the test gate passed" }], blocking_findings: [], rationale: "AC-1 met." }));
    write("summarize", answer("claude-haiku-5-5", { pr_body: "Adds isEmpty.", changelog: "Add isEmpty for carts" }));

    const r = factoryctl(["run", "T-0001", "--replay", dir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("T-0001 NEEDS_HUMAN (gate: merge)");

    const run = join(home, "runs/T-0001");
    const gates = JSON.parse(readFileSync(join(run, "gates.json"), "utf8")) as { passed: boolean; gates: { name: string; status: string }[] };
    expect(gates.passed, JSON.stringify(gates.gates)).toBe(true);
    expect(gates.gates.map((g) => g.name)).toEqual(["sast", "secret-scan", "dependency-audit", "setup", "typecheck", "test"]);
    const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8")) as { candidate_commit: string };
    expect(createValidator().validate("manifest.schema.json", manifest).errors).toEqual([]);
    expect(git(remote, ["rev-parse", "refs/heads/factory/T-0001"]).stdout.trim()).toBe(manifest.candidate_commit);
  });
});
