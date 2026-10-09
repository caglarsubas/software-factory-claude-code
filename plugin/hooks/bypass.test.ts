// The hook suite (P0-05): bypass variants for the guard (gate criterion G0-2, cases in
// bypass-cases.ts), then the other three hooks. Every case runs the real hook entrypoint exactly
// as hooks.json does: `sh -c 'node <hook> || exit 2'` with JSON on stdin.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guardWorld, HOOKS, runBypassVariants, runHook as run } from "./bypass-cases.ts";

const world = guardWorld();
const { root, worktree, taskDir, configPath, broadConfigPath, call, bash, denied } = world;
afterAll(world.cleanup);

const runHook = (hook: string, stdin: string, env: Record<string, string> = { FACTORY_GUARD_CONFIG: configPath }) => run(hook, stdin, env);

const allowed: [string, string][] = [
  ["git status", bash("git status")],
  ["git log with push in the message filter", bash("git log --oneline --grep=push")],
  ["commit message mentioning push", bash('git commit -m "fix push notification bug"')],
  ["tests", bash("pnpm test")],
  ["redirect to /dev/null", bash("pnpm build > /dev/null 2>&1")],
  ["write inside scope", bash("echo x > src/orders/notes.md")],
  ["sed -i inside scope", bash("sed -i 's/a/b/' src/orders/list.ts")],
  ["copy a source into scope", bash("cp src/billing/x.ts src/orders/x.ts")],
  ["heredoc inside scope", bash("cat > src/orders/a.ts <<'EOF'\nexport const a = 1;\nEOF")],
  ["Read in the worktree", call("Read", { file_path: join(worktree, "src/orders/list.ts") })],
  ["Write in scope", call("Write", { file_path: join(worktree, "src/orders/new.ts"), content: "" })],
  ["Write the build report", call("Write", { file_path: join(taskDir, "build-report.md"), content: "" })],
  ["Grep the worktree", call("Grep", { pattern: "export", path: worktree })],
];

describe("guard denies every bypass variant (exit 2)", () => {
  it("covers at least 20 variants", () => {
    expect(denied.length).toBeGreaterThanOrEqual(20);
  });
  // One process per variant, run one after another: slower than the default timeout allows.
  it("reports them the way gate G0 counts them", { timeout: 120_000 }, () => {
    expect(runBypassVariants()).toEqual({ variants: denied.length, denied: denied.length, failures: [] });
  });
  it.each(denied)("%s", (_name, stdin) => {
    const r = runHook("guard.ts", stdin);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("software-factory:");
  });
});

describe("guard allows ordinary work", () => {
  it.each(allowed)("%s", (_name, stdin) => {
    const r = runHook("guard.ts", stdin);
    expect(r.status, r.stderr).toBe(0);
  });
});

const protectedWrites: [string, string][] = [
  ["workflow", call("Write", { file_path: join(worktree, ".github/workflows/x.yml"), content: "" })],
  ["case-variant workflow dir", call("Write", { file_path: join(worktree, ".GitHub/workflows/x.yml"), content: "" })],
  ["case-variant agent settings", call("Edit", { file_path: join(worktree, ".CLAUDE/settings.json"), old_string: "a", new_string: "b" })],
  ["git internals", call("Write", { file_path: join(worktree, ".git/config"), content: "" })],
  ["CODEOWNERS", call("Write", { file_path: join(worktree, "docs/CODEOWNERS"), content: "" })],
  ["profile-protected path, case variant", call("Write", { file_path: join(worktree, "src/Auth/session.ts"), content: "" })],
  ["remove the worktree root", bash("rm -rf .")],
  ["move a protected directory", bash("mv .github github-old")],
  ["relative write after cd", bash("cd .github && echo x > workflows/ci.yml")],
  ["sed -i after cd", bash("cd .claude; sed -i 's/a/b/' settings.json")],
  ["write after cd inside a subshell", bash("(cd .github/workflows && touch x.yml)")],
];

describe("protected paths deny writes even when the scope admits everything", () => {
  it.each(protectedWrites)("%s", (_name, stdin) => {
    const r = runHook("guard.ts", stdin, { FACTORY_GUARD_CONFIG: broadConfigPath });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("protected path");
  });
  it("still allows ordinary writes under the broad scope", () => {
    expect(runHook("guard.ts", call("Write", { file_path: join(worktree, "src/billing/x.ts"), content: "" }), { FACTORY_GUARD_CONFIG: broadConfigPath }).status).toBe(0);
  });
});

describe("fail closed", () => {
  it("blocks when the guard config is missing", () => {
    expect(runHook("guard.ts", bash("git status"), { FACTORY_GUARD_CONFIG: join(root, "nope.json") }).status).toBe(2);
  });
  it("blocks when the guard config is invalid", () => {
    const bad = join(root, "bad.json");
    writeFileSync(bad, JSON.stringify({ schema_version: 1, worktree: "relative" }));
    expect(runHook("guard.ts", bash("git status"), { FACTORY_GUARD_CONFIG: bad }).status).toBe(2);
  });
  it("blocks when the hook script itself cannot run", () => {
    expect(runHook("missing-hook.ts", bash("git status")).status).toBe(2);
  });
  it("records denials in the task ledger", () => {
    runHook("guard.ts", bash("git push"));
    const ledger = spawnSync("cat", [join(taskDir, "ledger.ndjson")], { encoding: "utf8" }).stdout;
    expect(ledger).toContain('"event":"guard_denied"');
  });
});

describe("human sessions", () => {
  const human = {};
  it("still keep secrets out of the context", () => {
    expect(runHook("guard.ts", call("Read", { file_path: join(worktree, ".env") }), human).status).toBe(2);
  });
  it("leave everything else to the human", () => {
    expect(runHook("guard.ts", bash("git push"), human).status).toBe(0);
    expect(runHook("guard.ts", call("Write", { file_path: join(worktree, ".github/x.yml"), content: "" }), human).status).toBe(0);
  });
});

describe("require-gates", () => {
  const stop = (active = false) => JSON.stringify({ hook_event_name: "Stop", session_id: "s1", stop_hook_active: active });
  // A config whose preflight is a stand-in command (factoryctl configures the gate runner).
  const withPreflight = (name: string, code: string, timeout_ms = 10_000) => {
    const path = join(taskDir, `guard-${name}.json`);
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(configPath, "utf8")) as object), preflight: { argv: [process.execPath, "-e", code], timeout_ms } }));
    return { FACTORY_GUARD_CONFIG: path };
  };
  const passing = withPreflight("preflight-pass", "process.exit(0)");
  const failing = withPreflight("preflight-fail", "console.log('typecheck: 2 errors in src/orders/list.ts'); process.exit(1)");

  it("lets a builder stop when the preflight passes", () => {
    expect(runHook("require-gates.ts", stop(), passing).status).toBe(0);
  });
  it("blocks when the preflight fails, and shows the builder why", () => {
    const r = runHook("require-gates.ts", stop(), failing);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("typecheck: 2 errors in src/orders/list.ts");
  });
  it("does not accept a preflight.json the builder wrote", () => {
    writeFileSync(join(taskDir, "preflight.json"), JSON.stringify({ passed: true }));
    expect(runHook("require-gates.ts", stop(), failing).status).toBe(2);
    rmSync(join(taskDir, "preflight.json"));
  });
  it("blocks a preflight that runs past its timeout", () => {
    const r = runHook("require-gates.ts", stop(), withPreflight("preflight-slow", "setTimeout(() => {}, 60_000)", 1000));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("timed out");
  });
  it("blocks when no preflight is configured", () => {
    expect(runHook("require-gates.ts", stop()).status).toBe(2);
  });
  it("lets a builder stop after a structured failure", () => {
    writeFileSync(join(taskDir, "build-failure.json"), JSON.stringify({ reason: "spec is contradictory" }));
    expect(runHook("require-gates.ts", stop(), failing).status).toBe(0);
    rmSync(join(taskDir, "build-failure.json"));
  });
  it("does not accept an empty failure reason", () => {
    writeFileSync(join(taskDir, "build-failure.json"), JSON.stringify({ reason: "  " }));
    expect(runHook("require-gates.ts", stop(), failing).status).toBe(2);
    rmSync(join(taskDir, "build-failure.json"));
  });
  it("also holds a builder that runs as a subagent", () => {
    const subagentStop = JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s1", stop_hook_active: false });
    expect(runHook("require-gates.ts", subagentStop, failing).status).toBe(2);
  });
  it("never loops: a stop already forced by the hook goes through", () => {
    expect(runHook("require-gates.ts", stop(true), failing).status).toBe(0);
  });
  it("ignores human sessions", () => {
    expect(runHook("require-gates.ts", stop(), {}).status).toBe(0);
  });
});

describe("format-typecheck", () => {
  // A stand-in typecheck: fails when the edited file contains TYPE_ERROR.
  const check = `const f = process.argv[1]; if (require("node:fs").readFileSync(f, "utf8").includes("TYPE_ERROR")) { console.error("type error in " + f); process.exit(1); }`;
  const formatConfigPath = join(taskDir, "guard-format.json");
  writeFileSync(
    formatConfigPath,
    JSON.stringify({
      ...(JSON.parse(readFileSync(configPath, "utf8")) as object),
      post_edit: [{ argv: [process.execPath, "-e", check], append_path: true, timeout_ms: 10000 }],
    }),
  );
  const env = { FACTORY_GUARD_CONFIG: formatConfigPath };
  const edited = (file_path: string) =>
    JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", cwd: worktree, tool_name: "Edit", tool_input: { file_path } });
  const file = join(worktree, "src/orders/list.ts");

  it("passes quietly when the commands succeed", () => {
    writeFileSync(file, "export {};\n");
    expect(runHook("format-typecheck.ts", edited(file), env).status).toBe(0);
  });
  it("reports a failing command back to Claude with exit 2", () => {
    writeFileSync(file, "export const x: number = 'TYPE_ERROR';\n");
    const r = runHook("format-typecheck.ts", edited(file), env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("type error in src/orders/list.ts");
    writeFileSync(file, "export {};\n");
  });
  it("skips files outside the worktree", () => {
    const outside = join(root, "elsewhere.ts");
    writeFileSync(outside, "TYPE_ERROR\n");
    expect(runHook("format-typecheck.ts", edited(outside), env).status).toBe(0);
  });
  it("ignores human sessions", () => {
    writeFileSync(file, "TYPE_ERROR\n");
    expect(runHook("format-typecheck.ts", edited(file), {}).status).toBe(0);
    writeFileSync(file, "export {};\n");
  });
});

describe("ledger", () => {
  it("records session events and never blocks", () => {
    const r = runHook("ledger.ts", JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s9", reason: "other" }));
    expect(r.status).toBe(0);
    expect(spawnSync("cat", [join(taskDir, "ledger.ndjson")], { encoding: "utf8" }).stdout).toContain('"session_id":"s9"');
  });
  it("does not block on malformed input", () => {
    expect(spawnSync("sh", ["-c", `node "${join(HOOKS, "ledger.ts")}" || true`], { input: "{bad", encoding: "utf8" }).status).toBe(0);
  });
});
