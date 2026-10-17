// `factoryctl serve` end to end (ROADMAP P2-03; G2-3 drills the same on the frozen system):
// three tasks run at once under serve, each held mid-build; serve is SIGKILLed and so is one of
// its workers; a new serve leaves the live workers to finish under their leases, takes the dead
// worker's task over at a new epoch and finishes it. Every task then has one branch update and
// one PR, no step committed twice, and no write from a stale epoch on the record. While serve
// runs, the CLI is its client and nothing else drives a task; without replayed sessions serve
// refuses to start (live sessions wait for the gateway, P2-02).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { danglingIntents } from "../github/outbox.ts";
import { memoryGitHub, serveGitHub, type MemoryGitHub } from "../github/testing.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { isLive } from "../proc.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import { currentState, currentStatePayload } from "../task/lifecycle.ts";
import { CLI, git, seedTarget, writeTranscripts } from "../cli/testing.ts";
import { spawnSync } from "node:child_process";

const TASKS = ["T-0001", "T-0002", "T-0003"];
const scratch = mkdtempSync(join(tmpdir(), "serve-"));
const remotes = new Map<string, string>();
const gh: MemoryGitHub = memoryGitHub((repo, branch) => spawnSync("git", ["-C", remotes.get(repo) ?? "", "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim());
let api = { url: "", close: () => Promise.resolve() };
const home = join(scratch, "factory");
const replay = join(scratch, "replay");
const pushLogs = new Map<string, string>();
const spawned: ChildProcess[] = [];

beforeAll(async () => {
  api = await serveGitHub(gh);
  for (const [i, task] of TASKS.entries()) {
    const root = join(scratch, `target-${String(i + 1)}`);
    mkdirSync(root);
    const { remote, pushLog } = seedTarget(root);
    const repo = `example/target-${String(i + 1)}`;
    remotes.set(repo, remote);
    pushLogs.set(task, pushLog);
    const profile = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
    profile["target"] = { repo, default_branch: "main", visibility: "private" };
    writeFileSync(join(root, "profile.yaml"), stringify(profile));
    writeFileSync(join(root, "task.md"), "Add an isEmpty helper for carts, with a test.\n");
    const created = await cli(["task", "create", "--profile", join(root, "profile.yaml"), "--title", "Add isEmpty", "--body-file", join(root, "task.md"), "--untrusted", "--remote", remote]);
    expect(created.stdout.trim()).toBe(task);
    writeTranscripts(join(replay, task), home, task, "clean");
    // Every task parks in its build until the test lets it go.
    writeFileSync(join(replay, task, "replay.json"), JSON.stringify({ gates: {}, hold_at: "build:run" }));
  }
}, 120_000);

afterAll(async () => {
  for (const c of spawned) if (c.exitCode === null) c.kill("SIGKILL");
  for (const t of TASKS) writeFileSync(join(replay, t, "go"), "");
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ PATH: process.env["PATH"] ?? "", HOME: scratch, FACTORY_HOME: home, FACTORY_GITHUB_TOKEN: "test-token", FACTORY_GITHUB_API_URL: api.url });

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function freePort(): Promise<number> {
  const s = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

function startServe(port: number): ChildProcess {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "serve", "--replay", replay, "--port", String(port), "--max-tasks", "3"], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
  spawned.push(child);
  return child;
}

function read<T>(fn: (s: EventStore) => T): T {
  const s = EventStore.open(join(home, "factory.db"));
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

async function until(what: string, ok: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const held = (task: string): number | null => (existsSync(join(replay, task, "held")) ? Number(readFileSync(join(replay, task, "held"), "utf8")) : null);
const events = (task: string): FactoryEvent[] => read((s) => s.events(task));

describe("factoryctl serve (P2-03)", () => {
  it("refuses live sessions until the gateway exists", async () => {
    const r = await cli(["serve"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("credential gateway (P2-02)");
  });

  it("runs three tasks at once, survives a SIGKILL of serve and of a worker, and duplicates nothing", async () => {
    const port = await freePort();
    const first = startServe(port);
    await until("all three tasks to park in their builds", () => TASKS.every((t) => held(t) !== null));
    const workers = Object.fromEntries(TASKS.map((t) => [t, held(t) ?? 0]));
    expect(new Set(Object.values(workers)).size).toBe(3);

    // While serve runs it is the single writer: the CLI goes through it, and nothing else drives a task.
    const status = await cli(["status"]);
    expect(status.stdout).toContain("serve running");
    expect(status.stdout.match(/\(running\)/g)).toHaveLength(3);
    const run = await cli(["run", "T-0001"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("serve is running");

    // Kill serve, then one worker: the others keep running under their leases.
    first.kill("SIGKILL");
    await until("serve to die", () => first.exitCode !== null || first.signalCode !== null);
    process.kill(workers["T-0002"] ?? 0, "SIGKILL");
    await until("the worker to die", () => !isLive({ pid: workers["T-0002"] ?? 0, start_time: null }));
    expect(isLive({ pid: workers["T-0001"] ?? 0, start_time: null })).toBe(true);
    rmSync(join(replay, "T-0002", "held"));

    // A new serve takes the dead worker's task over at a new epoch, and leaves the live ones alone.
    const second = startServe(port);
    await until("T-0002 to run again under a new lease", () => held("T-0002") !== null && held("T-0002") !== workers["T-0002"]);
    expect(read((s) => s.lease("T-0002")?.epoch)).toBe(2);
    expect(read((s) => [s.lease("T-0001")?.epoch, s.lease("T-0003")?.epoch])).toEqual([1, 1]);

    for (const t of TASKS) writeFileSync(join(replay, t, "go"), "");
    await until("every task to reach its merge gate", () => TASKS.every((t) => {
      const e = events(t);
      return currentState(e) === "NEEDS_HUMAN" && currentStatePayload(e)["gate"] === "merge";
    }), 90_000);

    // Drain: serve stops once its workers end.
    await until("every lease to be released", () => read((s) => s.leases().every((l) => l.expires_at === 0 || !isLive({ pid: Number(l.holder.split("@")[0]), start_time: null }))), 30_000);
    const drained = await cli(["drain"]);
    expect(drained.code, drained.stderr).toBe(0);
    await until("serve to drain", () => second.exitCode !== null, 30_000);

    for (const t of TASKS) {
      const all = events(t);
      const branch = `factory/${t}`;
      // One branch update and one PR per task, each step committed once.
      expect(readFileSync(pushLogs.get(t) ?? "", "utf8").trim().split("\n").filter((l) => l.startsWith(`refs/heads/${branch} `))).toHaveLength(1);
      expect(gh.prs.filter((p) => p.head === branch)).toHaveLength(1);
      const labels = all.filter((e) => e.type === "artifact_committed").map((e) => String(e.payload["label"]));
      expect(new Set(labels).size, `${t}: ${labels.join(",")}`).toBe(labels.length);
      expect(danglingIntents(all)).toEqual([]);
      // Every factoryctl write carries the epoch its lease had when it was written.
      let epoch = 0;
      for (const e of all) {
        if (e.type === "command" && e.payload["command"] === "lease_acquired") epoch = Number(e.payload["epoch"]);
        if (e.actor.kind === "factoryctl") expect(e.epoch, `${t} ${e.type} seq ${String(e.seq)}`).toBe(epoch);
      }
    }
    // The re-leased task recorded who it took over from.
    const takeover = events("T-0002").filter((e) => e.payload["command"] === "lease_acquired").at(1);
    expect(takeover?.payload).toMatchObject({ epoch: 2, from: { epoch: 1 } });
    expect(git(remotes.get("example/target-2") ?? "", ["rev-parse", "--verify", "-q", "refs/heads/factory/T-0002"])).toMatch(/^[0-9a-f]{40}$/);
  }, 240_000);
});
