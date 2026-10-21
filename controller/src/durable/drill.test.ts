// The restore and kill-switch drills (ROADMAP P2-07, "done when: the restore and kill-switch
// drills pass"; G2-6 runs them on the frozen system). The real CLI runs as separate processes
// with replayed sessions, a local remote and a stub GitHub API, as in the kill-point suite.
//
// - Restore: a run is SIGKILLed after its build. `drill restore` restores the replica into a
//   scratch home within RPO and RTO. Then the whole home is lost, `restore` rebuilds it from the
//   replica, and `resume` rebuilds the task's clone from the target and its committed candidate
//   bundle and finishes at the merge gate: the build is not run again, and there is one push
//   and one PR.
// - Kill switch: three tasks run under serve; `drill kill-switch` halts the factory and every
//   worker, session and container is gone well within 5 minutes.
// - Serve kill (G2-3): three tasks run under serve; `drill serve-kill` SIGKILLs serve alone and
//   records the three, whose workers run on.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { CLI, seedTarget, writeTranscripts } from "../cli/testing.ts";
import { danglingIntents } from "../github/outbox.ts";
import { memoryGitHub, serveGitHub, type MemoryGitHub } from "../github/testing.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { isLive } from "../proc.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import { currentState, currentStatePayload } from "../task/lifecycle.ts";

const scratch = mkdtempSync(join(tmpdir(), "drills-"));
const remotes = new Map<string, string>();
const gh: MemoryGitHub = memoryGitHub((repo, branch) => spawnSync("git", ["-C", remotes.get(repo) ?? "", "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim());
let api = { url: "", close: () => Promise.resolve() };
const spawned: ChildProcess[] = [];
beforeAll(async () => {
  api = await serveGitHub(gh);
});
afterAll(async () => {
  for (const c of spawned) if (c.exitCode === null) c.kill("SIGKILL");
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface World {
  root: string;
  home: string;
  replay: string;
  pushLogs: string[];
}

const env = (w: World): NodeJS.ProcessEnv => ({ PATH: process.env["PATH"] ?? "", HOME: w.root, FACTORY_HOME: w.home, FACTORY_GITHUB_TOKEN: "test-token", FACTORY_GITHUB_API_URL: api.url });

function cli(w: World, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: env(w), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** A home with `tasks` replayed tasks, each on its own target. */
async function world(name: string, tasks: number): Promise<World> {
  const root = mkdtempSync(join(scratch, `${name}-`));
  const w: World = { root, home: join(root, "factory"), replay: join(root, "replay"), pushLogs: [] };
  for (let i = 1; i <= tasks; i++) {
    const t = join(root, `target-${String(i)}`);
    spawnSync("mkdir", ["-p", t]);
    const { remote, pushLog } = seedTarget(t);
    const repo = `example/${name}-${String(i)}`;
    remotes.set(repo, remote);
    w.pushLogs.push(pushLog);
    const profile = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
    profile["target"] = { repo, default_branch: "main", visibility: "private" };
    writeFileSync(join(t, "profile.yaml"), stringify(profile));
    writeFileSync(join(t, "task.md"), "Add an isEmpty helper for carts, with a test.\n");
    const created = await cli(w, ["task", "create", "--profile", join(t, "profile.yaml"), "--title", "Add isEmpty", "--body-file", join(t, "task.md"), "--untrusted", "--remote", remote]);
    const id = created.stdout.trim();
    expect(id, created.stderr).toMatch(/^T-\d{4}$/);
    writeTranscripts(join(w.replay, id), w.home, id, "clean");
  }
  return w;
}

function events(w: World, task: string): FactoryEvent[] {
  const store = EventStore.open(join(w.home, "factory.db"));
  try {
    return store.events(task);
  } finally {
    store.close();
  }
}

async function until(what: string, ok: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("the drills (P2-07)", () => {
  it("restores within RPO and RTO, and a task survives the loss of its whole home", async () => {
    const w = await world("restore", 1);
    const task = "T-0001";
    const replica = join(w.root, "replica");
    const init = await cli(w, ["replica", "init", replica]);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain("same volume");

    // A run killed after its build committed: the candidate was never pushed.
    writeFileSync(join(w.replay, task, "replay.json"), JSON.stringify({ gates: {}, kill_at: "gates:running" }));
    const killed = await cli(w, ["run", task, "--replay", join(w.replay, task)]);
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const before = events(w, task);
    const build = before.findLast((e) => e.type === "artifact_committed" && e.payload["label"] === "build");
    expect(build?.payload["artifacts"]).toEqual(expect.arrayContaining([expect.objectContaining({ path: "candidate.bundle" })]));
    const candidate = (JSON.parse(readFileSync(join(w.home, "runs", task, "build.json"), "utf8")) as { candidate_commit: string }).candidate_commit;

    // The drill restores the replica as it stands, without touching the live home.
    const drill = await cli(w, ["drill", "restore"]);
    expect(drill.code, drill.stdout + drill.stderr).toBe(0);
    expect(drill.stdout).toMatch(/^PASS {2}restored 1 task\(s\)/m);
    const records = readdirSync(join(w.home, "drills")).filter((f) => f.startsWith("restore-"));
    expect(records).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(w.home, "drills", records[0] ?? ""), "utf8")) as { passed: boolean; rpo_ms: number; rto_ms: number; damaged: string[] };
    expect(record).toMatchObject({ passed: true, damaged: [] });
    expect(record.rpo_ms).toBeLessThanOrEqual(60_000);
    expect(record.rto_ms).toBeLessThanOrEqual(3_600_000);

    // The disk is lost: the store, the run directories, the mirrors and the clone.
    const synced = await cli(w, ["replica", "sync"]);
    expect(synced.stdout).toContain("0 event(s) behind");
    rmSync(w.home, { recursive: true, force: true });
    const restored = await cli(w, ["restore", "--source", replica]);
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    expect(events(w, task)).toEqual(before);

    writeFileSync(join(w.replay, task, "replay.json"), JSON.stringify({ gates: {} }));
    const resumed = await cli(w, ["resume", task, "--replay", join(w.replay, task)]);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.stderr).toContain(`rebuilt its clone from example/restore-1 and its candidate ${candidate.slice(0, 12)}`);
    const after = events(w, task);
    expect(currentState(after)).toBe("NEEDS_HUMAN");
    expect(currentStatePayload(after)["gate"]).toBe("merge");
    // The build was not run again; one branch update and one PR, with the candidate from the bundle.
    expect(after.filter((e) => e.type === "artifact_committed" && e.payload["label"] === "build")).toHaveLength(1);
    const pushes = readFileSync(w.pushLogs[0] ?? "", "utf8").trim().split("\n").filter((l) => l.startsWith(`refs/heads/factory/${task} `));
    expect(pushes).toEqual([`refs/heads/factory/${task} ${candidate}`]);
    expect(gh.prs.filter((p) => p.head === `factory/${task}` && p.repo === "example/restore-1")).toHaveLength(1);
    expect(danglingIntents(after)).toEqual([]);
  }, 180_000);

  it("stops every serve worker and session well within 5 minutes", async () => {
    const w = await world("kill", 3);
    for (const t of ["T-0001", "T-0002", "T-0003"]) writeFileSync(join(w.replay, t, "replay.json"), JSON.stringify({ gates: {}, hold_at: "build:run" }));
    const s = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    const serve = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "serve", "--replay", w.replay, "--port", String(port), "--max-tasks", "3"], { env: env(w), stdio: "ignore" });
    spawned.push(serve);
    const held = (t: string): number | null => (existsSync(join(w.replay, t, "held")) ? Number(readFileSync(join(w.replay, t, "held"), "utf8")) : null);
    await until("three workers to park in their builds", () => ["T-0001", "T-0002", "T-0003"].every((t) => held(t) !== null));
    const workers = ["T-0001", "T-0002", "T-0003"].map((t) => held(t) ?? 0);

    const drill = await cli(w, ["drill", "kill-switch"]);
    expect(drill.code, drill.stdout + drill.stderr).toBe(0);
    expect(drill.stdout).toMatch(/^PASS {2}all agent activity stopped in [0-9.]+ s/m);
    expect(drill.stdout).toMatch(/before: 3 writer\(s\)/);
    for (const pid of workers) expect(isLive({ pid, start_time: null }), String(pid)).toBe(false);
    const record = readdirSync(join(w.home, "drills")).find((f) => f.startsWith("kill-switch-")) ?? "";
    const r = JSON.parse(readFileSync(join(w.home, "drills", record), "utf8")) as { passed: boolean; stopped_ms: number; after: Record<string, number> };
    expect(r.passed).toBe(true);
    expect(r.stopped_ms).toBeLessThan(60_000);
    expect(r.after).toEqual({ writers: 0, sessions: 0, runners: 0, gates: 0 });
    // The tasks stopped without failing, and the factory stays halted until the operator lifts it.
    for (const t of ["T-0001", "T-0002", "T-0003"]) expect(currentState(events(w, t))).not.toBe("FAILED");
    expect(existsSync(join(w.home, "HALT"))).toBe(true);
    serve.kill("SIGTERM");
  }, 180_000);

  it("SIGKILLs serve alone while it runs three tasks, and records them", async () => {
    const w = await world("serve-kill", 3);
    const none = await cli(w, ["drill", "serve-kill"]);
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain("serve is not running");
    for (const t of ["T-0001", "T-0002", "T-0003"]) writeFileSync(join(w.replay, t, "replay.json"), JSON.stringify({ gates: {}, hold_at: "build:run" }));
    const s = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    const serve = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "serve", "--replay", w.replay, "--port", String(port), "--max-tasks", "3"], { env: env(w), stdio: "ignore" });
    spawned.push(serve);
    const held = (t: string): number | null => (existsSync(join(w.replay, t, "held")) ? Number(readFileSync(join(w.replay, t, "held"), "utf8")) : null);
    await until("three workers to park in their builds", () => ["T-0001", "T-0002", "T-0003"].every((t) => held(t) !== null));
    const workers = ["T-0001", "T-0002", "T-0003"].map((t) => held(t) ?? 0);

    const drill = await cli(w, ["drill", "serve-kill"]);
    expect(drill.code, drill.stdout + drill.stderr).toBe(0);
    expect(drill.stdout).toContain(`killed serve (pid ${String(serve.pid)}) while it ran T-0001, T-0002, T-0003`);
    await until("serve to die", () => serve.exitCode !== null || serve.signalCode !== null);
    expect(serve.signalCode).toBe("SIGKILL");
    // Its workers run on under their leases.
    for (const pid of workers) expect(isLive({ pid, start_time: null }), String(pid)).toBe(true);
    const record = readdirSync(join(w.home, "drills")).find((f) => f.startsWith("serve-kill-")) ?? "";
    const r = JSON.parse(readFileSync(join(w.home, "drills", record), "utf8")) as { killed: boolean; tasks: { task: string; epoch: number }[] };
    expect(r.killed).toBe(true);
    expect(r.tasks.map((t) => t.task)).toEqual(["T-0001", "T-0002", "T-0003"]);
    for (const pid of workers) process.kill(pid, "SIGKILL");
  }, 180_000);
});
