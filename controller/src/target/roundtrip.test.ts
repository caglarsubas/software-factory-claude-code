// P2-11's done-when: a fixture onboard and offboard round trip (ADR 0003). The real factoryctl
// takes ts-mini from nothing to an active target, runs a task on it beside another target's
// task that shares an object with it, then offboards it: the App, the rulesets, the PR that puts
// the target's files back as they were, and the purge. Nothing of the target is left in the
// home or the replica; the other target's task, and the object they shared, are intact; a
// restore brings nothing purged back. It runs offline, against a stub GitHub, a bare remote, a
// container engine that only logs, and replayed sessions and gates.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { CLI, git, seedTarget, writeTranscripts } from "../cli/testing.ts";
import { hasObject } from "../durable/objects.ts";
import { memoryGitHub, serveGitHub, type MemoryGitHub, type StubApp } from "../github/testing.ts";
import { factoryHome } from "../home.ts";
import { otelDir } from "../otel/collector.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { EventStore } from "../store/events.ts";
import { currentState } from "../task/lifecycle.ts";
import { factorySource, targetRemote } from "./testing.ts";

const scratch = mkdtempSync(join(tmpdir(), "roundtrip-"));
const validator = createValidator();
const TAG = "v0.22.0";
const REPO = "example/ts-mini";
const remotes = new Map<string, string>();
const gh: MemoryGitHub = memoryGitHub((repo, branch) => spawnSync("git", ["-C", remotes.get(repo) ?? "", "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim());
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyFile = join(scratch, "github-app.pem");
writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
const app: StubApp = { id: 4242, installationId: 77, publicKey: keys.publicKey, permissions: { checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write" }, minted: [], calls: [], repositories: new Set(["other"]) };
let api = { url: "", close: () => Promise.resolve() };
beforeAll(async () => {
  api = await serveGitHub(gh, app);
});
afterAll(async () => {
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const resource = (task: string) => ({ resource: { attributes: [{ key: "factory.task_id", value: { stringValue: task } }] }, scopeLogs: [] });

describe("the onboard and offboard round trip (P2-11's done-when)", () => {
  it("leaves nothing of the target behind, and everything of the other", async () => {
    // --- the world ---------------------------------------------------------------------------
    const { remote } = targetRemote(scratch, validator);
    remotes.set(REPO, remote);
    const baseTree = git(remote, ["rev-parse", "main^{tree}"]);
    const claudeMd = git(remote, ["show", "main:CLAUDE.md"]);
    gh.repos.set(REPO, { defaultBranch: "main", private: false, protected: true });

    // Another target, with a task that is never run.
    mkdirSync(join(scratch, "other-root"), { recursive: true });
    const other = seedTarget(join(scratch, "other-root"));
    const otherProfile = join(scratch, "other.yaml");
    const template = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
    writeFileSync(otherProfile, stringify({ ...template, target: { repo: "example/other", default_branch: "main", visibility: "private" } }));

    // A factory checkout with the release's tag, and a container engine that logs what it is asked.
    const { dir: source } = factorySource(join(scratch, "factory-src"), TAG);
    const engineLog = join(scratch, "engine.log");
    const engine = join(scratch, "engine");
    writeFileSync(engine, `#!/bin/sh\necho "$@" >> '${engineLog}'\nexit 0\n`);
    chmodSync(engine, 0o755);

    const home = factoryHome({ FACTORY_HOME: join(scratch, "home") });
    const replica = join(scratch, "replica");
    const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      PATH: process.env["PATH"] ?? "", HOME: scratch, USER: "op", FACTORY_HOME: home.root, FACTORY_GITHUB_TOKEN: "op-token", FACTORY_GITHUB_API_URL: api.url,
      FACTORY_GITHUB_APP_ID: String(app.id), FACTORY_GITHUB_APP_INSTALLATION_ID: String(app.installationId), FACTORY_GITHUB_APP_KEY_FILE: keyFile,
      FACTORY_CONTAINER_ENGINE: engine, ...extra,
    });
    const factoryctl = (args: string[], extra?: NodeJS.ProcessEnv): Promise<Run> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    });
    const ok = async (args: string[], extra?: NodeJS.ProcessEnv): Promise<string> => {
      const r = await factoryctl(args, extra);
      expect(r.code, `factoryctl ${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(0);
      return r.stdout;
    };
    const replayDir = (name: string, injection: Record<string, unknown>): string => {
      const dir = join(scratch, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "replay.json"), JSON.stringify(injection));
      return dir;
    };
    const merge = (number: number, gates: boolean): void => {
      const pr = gh.prs.find((p) => p.repo === REPO && p.number === number);
      if (pr === undefined) throw new Error(`no PR ${String(number)}`);
      const head = git(remote, ["rev-parse", `refs/heads/${pr.head}`]);
      git(remote, ["update-ref", "refs/heads/main", head]);
      Object.assign(pr, { state: "closed", merged: true, headSha: head });
      if (gates) gh.actionsRuns.push({ repo: REPO, sha: head, name: "gates", status: "completed", conclusion: "success" });
    };
    const writes = (): string[] => gh.writes.filter((x) => x.includes(` ${REPO} `) || x.endsWith(` ${REPO}`));

    await ok(["replica", "init", replica]);

    // --- onboard -----------------------------------------------------------------------------
    const ref = ["--factory-ref", TAG, "--source", source];
    expect(await ok(["onboard", REPO, "--remote", remote, ...ref, "--replay", replayDir("admission", { gates: {} })])).toContain("STOP: review");
    expect((await factoryctl(["onboard", REPO, "--confirm", ...ref], { CLAUDECODE: "1" })).code).toBe(2);
    expect(await ok(["onboard", REPO, "--confirm", ...ref])).toContain("opened https://github.com/example/ts-mini/pull/1");
    expect(await ok(["onboard", REPO])).toContain("waiting for");
    expect(writes()).toEqual([`pull_request ${REPO} software-factory/onboard`]);
    merge(1, true);
    expect((await factoryctl(["onboard", REPO])).stdout).toContain("Add it: https://github.com/settings/installations/77");
    app.repositories?.add("ts-mini");
    expect(await ok(["onboard", REPO])).toContain(`${REPO} is active`);
    expect(gh.rulesets.get(REPO)?.map((r) => r.name)).toEqual(["factory-main", "factory-branches"]);
    expect(git(remote, ["show", "main:CLAUDE.md"])).not.toBe(claudeMd);

    // --- work on both targets, sharing an object ---------------------------------------------
    const shared = join(scratch, "shared.md");
    writeFileSync(shared, "Do the shared thing, the same in both repositories.\n");
    expect((await ok(["task", "create", "--profile", otherProfile, "--title", "Document the other repository", "--body-file", shared, "--remote", other.remote])).trim()).toBe("T-0001");
    expect((await ok(["task", "create", "--repo", REPO, "--title", "Add an emptiness check for carts", "--body-file", shared])).trim()).toBe("T-0002");
    const replay = replayDir("run", { gates: {} });
    writeTranscripts(replay, home.root, "T-0002", "clean");
    const ran = await factoryctl(["run", "T-0002", "--replay", replay]);
    expect(ran.stdout, ran.stderr).toMatch(/AUTO_APPROVED|NEEDS_HUMAN/);
    await ok(["reject", "T-0002", "--reason", "not wanted after all"]);
    await ok(["eval", "capture", "T-0002"]);
    mkdirSync(otelDir(home.root), { recursive: true });
    writeFileSync(join(otelDir(home.root), "2026-10-22.ndjson"), ["T-0001", "T-0002"].map((t) => JSON.stringify({ received_at: "x", signal: "logs", body: { resourceLogs: [resource(t)] } })).join("\n") + "\n");
    await ok(["budgets"]);
    await ok(["replica", "sync"]);
    // Rejected, so it has ended; and the two tasks' task.md is one object.
    const sharedDigest = ((): string => {
      const s = EventStore.open(home.db);
      try {
        expect(currentState(s.events("T-0002"))).toBe("FAILED");
        const files = (id: string) => (s.events(id).find((e) => e.type === "task_created")?.payload["files"] ?? {}) as Record<string, string>;
        expect(files("T-0002")["task.md"]).toBe(files("T-0001")["task.md"]);
        return files("T-0001")["task.md"] ?? "";
      } finally {
        s.close();
      }
    })();
    expect(readdirSafe(join(home.root, "evals", "captured")).some((f) => f.startsWith("T-0002-"))).toBe(true);
    expect(readFileSync(join(home.root, "budgets", "calibration.json"), "utf8")).toContain(REPO);

    // The control for the scans below: before offboarding, both stores hold the target's names and its task's title.
    const needles = [REPO, "example__ts-mini", "Add an emptiness check for carts"];
    for (const dir of [home.root, replica]) expect(grepTree(dir, needles).length, dir).toBeGreaterThan(0);
    expect(grepTree(home.root, ["Add an emptiness check for carts"]).length).toBeGreaterThan(0);

    // --- offboard ----------------------------------------------------------------------------
    // The App still reaches the target: the operator's step first. The target takes no new task from here.
    const first = await factoryctl(["offboard", REPO]);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("Remove it: https://github.com/settings/installations/77");
    expect((await factoryctl(["task", "create", "--repo", REPO, "--title", "x", "--body-file", shared])).stderr).toContain("is offboarding, not active");
    app.repositories?.delete("ts-mini");
    const proposed = await ok(["offboard", REPO]);
    expect(proposed).toContain("removed ruleset factory-main");
    expect(proposed).toContain("opened https://github.com/example/ts-mini/pull/");
    expect(gh.rulesets.get(REPO)).toEqual([]);
    expect(await ok(["offboard", REPO])).toContain("waiting for");
    const offboarding = gh.prs.find((p) => p.repo === REPO && p.head === "software-factory/offboard");
    expect(offboarding).toBeDefined();
    merge(offboarding?.number ?? 0, false);
    // The target's files are back as they were before onboarding, byte for byte.
    expect(git(remote, ["rev-parse", "main^{tree}"])).toBe(baseTree);
    expect(git(remote, ["show", "main:CLAUDE.md"])).toBe(claudeMd);

    const purged = await ok(["offboard", REPO]);
    expect(purged).toMatch(/scanned [1-9][0-9]* file\(s\) in the home and the replica and [1-9][0-9]* event\(s\)/);
    expect(purged).toContain(`offboarded ${REPO}: 1 task(s) purged (T-0002)`);
    expect(purged).toMatch(/: 0 hit\(s\)/);
    expect(purged).not.toContain("left:");
    expect(readFileSync(engineLog, "utf8")).toContain("volume rm --force sf-gates-cache-example-ts-mini");

    // Nothing of the target in the home or the replica; the other target's task and the shared object intact.
    for (const dir of [home.root, replica]) {
      expect(existsSync(join(dir, "targets", "example__ts-mini")), dir).toBe(false);
      expect(grepTree(dir, needles), dir).toEqual([]);
    }
    expect(existsSync(join(home.mirrors, "example__ts-mini.git"))).toBe(false);
    expect(readdirSafe(join(home.root, "evals", "captured")).filter((f) => f.startsWith("T-0002-"))).toEqual([]);
    expect(readFileSync(join(home.root, "budgets", "calibration.json"), "utf8")).not.toContain(REPO);
    for (const db of [home.db, join(replica, "factory.db")]) {
      const s = EventStore.open(db);
      try {
        expect(s.events("T-0002"), db).toEqual([]);
        expect(s.tombstones().map((t) => t.task_id), db).toEqual(["T-0002"]);
        expect(s.events("T-0001").length, db).toBeGreaterThan(0);
      } finally {
        s.close();
      }
    }
    expect(hasObject(home.objects, sharedDigest)).toBe(true);
    expect(hasObject(join(replica, "objects"), sharedDigest)).toBe(true);
    expect(readFileSync(join(otelDir(home.root), "2026-10-22.ndjson"), "utf8")).toContain("T-0001");
    expect(readFileSync(join(otelDir(home.root), "2026-10-22.ndjson"), "utf8")).not.toContain("T-0002");

    // The purged id is never issued again; a restore and the restore drill bring nothing purged back.
    expect((await ok(["task", "create", "--profile", otherProfile, "--title", "Another note", "--body-file", shared, "--remote", other.remote])).trim()).toBe("T-0003");
    expect(await ok(["drill", "restore"])).toContain("PASS");
    const restored = factoryHome({ FACTORY_HOME: join(scratch, "restored") });
    await ok(["restore", "--source", replica], { FACTORY_HOME: restored.root });
    const back = EventStore.open(restored.db);
    try {
      expect(back.taskIds()).toEqual(["T-0001", "T-0003"]);
      expect(back.events("T-0002")).toEqual([]);
    } finally {
      back.close();
    }
    expect(existsSync(join(restored.targets, "example__ts-mini"))).toBe(false);

    // Offboarded: a run again finds nothing to do.
    expect(await ok(["offboard", REPO])).toContain(`${REPO} is not registered: nothing to offboard`);
  }, 300_000);
});

function readdirSafe(dir: string): string[] {
  return existsSync(dir) ? spawnSync("ls", [dir], { encoding: "utf8" }).stdout.split("\n").filter((l) => l !== "") : [];
}

/** Every file under `dir` that holds any of these strings, by grep: an independent check of the offboard report's scan. */
function grepTree(dir: string, needles: readonly string[]): string[] {
  const r = spawnSync("grep", ["-rlaF", ...needles.flatMap((n) => ["-e", n]), dir], { encoding: "utf8" });
  return r.stdout.split("\n").filter((l) => l !== "");
}
