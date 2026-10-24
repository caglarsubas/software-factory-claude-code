// `factoryctl offboard` (P2-11, ADR 0003): access goes first, then the rulesets, then the
// target's files, then the factory's own data; each step is done once, a run stopped anywhere
// (a kill, a closed PR, a busy factory, an engine that does not answer) ends the same when run
// again, and a repository that is gone is offboarded from the factory's side only.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatesResult, RunOptions } from "../../../gates/src/run.ts";
import { pendingJournals } from "../durable/purge.ts";
import { restGitHub } from "../github/client.ts";
import { memoryGitHub, serveGitHub, type MemoryGitHub, type StubApp } from "../github/testing.ts";
import { ensureHome, factoryHome, type Home } from "../home.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { EventStore } from "../store/events.ts";
import { createTask } from "../task/task.ts";
import { git } from "../cli/testing.ts";
import { targetReads } from "./github.ts";
import { offboard, OffboardError, type OffboardDeps } from "./offboard.ts";
import { onboard, type OnboardDeps } from "./onboard.ts";
import { activeProfile, profileFile, readTarget, targetDir } from "./registry.ts";
import { factorySource, targetRemote } from "./testing.ts";

const scratch = mkdtempSync(join(tmpdir(), "offboard-"));
const validator = createValidator();
const release = loadRelease(validator);
const TAG = "v0.22.0";
const remotes = new Map<string, string>();
const gh: MemoryGitHub = memoryGitHub((repo, branch) => spawnSync("git", ["-C", remotes.get(repo) ?? "", "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim());
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyFile = join(scratch, "github-app.pem");
writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
const app: StubApp = { id: 4242, installationId: 77, publicKey: keys.publicKey, permissions: { checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write" }, minted: [], calls: [], repositories: new Set() };
const appConfig = { appId: app.id, installationId: app.installationId, keyFile };
let api = { url: "", close: () => Promise.resolve() };
beforeAll(async () => {
  api = await serveGitHub(gh, app);
});
afterAll(async () => {
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});
const { dir: source } = factorySource(join(scratch, "factory-src"), TAG);
const pin = { factoryRef: TAG, source };
const NOW = new Date("2026-10-22T09:00:00.000Z");

interface World {
  repo: string;
  name: string;
  remote: string;
  home: Home;
  store: EventStore;
  pushes: () => string[];
}

function world(name: string): World {
  const root = mkdtempSync(join(scratch, `${name}-`));
  const { remote, pushes } = targetRemote(root, validator);
  const repo = `example/${name}`;
  remotes.set(repo, remote);
  gh.repos.set(repo, { defaultBranch: "main", private: false, protected: true });
  const home = factoryHome({ FACTORY_HOME: join(root, "home") });
  ensureHome(home);
  return { repo, name, remote, home, store: EventStore.open(home.db), pushes };
}

const runGates = (o: RunOptions): Promise<GatesResult> =>
  Promise.resolve({ schema_version: 1, task_id: o.taskId, candidate_commit: o.base, passed: true, gates: [{ name: "test", status: "pass", duration_ms: 1, summary: "ok" }], signals: { sink_added: [], secret_material: false } });

const onboardDeps = (w: World): OnboardDeps => ({
  home: w.home, validator, release, token: "op-token", api: api.url, app: appConfig, github: restGitHub("op-token", api.url), reads: targetReads("op-token", api.url),
  runGates, gateImage: () => "img", operator: "op", now: () => NOW, out: () => undefined, log: () => undefined,
});

/** The operator merges a PR of the target into main; the target's gates pass on it when asked. */
function merge(w: World, number: number, gates: boolean): void {
  const pr = gh.prs.find((p) => p.repo === w.repo && p.number === number);
  if (pr === undefined) throw new Error(`no PR ${String(number)}`);
  const head = git(w.remote, ["rev-parse", `refs/heads/${pr.head}`]);
  git(w.remote, ["update-ref", "refs/heads/main", head]);
  Object.assign(pr, { state: "closed", merged: true, headSha: head });
  if (gates) gh.actionsRuns.push({ repo: w.repo, sha: head, name: "gates", status: "completed", conclusion: "success" });
}

/** Drafted, confirmed and proposed: its onboarding PR is open. */
async function proposed(w: World): Promise<number> {
  expect(await onboard(w.repo, { remote: w.remote, ...pin }, onboardDeps(w))).toBe(0);
  expect(await onboard(w.repo, { confirm: true, ...pin }, onboardDeps(w))).toBe(0);
  return readTarget(w.home, w.repo, validator)?.pr?.number ?? 0;
}

async function active(w: World): Promise<void> {
  merge(w, await proposed(w), true);
  app.repositories?.add(w.name);
  expect(await onboard(w.repo, {}, onboardDeps(w))).toBe(0);
  expect(readTarget(w.home, w.repo, validator)?.state).toBe("active");
}

let busy: string | null = null;
let engineAnswers = true;
const engineCalls: string[][] = [];

function deps(w: World, out: string[], kill?: string): OffboardDeps {
  return {
    home: w.home, store: w.store, validator, release, token: "op-token", api: api.url, app: appConfig, github: restGitHub("op-token", api.url), operator: "op", now: () => NOW,
    busy: () => busy,
    engine: (args) => {
      engineCalls.push(args);
      return engineAnswers ? { status: 0, stderr: "" } : { status: 1, stderr: "Cannot connect to the container engine" };
    },
    out: (l) => out.push(l), log: () => undefined,
    ...(kill === undefined ? {} : { probe: (p: string) => {
      if (p === kill) throw new Error(`killed at ${p}`);
    } }),
  };
}

const writesFor = (repo: string, kind: string): string[] => gh.writes.filter((x) => x.startsWith(`${kind} ${repo} `) || x === `${kind} ${repo}`);

describe("offboarding", () => {
  it("takes the App's access first, then the rulesets, the target's files and the data, each once, across every stop", async () => {
    const w = world("steps");
    await active(w);
    const out: string[] = [];
    // An unfinished task of the target holds it; once it has ended, offboarding begins.
    const task = createTask(w.home, w.store, validator, { profilePath: profileFile(w.home, w.repo), title: "Unfinished work on the carts", body: "Work.", trust: "operator", admittedBy: "op", remote: w.remote });
    await expect(offboard(w.repo, {}, deps(w, out))).rejects.toThrow(`${w.repo} has unfinished tasks (${task.id})`);
    w.store.append({ task_id: task.id, actor: { kind: "factoryctl", id: "factoryctl" }, type: "state_changed", from: "RECEIVED", to: "CANCELLED", payload: {} });

    // The App still reaches it: the operator's step, and nothing else yet. No new task from here on.
    expect(await offboard(w.repo, {}, deps(w, out))).toBe(1);
    expect(out.at(-1)).toMatch(new RegExp(`Remove it: https://github\\.com/settings/installations/77 → .* remove ${w.name} → Save`));
    expect(readTarget(w.home, w.repo, validator)?.state).toBe("offboarding");
    expect(() => activeProfile(w.home, w.repo, validator)).toThrow(/is offboarding, not active/);
    expect(writesFor(w.repo, "ruleset_delete")).toEqual([]);

    // Gone from the App: the rulesets go, and the run dies between the push and the PR.
    app.repositories?.delete(w.name);
    await expect(offboard(w.repo, {}, deps(w, out, "pushed"))).rejects.toThrow("killed at pushed");
    expect(writesFor(w.repo, "ruleset_delete")).toEqual([`ruleset_delete ${w.repo} factory-main`, `ruleset_delete ${w.repo} factory-branches`]);
    const offboardPushes = (): string[] => w.pushes().filter((p) => p.startsWith("refs/heads/software-factory/offboard "));
    expect(offboardPushes()).toHaveLength(1);
    out.length = 0;
    expect(await offboard(w.repo, {}, deps(w, out))).toBe(0);
    expect(out.at(-1)).toMatch(/^opened https:\/\/github\.com\/example\/steps\/pull\/2: review and merge it/);
    expect(offboardPushes()).toHaveLength(1);
    expect(writesFor(w.repo, "ruleset_delete")).toHaveLength(2);

    // Closed without merging: proposed again, the same commit, a new PR.
    const first = gh.prs.find((p) => p.repo === w.repo && p.number === 2);
    if (first !== undefined) first.state = "closed";
    expect(await offboard(w.repo, {}, deps(w, out))).toBe(1);
    expect(out.at(-1)).toMatch(/was closed without merging/);
    expect(await offboard(w.repo, {}, deps(w, out))).toBe(0);
    expect(offboardPushes()).toHaveLength(1);
    expect(writesFor(w.repo, "pull_request").filter((x) => x.endsWith("software-factory/offboard"))).toHaveLength(2);
    merge(w, 3, false);

    // The purge waits for an idle factory and an engine that answers, and a kill in it resumes.
    busy = "1 writer(s), 0 session(s), 0 runner and 0 gate container(s)";
    await expect(offboard(w.repo, {}, deps(w, out))).rejects.toThrow(/runs only while the factory is idle; now: 1 writer/);
    busy = null;
    await expect(offboard(w.repo, {}, deps(w, out, "purge:objects"))).rejects.toThrow("killed at purge:objects");
    expect(pendingJournals(w.home)).toHaveLength(1);
    expect(w.store.events(task.id)).toEqual([]);
    engineAnswers = false;
    await expect(offboard(w.repo, {}, deps(w, out))).rejects.toThrow(/did not remove sf-gates-cache-example-steps: Cannot connect/);
    expect(pendingJournals(w.home)).toEqual([]);
    expect(existsSync(targetDir(w.home, w.repo))).toBe(true);
    engineAnswers = true;
    out.length = 0;
    expect(await offboard(w.repo, {}, deps(w, out))).toBe(0);
    expect(out[0]).toBe(`offboarded ${w.repo}: 1 task(s) purged (${task.id}); sf-gates-cache-example-steps removed`);
    expect(out).toContainEqual(expect.stringMatching(/: 0 hit\(s\)$/));
    expect(engineCalls).toContainEqual(["volume", "rm", "--force", "sf-gates-cache-example-steps"]);
    expect(existsSync(targetDir(w.home, w.repo))).toBe(false);
    expect(existsSync(join(w.home.mirrors, "example__steps.git"))).toBe(false);
    expect(w.store.tombstones().map((t) => t.task_id)).toEqual([task.id]);
    expect(w.store.nextTaskId()).toBe("T-0002");
    // The default branch is back to the target's own files.
    expect(git(w.remote, ["ls-tree", "-r", "--name-only", "main"])).not.toMatch(/\.factory\/|factory-gates\.yml|factory-invariants/);

    // Offboarded: nothing left to do.
    out.length = 0;
    expect(await offboard(w.repo, {}, deps(w, out))).toBe(0);
    expect(out).toEqual([`${w.repo} is not registered: nothing to offboard`]);
    w.store.close();
  }, 60_000);

  it("offboards a repository that is gone from the factory's side only, with a reason", async () => {
    const w = world("gone");
    await active(w);
    const out: string[] = [];
    await expect(offboard(w.repo, { localOnly: true }, deps(w, out))).rejects.toThrow(OffboardError);
    const writes = gh.writes.length;
    expect(await offboard(w.repo, { localOnly: true, reason: "the repository was deleted" }, deps(w, out))).toBe(0);
    expect(gh.writes).toHaveLength(writes);
    expect(gh.rulesets.get(w.repo)).toHaveLength(2);
    expect(existsSync(targetDir(w.home, w.repo))).toBe(false);
    // Gone with its onboarding PR still open: nothing asks GitHub about it.
    const v = world("vanished");
    await proposed(v);
    expect(await offboard(v.repo, { localOnly: true, reason: "the repository was deleted" }, { ...deps(v, out), github: null, token: null })).toBe(0);
    v.store.close();
    w.store.close();
  }, 60_000);

  it("refuses while the onboarding PR is open, and takes nothing out of a target whose onboarding never merged", async () => {
    const w = world("draft");
    const number = await proposed(w);
    const out: string[] = [];
    await expect(offboard(w.repo, {}, deps(w, out))).rejects.toThrow(`https://github.com/${w.repo}/pull/${String(number)} is still open: close it first`);
    expect(readTarget(w.home, w.repo, validator)?.state).toBe("proposed");
    const pr = gh.prs.find((p) => p.repo === w.repo && p.number === number);
    if (pr !== undefined) pr.state = "closed";
    // The App cannot be asked: the record says why, and the run goes on.
    await expect(offboard(w.repo, { appUnavailable: true, reason: "the App is suspended" }, deps(w, out, "planned"))).rejects.toThrow("killed at planned");
    expect(readTarget(w.home, w.repo, validator)?.offboard).toMatchObject({ app: { detail: "not checked: the App is suspended" }, rulesets: { removed: [] }, cleaned: { detail: "main holds nothing of the factory's" } });
    expect(gh.prs.filter((p) => p.repo === w.repo)).toHaveLength(1);
    expect(await offboard(w.repo, {}, deps(w, out))).toBe(0);
    expect(existsSync(targetDir(w.home, w.repo))).toBe(false);
    w.store.close();
  }, 60_000);
});
