// The runner's pieces that need no container engine (P2-01): the generated managed settings and
// seccomp profile match their sources, the image pins the SDK's own CLI binary, the container
// arguments carry the hardening and nothing else, and the preflight broker answers the Stop
// hook through its spools. The container suite is conformance.runner.test.ts.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runHook } from "../../../plugin/hooks/bypass-cases.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { runnerMounts, type StageSpec } from "../session/options.ts";
import { makeSpool, runPreflight, startBroker } from "./broker.ts";
import { normalizeMounts, RUNNER_HARDENING, runArgs, runnerEnv, runnerUser, type RunnerSetup } from "./container.ts";
import { GENERATED, generated } from "./generate.ts";
import { HOOKS_DIR, managedSettings, TOKEN_PATH, unionAllow } from "./managed.ts";
import { NAMESPACE_SYSCALLS, UPSTREAM_SHA256 } from "./seccomp.ts";

const release = loadRelease(createValidator());
const scratch = mkdtempSync(join(tmpdir(), "runner-unit-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const setup: RunnerSetup = { image: "software-factory-runner:test", network: "sf-run-t-0001", proxyUrl: "http://sf-egress-t-0001:3128", seccomp: "/r/runner/seccomp/runner.json", tokenFile: "/h/sessions/T-0001/token" };

describe("generated runner files", () => {
  it("are what their one source each generates (node controller/src/runner/generate.ts)", () => {
    const files = generated();
    expect(readFileSync(join(REPO_ROOT, GENERATED.managed), "utf8")).toBe(files.managed);
    expect(readFileSync(join(REPO_ROOT, GENERATED.seccomp), "utf8")).toBe(files.seccomp);
  });

  it("keeps managed settings to the runner's own paths, with every rule a session could otherwise drop", () => {
    const m = managedSettings(release) as Record<string, unknown> & { permissions: { allow: string[]; deny: string[] }; hooks: Record<string, { hooks: { command: string }[] }[]>; sandbox: Record<string, unknown> };
    expect(m.permissions.allow).toEqual(unionAllow(release));
    for (const d of ["WebFetch", "WebSearch", "Read(//proc/*/environ)", "Read(//run/factory/**)", ...release.tools.forbidden.map((f) => f.pattern)]) expect(m.permissions.deny).toContain(d);
    for (const k of ["allowManagedPermissionRulesOnly", "allowManagedHooksOnly", "allowManagedMcpServersOnly", "disableWorkflows"]) expect(m[k]).toBe(true);
    expect(m["workflowKeywordTriggerEnabled"]).toBe(false);
    // No mod a user installed or a session wrote loads, and no instruction file but the managed CLAUDE.md.
    expect(m["pluginConfigs"]).toEqual({ "cc-plugin-agents-md@builtin": { options: { instructionFiles: "managed-only" } }, "cc-plugin-sec-default@builtin": { options: { allowManagedModsOnly: true } } });
    expect(m.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, enableWeakerNestedSandbox: false });
    expect(m["apiKeyHelper"]).toBe(`cat ${TOKEN_PATH}`);
    // Every hooks.json hook, pointed at the image's copy; nothing from the operator's machine.
    const commands = Object.values(m.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands.length).toBeGreaterThanOrEqual(6);
    for (const c of commands) expect(c).toContain(HOOKS_DIR);
    expect(JSON.stringify(m)).not.toMatch(/CLAUDE_PLUGIN_ROOT|\/home\/|\/Users\/|\.factory/);
  });

  it("adds only the namespace syscalls to Docker's pinned default seccomp profile", () => {
    const upstream = readFileSync(join(REPO_ROOT, "runner/seccomp/moby-default.json"), "utf8");
    expect(createHash("sha256").update(upstream).digest("hex")).toBe(UPSTREAM_SHA256);
    const base = (JSON.parse(upstream) as { syscalls: unknown[] }).syscalls;
    const ours = (JSON.parse(readFileSync(join(REPO_ROOT, GENERATED.seccomp), "utf8")) as { syscalls: { names: string[] }[] }).syscalls;
    expect(ours.slice(0, base.length)).toEqual(base);
    expect(ours.slice(base.length).map((r) => r.names)).toEqual([NAMESPACE_SYSCALLS]);
  });
});

describe("runner image", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "runner/Dockerfile"), "utf8");

  it("installs the Agent SDK's own CLI binary at the pinned versions, by the hash its manifest lists", () => {
    const sdk = release.config.claude_code.agent_sdk;
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "controller/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json"), "utf8")) as { version: string; platforms: Record<string, { checksum: string }> };
    expect(manifest.version).toBe(release.config.claude_code.version);
    for (const [arch, platform] of [["amd64", "linux-x64"], ["arm64", "linux-arm64"]] as const) {
      const stage = dockerfile.split(`AS downloads-${arch}`)[1]?.split("FROM ")[0] ?? "";
      expect(stage).toContain(`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-${platform}/-/claude-agent-sdk-${platform}-${sdk}.tgz`);
      expect(stage).toContain(`CLAUDE_SHA256=${manifest.platforms[platform]?.checksum ?? "missing"}`);
    }
  });

  it("copies every hook the plugin's hooks.json runs, and installs the managed settings where the CLI reads them", () => {
    const hooks = JSON.stringify(JSON.parse(readFileSync(join(REPO_ROOT, "plugin/hooks/hooks.json"), "utf8")));
    const used = [...hooks.matchAll(/hooks\/([a-z-]+\.ts)/g)].map((m) => m[1] ?? "");
    for (const h of new Set(used)) expect(dockerfile).toContain(`plugin/hooks/${h}`);
    expect(dockerfile).toContain("COPY --chmod=0644 runner/managed-settings.json /etc/claude-code/managed-settings.json");
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
  });
});

describe("runner containers", () => {
  it("run hardened, never as root, with the token read-only and mounts at their host paths", () => {
    const args = runArgs({ name: "sf-runner-t-0001-build-abc123", taskId: "T-0001", owner: { pid: 42, start_time: "7" }, setup, mounts: [{ path: "/h/worktrees/T-0001", readOnly: false }, { path: "/h/runs/T-0001/bundle", readOnly: true }], env: { HOME: "/h/sessions/T-0001/home" }, cwd: "/h/worktrees/T-0001", argv: ["/usr/local/bin/claude", "--print"] });
    const line = args.join(" ");
    expect(line).toContain(RUNNER_HARDENING.join(" "));
    expect(line).toContain("--security-opt seccomp=/r/runner/seccomp/runner.json");
    expect(line).toContain(`--user ${runnerUser()}`);
    expect(runnerUser()).not.toMatch(/^0:/);
    expect(line).toContain("--network sf-run-t-0001");
    expect(line).toContain("--mount type=bind,src=/h/worktrees/T-0001,dst=/h/worktrees/T-0001 ");
    expect(line).toContain("--mount type=bind,src=/h/runs/T-0001/bundle,dst=/h/runs/T-0001/bundle,readonly");
    expect(line).toContain(`--mount type=bind,src=/h/sessions/T-0001/token,dst=${TOKEN_PATH},readonly`);
    expect(line).toContain("--label software-factory.owner=42@7");
    expect(line).not.toMatch(/--privileged|docker\.sock|--network host|--cap-add/);
    expect(() => runArgs({ name: "n", taskId: "T-0001", owner: { pid: 1, start_time: null }, setup, mounts: [{ path: "/h/a,dst=/etc", readOnly: true }], env: {}, cwd: "/", argv: [] })).toThrow(/cannot mount/);
  });

  it("let a writable mount win over a read-only one of the same path", () => {
    expect(normalizeMounts([{ path: "/a/", readOnly: true }, { path: "/a", readOnly: false }, { path: "/b", readOnly: true }])).toEqual([{ path: "/a", readOnly: false }, { path: "/b", readOnly: true }]);
  });

  it("get exactly the session's names and the SDK's, the image's PATH and their own /tmp", () => {
    const env = runnerEnv({ PATH: "/host/bin", HOME: "/h", TMPDIR: "/h/tmp", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", ANTHROPIC_API_KEY: "leak", AWS_SECRET_ACCESS_KEY: "leak" }, ["PATH", "HOME", "TMPDIR"]);
    expect(env).toEqual({ PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/h", TMPDIR: "/tmp", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
  });

  it("mount the worktree writable for the build only, the guard config and broker answers read-only, and no more of the session directory than the CLI needs", () => {
    const wt = join(scratch, "wt");
    mkdirSync(join(wt, ".git/objects/info"), { recursive: true });
    writeFileSync(join(wt, ".git/objects/info/alternates"), "/h/mirrors/o__r.git/objects\n");
    const spec = (stage: StageSpec["stage"]): Omit<StageSpec, "budgetUsd"> => ({ stage, agent: "builder", label: stage, cwd: wt, prompt: "", extraDirs: ["/h/runs/T-1/bundle"], guard: { worktree: wt, task_dir: "/h/runs/T-1/work/x", protected_paths: [], scope: null, writable_task_files: [], secret_paths: [], readable_roots: ["/h/runs/T-1/extra"] } });
    const build = normalizeMounts(runnerMounts({ spec: spec("build"), sessionDir: "/h/sessions/T-1", guardConfig: "/h/sessions/T-1/build.guard.json", pluginDir: "/r/plugin", broker: { requests: "/h/sessions/T-1/build.preflight/requests", results: "/h/sessions/T-1/build.preflight/results" } }));
    expect(build).toEqual([
      { path: "/h/mirrors/o__r.git/objects", readOnly: true },
      { path: "/h/runs/T-1/bundle", readOnly: true },
      { path: "/h/runs/T-1/extra", readOnly: true },
      { path: "/h/runs/T-1/work/x", readOnly: false },
      { path: "/h/sessions/T-1/build.guard.json", readOnly: true },
      { path: "/h/sessions/T-1/build.preflight/requests", readOnly: false },
      { path: "/h/sessions/T-1/build.preflight/results", readOnly: true },
      { path: "/h/sessions/T-1/claude", readOnly: false },
      { path: "/h/sessions/T-1/home", readOnly: false },
      { path: "/r/plugin", readOnly: true },
      { path: wt, readOnly: false },
    ].sort((a, b) => a.path.localeCompare(b.path)));
    const review = normalizeMounts(runnerMounts({ spec: spec("review"), sessionDir: "/h/sessions/T-1", guardConfig: "/h/sessions/T-1/r.guard.json", pluginDir: "/r/plugin" }));
    expect(review.find((m) => m.path === wt)).toEqual({ path: wt, readOnly: true });
  });
});

describe("preflight broker", () => {
  const guardConfig = (dir: string, spool: { requests: string; results: string }, timeoutMs: number): string => {
    const worktree = join(dir, "wt");
    const taskDir = join(dir, "task");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(taskDir, { recursive: true });
    const path = join(dir, "guard.json");
    writeFileSync(path, JSON.stringify({ schema_version: 1, task_id: "T-0001", stage: "build", worktree, task_dir: taskDir, protected_paths: [], scope: null, writable_task_files: ["build-failure.json"], secret_paths: [], allowed_tools: ["Bash"], readable_roots: [], preflight: { broker: spool, timeout_ms: timeoutMs } }));
    return path;
  };
  const stop = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false });

  it("answers the Stop hook's request with the host's preflight: a pass lets the builder stop, a failure blocks with its output", async () => {
    for (const [argv, status] of [[["true"], 0], [["sh", "-c", "echo lint failed; exit 3"], 2]] as const) {
      const dir = mkdtempSync(join(scratch, "broker-"));
      const spool = makeSpool(join(dir, "spool"));
      let runs = 0;
      const broker = startBroker(spool, async () => {
        runs++;
        return await runPreflight(argv, dir, 10_000);
      });
      // The hook blocks its own thread while it waits, so it runs as a child process.
      const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        setImmediate(() => {
          void import("node:child_process").then(({ spawn }) => {
            const child = spawn("sh", ["-c", `node --disable-warning=ExperimentalWarning "${join(REPO_ROOT, "plugin/hooks/require-gates.ts")}" || exit 2`], { env: { PATH: process.env["PATH"] ?? "", FACTORY_GUARD_CONFIG: guardConfig(dir, spool, 20_000) } });
            let stderr = "";
            child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
            child.stdin.end(stop);
            child.on("close", (code) => {
              resolve({ status: code, stderr });
            });
          });
        });
      });
      await broker.stop();
      expect(result.status, result.stderr).toBe(status);
      expect(runs).toBe(1);
      expect(readdirSync(spool.requests)).toEqual([]);
      if (status === 2) expect(result.stderr).toContain("lint failed");
    }
  });

  it("blocks when nobody answers, and ignores anything in the spool that is not a request", async () => {
    const dir = mkdtempSync(join(scratch, "broker-"));
    const spool = makeSpool(join(dir, "spool"));
    const r = runHook("require-gates.ts", stop, { FACTORY_GUARD_CONFIG: guardConfig(dir, spool, 1000) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("did not answer within 1 s");
    // The unanswered request stays in the spool; a fresh spool for the rest.
    expect(readdirSync(spool.requests)).toHaveLength(1);
    const other = makeSpool(join(dir, "other"));
    let runs = 0;
    writeFileSync(join(other.requests, "argv; rm -rf .json"), "x");
    writeFileSync(join(other.requests, "short.json"), "x");
    const broker = startBroker(other, () => {
      runs++;
      return Promise.resolve({ schema_version: 1, status: "pass", output: "" });
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await broker.stop();
    expect(runs).toBe(0);
    expect(readdirSync(other.requests)).toEqual([]);
    expect(readdirSync(other.results)).toEqual([]);
  });

  it("times a hung preflight out", async () => {
    const r = await runPreflight(["sleep", "5"], scratch, 300);
    expect(r).toMatchObject({ status: "fail", output: expect.stringContaining("timed out") as unknown });
  });
});
