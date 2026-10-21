// The runner conformance suite (ROADMAP P2-01, done when it passes inside the image): the pinned
// CLI runs in a runner container, driven by the real SDK through prepareSession and
// containerSpawner, against a stub model on the task's internal network. It shows that the
// managed layer enforces on its own, that the Bash sandbox runs in its normal mode, that the
// network's only exit is the egress proxy and the proxy refuses the host, that the container
// holds no credential and its env is exactly the allowlist, that the preflight broker answers
// the Stop hook, and that a run killed mid-session leaves a container reaping removes. From
// P2-02 it also shows the model reached only through the proxy's route to the credential
// gateway on the host, which holds the key, meters each turn and stops a session at its cap.
// Since the switch-on, `startTaskRunner` sets a task up for live sessions the same way, and
// removes its network and proxy when the run ends.
//
//   pnpm test:runner      (needs Docker; CI's runner job, on x64 and arm64)
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE } from "../../../gates/src/container.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { loadRelease } from "../release.ts";
import { clearHalt, setHalt } from "../halt.ts";
import { factoryHome, sessionDir } from "../home.ts";
import { createValidator } from "../schemas/validate.ts";
import { allowedEnvKeys } from "../session/env.ts";
import type { Script } from "../session/stub-model.ts";
import { listContainers, reapRunnerContainers, runArgs, runnerEnv, runnerUser, SDK_ENV, type RunnerSetup } from "./container.ts";
import { ensureTaskNetwork, gatewayAddress, networkName, proxyName, removeTaskNetwork } from "./network.ts";
import { startTaskRunner } from "./live.ts";
import { buildWorld, CANARIES, destroyWorld, MOD_PROBE, own, plantMod, runCase, stubLog, type World } from "./suite.ts";
import { startGateway, writeTokenFile, type UsageEntry } from "../gateway/gateway.ts";
import { stubHandler } from "../session/stub-model.ts";
import { self } from "../proc.ts";

const TASK = "T-9001";
/** The network whose proxy carries the gateway route. */
const GATEWAY_TASK = "T-9002";
const online = process.env["CI"] === "true" || process.env["RUNNER_SUITE_ONLINE"] === "1";
const validator = createValidator();
const release = loadRelease(validator);
const root = mkdtempSync(join(tmpdir(), "runner-suite-"));

const sh = (command: string): { tool: string; input: Record<string, unknown> } => ({ tool: "Bash", input: { command, description: "probe" } });
const done = { text: "done" };

let w: World;
/** The suite's session config directory (prepareSession's), where a user's own plugins and mods would live. */
const configDir = (): string => join(sessionDir(factoryHome({ FACTORY_HOME: w.homeRoot }), TASK), "claude");
/** A fixed id for the instructions case, so a mod planted for "that session" is planted where it would load. */
const MOD_SESSION = "5f0c2a8e-7d4b-4c1a-9e3f-0a1b2c3d4e5f";

const script = (): Script => ({
  "write-guarded": [{ tool: "Write", input: { file_path: join(w.worktree, "secret/leak.txt"), content: "x" } }, sh("test -e secret/leak.txt && echo EXISTS || echo ABSENT"), done],
  "managed-only": [{ tool: "WebFetch", input: { url: "https://example.com/", prompt: "read it" } }, { tool: "Write", input: { file_path: join(w.worktree, "secret/managed.txt"), content: "x" } }, done],
  "sandbox": [sh([
    "echo UID=$(id -u)",
    "echo PIDS=$(ls /proc | grep -cE '^[0-9]+$')",
    "cat /run/factory/api-token >/dev/null 2>&1 && echo TOKEN-READABLE || echo TOKEN-DENIED",
    `grep -c '${join(w.homeRoot, "secrets")}' /proc/self/mountinfo || true`,
    "grep -c 'docker.sock' /proc/self/mountinfo || true",
  ].join("; ")), done],
  "halted": [sh("echo still-running"), done],
  "egress": [sh([
    "NODE_USE_ENV_PROXY=1 node -e \"fetch('https://example.com/').then(r=>console.log('EXAMPLE',r.status),()=>console.log('EXAMPLE-BLOCKED'))\"",
    "NODE_USE_ENV_PROXY=1 node -e \"fetch('https://registry.npmjs.org/-/ping').then(r=>console.log('REGISTRY',r.status),e=>console.log('REGISTRY-FAILED',String(e.cause?.code ?? e)))\"",
  ].join("; ")), done],
  "instructions": [
    { tool: "Read", input: { file_path: join(w.worktree, "pkg/a.ts") } },
    { tool: "Read", input: { file_path: join(w.worktree, "lib/b.ts") } },
    sh(MOD_PROBE),
    sh(`touch '${join(w.pluginDir, "hooks/sf-written")}' 2>/dev/null && echo PLUGIN-WRITABLE || echo PLUGIN-DENIED; mkdir '${join(configDir(), "skills")}/sf-written' 2>/dev/null && echo CONFIG-WRITABLE || echo CONFIG-DENIED`),
    done,
  ],
  "broker-fail": [{ text: "first stop" }, { text: "second stop" }],
  "broker-pass": [{ text: "first stop" }, { text: "should not be asked" }],
  "sleep": [sh("sleep 120"), done],
  // Each turn reports 50k tokens in and 5k out on the builder's Sonnet 5.5: $0.15 a turn, within the CLI's context window.
  "gateway-cap": [1, 2, 3].map((n) => ({ ...sh(`echo turn-${String(n)}`), usage: { input_tokens: 50_000, output_tokens: 5_000 } })).concat([{ ...sh("echo never"), usage: { input_tokens: 1, output_tokens: 1 } }]),
});

const results = (name: string): { is_error?: boolean; content?: unknown }[] => {
  const last = stubLog(w, name).at(-1);
  return (last?.["tool_results"] ?? []) as { is_error?: boolean; content?: unknown }[];
};
const text = (r: { content?: unknown } | undefined): string => (typeof r?.content === "string" ? r.content : JSON.stringify(r?.content ?? ""));
const messages = (file: string): SDKMessage[] => readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as SDKMessage);

beforeAll(() => {
  // The script names paths in the world, so it is written once the world exists (the stub reads it per request).
  w = buildWorld(join(root, "world"), TASK, {});
  writeFileSync(join(w.root, "stub/script.json"), JSON.stringify(script()));
  own(join(w.root, "stub"));
  writeFileSync(join(root, "world.json"), JSON.stringify(w));
}, 1_800_000);

afterAll(() => {
  reapRunnerContainers();
  destroyWorld(w);
  spawnSync("chmod", ["-R", "u+w", root]);
  rmSync(root, { recursive: true, force: true });
});

describe("runner conformance (P2-01)", () => {
  it("runs the pinned CLI, as the operator's uid, with exactly the allowlisted env", () => {
    const version = spawnSync(ENGINE, ["run", "--rm", w.image, "claude", "--version"], { encoding: "utf8" });
    expect(version.stdout.trim()).toBe(`${release.config.claude_code.version} (Claude Code)`);
    // The env a session's container gets: what runArgs passes, plus HOSTNAME, which the engine always adds.
    const sessionEnv = { PATH: "/x", HOME: w.root, HTTPS_PROXY: w.setup.proxyUrl, NO_PROXY: "", FACTORY_GUARD_CONFIG: "/g", CLAUDE_AGENT_SDK_VERSION: "0", OPENAI_API_KEY: "leak" };
    const env = runnerEnv(sessionEnv, ["PATH", "HOME", "HTTPS_PROXY", "NO_PROXY", "FACTORY_GUARD_CONFIG"]);
    const args = runArgs({ name: `sf-runner-envcheck-${String(process.pid)}`, taskId: TASK, owner: self(), setup: w.setup, mounts: [{ path: w.worktree, readOnly: true }], env, cwd: w.worktree, argv: ["/usr/bin/env"] });
    const r = spawnSync(ENGINE, args, { encoding: "utf8", input: "" });
    expect(r.status, r.stderr).toBe(0);
    const keys = r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => l.slice(0, l.indexOf("="))).filter((k) => k !== "HOSTNAME").sort();
    expect(keys).toEqual(["CLAUDE_AGENT_SDK_VERSION", "FACTORY_GUARD_CONFIG", "HOME", "HTTPS_PROXY", "NO_PROXY", "PATH"]);
    // A read-only root: only the mounts and /tmp are writable.
    const touch = spawnSync(ENGINE, runArgs({ name: `sf-runner-rocheck-${String(process.pid)}`, taskId: TASK, owner: self(), setup: w.setup, mounts: [], env: {}, cwd: "/", argv: ["sh", "-c", "touch /usr/local/bin/x 2>/dev/null && echo WRITABLE || echo READ-ONLY"] }), { encoding: "utf8", input: "" });
    expect(touch.stdout.trim()).toBe("READ-ONLY");
    expect(SDK_ENV).toContain("CLAUDE_AGENT_SDK_VERSION");
  });

  it("enforces the guard in the runner even with a project disableAllHooks, and never runs plugin hooks", async () => {
    const r = await runCase(w, "write-guarded", { protected: ["secret/**"] }, validator);
    expect(r.outcome.ok, r.outcome.errors.join("; ")).toBe(true);
    expect(existsSync(join(w.worktree, "secret/leak.txt"))).toBe(false);
    expect(text(results("write-guarded")[1])).toContain("ABSENT");
    // The managed guard hook in the runner denied it (the plugin's copy never ran).
    const ledger = readFileSync(join(w.taskDir, "ledger.ndjson"), "utf8");
    expect(ledger).toMatch(/"event":"guard_denied","tool":"Write"/);
    expect(existsSync(join(w.taskDir, "plugin-hook-ran"))).toBe(false);
    expect(allowedEnvKeys(Object.keys(r.prepared.env).sort())).toBe(true);
  }, 300_000);

  it("keeps the in-process guard on the host: a halt stops a runner session's next tool call", async () => {
    const home = factoryHome({ FACTORY_HOME: w.homeRoot });
    setHalt(home, "operator", "conformance");
    try {
      const r = await runCase(w, "halted", {}, validator);
      // Only the host-side guard reads the kill switch: the denial is its.
      expect(r.prepared.denials).toEqual([expect.objectContaining({ tool: "Bash", reason: expect.stringContaining("halted") as unknown })]);
      expect(text(results("halted")[0])).not.toContain("still-running");
    } finally {
      clearHalt(home);
    }
  }, 300_000);

  it("enforces from the managed layer alone: no session settings, no in-process guard, bypass refused", async () => {
    const r = await runCase(w, "managed-only", {
      protected: ["secret/**"],
      tweak: (p) => {
        // Everything the session passes is gone or widened; only the image's managed settings remain.
        const o = p.options;
        delete o.hooks;
        o.settings = {};
        o.permissionMode = "bypassPermissions";
        o.allowDangerouslySkipPermissions = true;
        o.tools = [...(Array.isArray(o.tools) ? o.tools : []), "WebFetch"];
        o.allowedTools = [...(o.allowedTools ?? []), "WebFetch", "Write(/**)"];
        o.disallowedTools = [];
      },
    }, validator);
    const init = messages(r.transcript).find((m) => m.type === "system" && m.subtype === "init") as { permissionMode?: string } | undefined;
    expect(init?.permissionMode).not.toBe("bypassPermissions");
    const [web, write] = results("managed-only");
    expect(web?.is_error).toBe(true);
    expect(existsSync(join(w.worktree, "secret/managed.txt"))).toBe(false);
    expect(write?.is_error).toBe(true);
  }, 300_000);

  it("sandboxes Bash in its normal mode: own pid namespace, no token, no secrets or engine socket", async () => {
    const r = await runCase(w, "sandbox", {}, validator);
    expect(r.outcome.ok, r.outcome.errors.join("; ")).toBe(true);
    const out = text(results("sandbox")[0]);
    const uid = /UID=(\d+)/.exec(out)?.[1];
    expect(uid).toBe(runnerUser().split(":")[0]);
    expect(uid).not.toBe("0");
    expect(Number(/PIDS=(\d+)/.exec(out)?.[1] ?? "99")).toBeLessThan(10);
    expect(out).toContain("TOKEN-DENIED");
    expect(out).not.toMatch(/^[1-9]\d*$/m);
  }, 300_000);

  it("lets sandboxed commands out only through the sandbox's allowlist and the egress proxy", async () => {
    await runCase(w, "egress", {}, validator);
    const out = text(results("egress")[0]);
    expect(out).toContain("EXAMPLE-BLOCKED");
    const log = existsSync(w.net.log) ? readFileSync(w.net.log, "utf8") : "";
    // Whatever reached the proxy was on its allowlist; example.com never got that far.
    expect(log).not.toContain("example.com");
    if (online) {
      expect(out).toMatch(/REGISTRY (200|404)/);
      expect(log).toMatch(/"target":"registry\.npmjs\.org:443","decision":"allowed"/);
    }
  }, 300_000);

  it("gives the runner network no exit but the proxy, and the proxy refuses the host and non-public addresses", async () => {
    // A host service the runner must not reach, on every host address.
    const server = createServer((s) => s.end("HOST-REACHED")).listen(0, "0.0.0.0");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const gateway = spawnSync(ENGINE, ["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"], { encoding: "utf8" }).stdout.trim() || "172.17.0.1";
    const probe = `
      const net = require("node:net");
      const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); r("open"); }); s.on("timeout", () => { s.destroy(); r("closed"); }); s.on("error", () => r("closed")); });
      const connect = (target) => new Promise((r) => { const s = net.connect({ host: "${w.net.proxy}", port: 3128 }); s.on("connect", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n")); s.once("data", (d) => { r(String(d).split("\\r\\n")[0]); s.destroy(); }); s.on("error", () => r("error")); });
      (async () => {
        console.log("direct-public", await tcp("1.1.1.1", 443));
        console.log("direct-host", await tcp("${gateway}", ${String(port)}));
        console.log("proxy-host", await connect("host.docker.internal:443"));
        console.log("proxy-private", await connect("10.0.0.1:443"));
        console.log("proxy-port", await connect("registry.npmjs.org:80"));
        console.log("proxy-unlisted", await connect("example.com:443"));
      })();`;
    const r = spawnSync(ENGINE, ["run", "--rm", "--network", w.net.network, "--user", runnerUser(), "--cap-drop", "ALL", w.image, "node", "-e", probe], { encoding: "utf8", timeout: 60_000 });
    server.close();
    expect(r.stdout).toContain("direct-public closed");
    expect(r.stdout).toContain("direct-host closed");
    for (const k of ["proxy-host", "proxy-private", "proxy-port", "proxy-unlisted"]) expect(r.stdout).toContain(`${k} HTTP/1.1 403 Forbidden`);
  }, 120_000);

  it("loads nothing of the target's and no mod: no instruction file reaches the model, no planted mod runs", async () => {
    // A user's own plugin, and a mod "this session" wrote, planted after prepareSession checked the
    // config directory, where Claude Code 2.1.286 loads them on the host. Every case shares the
    // task's config directory, and a later session would refuse to start beside them: they go after.
    const planted = [join(configDir(), "skills"), join(configDir(), "dev-mods")];
    try {
      const r = await runCase(w, "instructions", {
        tweak: (p) => {
          const cfg = p.env.CLAUDE_CONFIG_DIR;
          plantMod(join(cfg, "skills/user-mod"), "user-mod", "SF-MOD-USER");
          plantMod(join(cfg, "dev-mods", MOD_SESSION, "dev-mod"), "dev-mod", "SF-MOD-DEV");
          own(cfg);
          p.options.sessionId = MOD_SESSION;
        },
      }, validator);
      expect(r.outcome.ok, r.outcome.errors.join("; ")).toBe(true);
      // No request, the session's own or a side call, carried the target's instruction files.
      const log = readFileSync(w.stubLog, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { seen?: string[] });
      expect(log.flatMap((e) => e.seen ?? []), `watched ${CANARIES.join(", ")}`).toEqual([]);
      // No planted mod ran: the probe command ran as it was, and every plugin is the release's or built in.
      const [, , probe] = results("instructions");
      expect(text(probe)).toContain("sf-mod-probe");
      expect(text(probe)).not.toContain("SF-MOD");
      const init = messages(r.transcript).find((m) => m.type === "system" && m.subtype === "init") as { plugins?: { name: string; path: string }[] } | undefined;
      for (const plugin of init?.plugins ?? []) expect([w.pluginDir, "builtin"], plugin.name).toContain(plugin.path);
      // The session can write into neither the release's plugin nor its own config directory.
      expect(existsSync(join(w.pluginDir, "hooks/sf-written"))).toBe(false);
      expect(existsSync(join(configDir(), "skills/sf-written"))).toBe(false);
    } finally {
      for (const p of planted) rmSync(p, { recursive: true, force: true });
    }
  }, 300_000);

  it("brokers the build's preflight to the host: a failure keeps the builder going, a pass lets it stop", async () => {
    const failed = await runCase(w, "broker-fail", { preflight: ["sh", "-c", "echo gates failed; exit 1"] }, validator);
    expect(failed.brokerRuns).toBe(1);
    // The block came back to the model as the reason to continue: it was asked for a second turn.
    expect(stubLog(w, "broker-fail").map((e) => e["index"])).toContain(1);
    const results1 = readdirSync(failed.prepared.broker?.spool.results ?? "");
    expect(results1).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(failed.prepared.broker?.spool.results ?? "", results1[0] ?? ""), "utf8"))).toMatchObject({ status: "fail", output: expect.stringContaining("gates failed") as unknown });

    const passed = await runCase(w, "broker-pass", { preflight: ["true"] }, validator);
    expect(passed.brokerRuns).toBe(1);
    expect(passed.outcome.ok).toBe(true);
    expect(stubLog(w, "broker-pass").map((e) => e["index"])).not.toContain(1);
  }, 300_000);

  it("reaches the model only through the gateway: the key never enters the runner, and a session stops at its hard cap", async () => {
    // The API the gateway calls with the key: a stub on the host, which the runner cannot reach itself.
    const keys: string[] = [];
    const calls: Record<string, unknown>[] = [];
    const stub = stubHandler(script, (e) => calls.push(e));
    const upstream = createHttpServer((req, res) => {
      keys.push(String(req.headers["x-api-key"]));
      stub(req, res);
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => upstream.once("listening", resolve));
    const keyFile = join(root, "anthropic.key");
    writeFileSync(keyFile, "sk-ant-conformance-key\n", { mode: 0o600 });
    const usage: UsageEntry[] = [];
    const address = gatewayAddress();
    const gw = await startGateway({ prices: release.config.prices, keyFile, upstream: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`, hosts: [address.bind], halted: () => null, onUsage: (e) => usage.push(e), log: () => undefined });
    const upstreamProxy = process.env["FACTORY_EGRESS_UPSTREAM"];
    // The proxy runs as the runner's user and writes its log here.
    const logDir = join(root, "egress-gateway");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    own(logDir);
    const net = ensureTaskNetwork({ taskId: GATEWAY_TASK, image: w.image, owner: self(), logDir, gateway: { host: address.reach, port: Number(new URL(gw.urls[0] ?? "").port) }, ...(upstreamProxy === undefined ? {} : { upstream: upstreamProxy }) });
    // $0.20 of hard budget: the first $0.15 turn fits, the second starts with $0.05 left and spends past it, the third is refused.
    const grant = gw.issue({ taskId: TASK, label: "gateway-cap", limitUsd: 0.2 });
    const token = writeTokenFile(join(root, "tokens"), grant.id, grant.token);
    try {
      const setup: RunnerSetup = { ...w.setup, network: net.network, proxyUrl: net.proxyUrl, tokenFile: token.path, baseUrl: net.gatewayUrl ?? "", noProxy: [net.proxy] };
      // A soft cap well above the hard one: the gateway, not the session's own estimate, stops it.
      const r = await runCase({ ...w, setup }, "gateway-cap", { budgetUsd: 10 }, validator);
      const seen = JSON.stringify({ outcome: { subtype: r.outcome.subtype, errors: r.outcome.errors }, calls: calls.map((c) => [c["route"], c["case"], c["index"], c["model"]]), usage: usage.map((u) => [u.label, u.model, u.usd]) });
      expect(gw.session(grant.id)?.refused, seen).toBe("budget");
      const turns = calls.filter((c) => c["case"] === "gateway-cap").map((c) => c["index"]);
      expect(turns).toEqual([0, 1]);
      expect(r.outcome.ok).toBe(false);
      const metered = usage.filter((u) => u.session === grant.id);
      expect(metered.reduce((a, u) => a + u.usd, 0)).toBeGreaterThanOrEqual(0.3);
      // Upstream saw the key and only the key; the runner held a token, and its env has no credential.
      expect(new Set(keys)).toEqual(new Set(["sk-ant-conformance-key"]));
      expect(r.prepared.env.ANTHROPIC_BASE_URL).toBe(net.gatewayUrl);
      expect(JSON.stringify(r.prepared.env)).not.toContain("sk-ant");
      expect(JSON.stringify(r.prepared.env)).not.toContain(grant.token);
      // The proxy logged the route's requests by path and status, never the token.
      const log = existsSync(net.log) ? readFileSync(net.log, "utf8") : "";
      expect(log).toMatch(/"route":"gateway".*"path":"\/v1\/messages","status":200/);
      expect(log).toMatch(/"route":"gateway".*"status":403/);
      expect(log).not.toContain(grant.token);
    } finally {
      token.remove();
      await gw.close();
      upstream.close();
      removeTaskNetwork(GATEWAY_TASK);
    }
  }, 300_000);

  it("sets a task up for live sessions: its own network, a proxy whose route reaches the gateway, nothing left after", async () => {
    const taskId = "T-9003";
    const home = factoryHome({ FACTORY_HOME: w.homeRoot });
    const keyFile = join(root, "anthropic-live.key");
    writeFileSync(keyFile, "sk-ant-conformance-key\n", { mode: 0o600 });
    const address = gatewayAddress();
    const gw = await startGateway({ prices: release.config.prices, keyFile, hosts: [address.bind], halted: () => null, onUsage: () => undefined, log: () => undefined });
    // The proxy runs as the runner's user and writes its log in the task's run directory.
    const egress = join(home.runs, taskId, "egress");
    mkdirSync(egress, { recursive: true, mode: 0o700 });
    own(join(home.runs, taskId));
    const tr = startTaskRunner({ home, releaseRoot: REPO_ROOT, taskId, gateway: { host: address.reach, port: Number(new URL(gw.urls[0] ?? "").port) } });
    try {
      const setup = tr.setup("/tmp/token");
      expect(setup).toMatchObject({ network: networkName(taskId), tokenFile: "/tmp/token", noProxy: [proxyName(taskId)] });
      // From the task's network, the gateway answers through the proxy's route (once the proxy listens).
      // The probe runs asynchronously: the gateway answers from this process's event loop.
      const fetchHello = `const go = (n) => fetch(${JSON.stringify(`${setup.baseUrl ?? ""}/api/hello`)}, { signal: AbortSignal.timeout(10000) }).then((r) => console.log("HELLO", r.status), (e) => (n > 0 ? new Promise((r) => setTimeout(r, 1000)).then(() => go(n - 1)) : console.log("FAILED", String(e)))); go(10);`;
      const probe = await new Promise<string>((resolve) => {
        const child = spawn(ENGINE, ["run", "--rm", "--network", setup.network, "--user", runnerUser(), setup.image, "node", "-e", fetchHello], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.once("close", () => {
          resolve(out);
        });
      });
      expect(probe).toContain("HELLO 200");
      expect(readFileSync(join(egress, "proxy.ndjson"), "utf8")).toMatch(/"route":"gateway".*"path":"\/api\/hello","status":200/);
    } finally {
      tr.stop();
      await gw.close();
    }
    expect(spawnSync(ENGINE, ["network", "inspect", networkName(taskId)], { stdio: "ignore" }).status).not.toBe(0);
  }, 300_000);

  it("leaves no runner container behind a killed run once reaping runs", async () => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(REPO_ROOT, "controller/src/runner/suite.ts"), join(root, "world.json"), "sleep"], { stdio: "ignore" });
    const mine = (): string[] => listContainers().filter((c) => c.task === TASK && c.owner?.pid === child.pid).map((c) => c.name);
    const deadline = Date.now() + 120_000;
    while (mine().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
    const orphan = mine();
    expect(orphan).toHaveLength(1);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    // The docker client died with its run; the container did not.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(listContainers().map((c) => c.name)).toContain(orphan[0]);
    expect(reapRunnerContainers()).toContain(orphan[0]);
    expect(listContainers().map((c) => c.name)).not.toContain(orphan[0]);
  }, 300_000);
});
