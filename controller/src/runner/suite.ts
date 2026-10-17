// The runner conformance suite's world (P2-01): a target worktree that borrows its objects from a
// mirror, the runner image, a task network with its egress proxy, the stub model on that
// network, and a helper that runs one scripted session through the real SDK, prepareSession and
// containerSpawner. Shared by conformance.runner.test.ts and by the child process the reaping
// test kills (run with `node suite.ts <world.json> <case> <task>`).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "../../../gates/src/container.ts";
import { ensureHome, factoryHome, type Home } from "../home.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { self } from "../proc.ts";
import { loadRelease, type Release } from "../release.ts";
import { createValidator, type Validator } from "../schemas/validate.ts";
import { prepareSession, type PreparedSession, type StageSpec } from "../session/options.ts";
import { sdkRunner, type StageOutcome } from "../session/runner.ts";
import type { Script } from "../session/stub-model.ts";
import { runPreflight, startBroker } from "./broker.ts";
import { engineHasAppArmor, seccompPath, type RunnerSetup } from "./container.ts";
import { ensureRunnerImage } from "./image.ts";
import { ensureTaskNetwork, removeTaskNetwork, type TaskNetwork } from "./network.ts";

export const STUB_PORT = 8080;

export interface World {
  root: string;
  taskId: string;
  homeRoot: string;
  worktree: string;
  mirror: string;
  taskDir: string;
  pluginDir: string;
  image: string;
  net: TaskNetwork;
  stub: string;
  stubLog: string;
  setup: RunnerSetup;
}

const run = (cmd: string, args: string[], cwd?: string): string => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

/** A root factoryctl runs its runner as 10001 (runnerUser); the world's files must be that user's then. */
export function own(path: string): void {
  if (process.getuid?.() === 0) run("chown", ["-R", "10001:10001", path]);
}

export function buildWorld(root: string, taskId: string, script: Script): World {
  const homeRoot = join(root, "home");
  const home = factoryHome({ FACTORY_HOME: homeRoot });
  ensureHome(home);
  // The target: a mirror and a worktree cloned --shared from it, as the pipeline makes them.
  const seed = join(root, "seed");
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src/app.ts"), "export const app = 1;\n");
  // A project setting that must change nothing: settingSources is empty and hooks are managed-only.
  mkdirSync(join(seed, ".claude"), { recursive: true });
  writeFileSync(join(seed, ".claude/settings.json"), `${JSON.stringify({ disableAllHooks: true, permissions: { allow: ["WebFetch"] } })}\n`);
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "seed"]]) run("git", a, seed);
  const mirror = join(home.mirrors, "o__target.git");
  run("git", ["clone", "-q", "--bare", seed, mirror]);
  const worktree = join(home.worktrees, taskId);
  run("git", ["clone", "-q", "--shared", mirror, worktree]);
  const taskDir = join(home.runs, taskId, "work", "build");
  mkdirSync(taskDir, { recursive: true });
  // The release's plugin, with one extra plugin hook that must never run in the runner.
  const pluginDir = join(root, "plugin");
  cpSync(join(REPO_ROOT, "plugin"), pluginDir, { recursive: true });
  const hooksFile = join(pluginDir, "hooks/hooks.json");
  const hooks = JSON.parse(readFileSync(hooksFile, "utf8")) as { hooks: Record<string, { matcher?: string; hooks: unknown[] }[]> };
  hooks.hooks["PreToolUse"]?.[0]?.hooks.push({ type: "command", command: `touch '${join(taskDir, "plugin-hook-ran")}'`, timeout: 5 });
  writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);

  const image = ensureRunnerImage(REPO_ROOT);
  const egressLogs = join(home.runs, taskId, "egress");
  mkdirSync(egressLogs, { recursive: true });
  const stubDir = join(root, "stub");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "script.json"), JSON.stringify(script));
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, "stub-key\n", { mode: 0o644 });
  own(root);
  // Locally, the proxy may need the host's upstream proxy; CI reaches the internet directly.
  const upstream = process.env["FACTORY_EGRESS_UPSTREAM"];
  const net = ensureTaskNetwork({ taskId, image, owner: self(), logDir: egressLogs, ...(upstream === undefined ? {} : { upstream }) });
  const stub = `sf-stub-${taskId.toLowerCase()}`;
  spawnSync(ENGINE, ["rm", "--force", stub], { stdio: "ignore" });
  run(ENGINE, [
    "run", "--detach", "--name", stub, "--network", net.network, "--user", process.getuid?.() === 0 ? "10001:10001" : `${String(process.getuid?.())}:${String(process.getgid?.())}`,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--mount", `type=bind,src=${join(REPO_ROOT, "controller/src/session/stub-model.ts")},dst=/opt/stub/stub-model.ts,readonly`,
    "--mount", `type=bind,src=${stubDir},dst=/opt/stub/run`,
    "--env", "STUB_SCRIPT=/opt/stub/run/script.json", "--env", "STUB_LOG=/opt/stub/run/log.ndjson", "--env", `STUB_PORT=${String(STUB_PORT)}`,
    image, "node", "/opt/stub/stub-model.ts",
  ]);
  const setup: RunnerSetup = {
    image,
    network: net.network,
    proxyUrl: net.proxyUrl,
    seccomp: seccompPath(REPO_ROOT),
    tokenFile,
    baseUrl: `http://${stub}:${String(STUB_PORT)}`,
    noProxy: [stub],
    apparmorUnconfined: engineHasAppArmor(),
  };
  return { root, taskId, homeRoot, worktree, mirror, taskDir, pluginDir, image, net, stub, stubLog: join(stubDir, "log.ndjson"), setup };
}

export function destroyWorld(w: World): void {
  spawnSync(ENGINE, ["rm", "--force", w.stub], { stdio: "ignore" });
  removeTaskNetwork(w.taskId);
}

export function stubLog(w: World, name: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(w.stubLog, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e["case"] === name);
}

export interface CaseOptions {
  protected?: string[];
  /** The host command the broker runs when the session's Stop hook asks; default: a pass. */
  preflight?: string[];
  /** Changes the prepared options (e.g. drop the in-process guard to test the managed layer alone). */
  tweak?: (p: PreparedSession) => void;
}

export interface CaseResult {
  outcome: StageOutcome;
  prepared: PreparedSession;
  transcript: string;
  brokerRuns: number;
}

export async function runCase(w: World, name: string, o: CaseOptions = {}, validator: Validator = createValidator()): Promise<CaseResult> {
  const home: Home = factoryHome({ FACTORY_HOME: w.homeRoot });
  const base = loadRelease(validator);
  const release: Release = { ...base, pluginDir: w.pluginDir };
  const spec: StageSpec = {
    stage: "build", agent: "builder", label: name, cwd: w.worktree,
    prompt: `[case:${name}] Run the scripted case.`,
    extraDirs: [w.taskDir],
    guard: { worktree: w.worktree, task_dir: w.taskDir, protected_paths: o.protected ?? [], scope: null, writable_task_files: ["build-report.md"], secret_paths: [], readable_roots: [] },
    budgetUsd: 1,
    preflight: { argv: o.preflight ?? ["true"], timeout_ms: 60_000 },
  };
  const prepared = prepareSession({ home, taskId: w.taskId, release, validator, keyFile: join(w.root, "no-such-key"), runner: w.setup }, spec);
  own(join(home.sessions, w.taskId));
  o.tweak?.(prepared);
  let brokerRuns = 0;
  const b = prepared.broker;
  const broker = b === undefined ? undefined : startBroker(b.spool, async () => {
    brokerRuns++;
    return await runPreflight(b.argv, b.cwd, b.timeout_ms);
  });
  const transcript = join(home.runs, w.taskId, "transcripts", `${name}.ndjson`);
  try {
    const outcome = await sdkRunner.run({ label: name, prompt: spec.prompt, options: prepared.options, transcript, denials: prepared.denials });
    return { outcome, prepared, transcript, brokerRuns };
  } finally {
    await broker?.stop();
  }
}

// The reaping test's child: runs one case and is SIGKILLed while its runner container lives.
if (import.meta.main) {
  const [worldFile = "", name = ""] = process.argv.slice(2);
  const w = JSON.parse(readFileSync(worldFile, "utf8")) as World;
  await runCase(w, name);
}
