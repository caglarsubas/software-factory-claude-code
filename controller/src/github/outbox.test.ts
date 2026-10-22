// The outbox (P1-02): every effect is found before it is made, every intent gets an outcome,
// and nothing in the controller pushes or writes to GitHub any other way.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTaskClone } from "../git/repo.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import { commentMarker, createOutbox, danglingIntents, effectKey } from "./outbox.ts";
import { memoryGitHub, type MemoryGitHub } from "./testing.ts";

const scratch = mkdtempSync(join(tmpdir(), "outbox-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

interface World {
  store: EventStore;
  gh: MemoryGitHub;
  remote: string;
  mirror: string;
  clone: string;
  commit: string;
  points: string[];
}

let w: World;
let n = 0;
beforeEach(() => {
  const root = mkdtempSync(join(scratch, `w${String(++n)}-`));
  const seed = join(root, "seed");
  cpSync(join(REPO_ROOT, "gates/fixtures/ts"), seed, { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "base"]);
  const remote = join(root, "remote.git");
  git(root, ["clone", "-q", "--bare", seed, remote]);
  const mirror = join(root, "mirror.git");
  git(root, ["clone", "-q", "--bare", remote, mirror]);
  const clone = join(root, "clone");
  createTaskClone(mirror, clone, "factory/T-0001", git(mirror, ["rev-parse", "main"]));
  git(clone, ["commit", "-q", "--allow-empty", "-m", "candidate"]);
  const gh = memoryGitHub((_repo, branch) => spawnSync("git", ["-C", remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim());
  w = { store: EventStore.open(join(root, "factory.db")), gh, remote, mirror, clone, commit: git(clone, ["rev-parse", "HEAD"]), points: [] };
});

const outbox = (github: MemoryGitHub | null = w.gh) =>
  createOutbox({ store: w.store, taskId: "T-0001", github, auth: null, probe: (p) => w.points.push(p), log: () => undefined });
const effects = (): FactoryEvent[] => w.store.events("T-0001").filter((e) => e.type === "side_effect_intent" || e.type === "side_effect_done");
const where = { stage: "publish", round: 1 };
const push = () => outbox().push(where, { remote: w.remote, mirror: w.mirror, clone: w.clone, branch: "factory/T-0001", commit: w.commit });
const pr = () => outbox().pullRequest(where, { repo: "example/ts-mini", head: "factory/T-0001", base: "main", title: "t", body: "b", draft: false, commit: w.commit });
const remoteSha = (): string => spawnSync("git", ["-C", w.remote, "rev-parse", "--verify", "-q", "refs/heads/factory/T-0001"], { encoding: "utf8" }).stdout.trim();

describe("the outbox", () => {
  it("keys each effect by task, stage, round and kind, and records an intent before it and an outcome after", async () => {
    expect(await push()).toBe(w.commit);
    expect((await pr()).number).toBe(1);
    expect(effects().map((e) => [e.type, e.payload["key"], e.payload["attempt"], e.payload["outcome"]])).toEqual([
      ["side_effect_intent", "T-0001/publish/1/push", 1, undefined],
      ["side_effect_done", "T-0001/publish/1/push", 1, "done"],
      ["side_effect_intent", "T-0001/publish/1/pull_request", 1, undefined],
      ["side_effect_done", "T-0001/publish/1/pull_request", 1, "done"],
    ]);
    expect(w.points).toEqual(["publish:push:intent", "publish:push:acted", "publish:pull_request:intent", "publish:pull_request:acted"]);
    expect(remoteSha()).toBe(w.commit);
    expect(effectKey("T-0001", { stage: "publish", round: 2, name: "evidence" }, "comment")).toBe("T-0001/publish/2/comment/evidence");
  });

  it("finds an effect that already happened instead of making it again, and counts attempts per key", async () => {
    await push();
    await pr();
    expect(await push()).toBe(w.commit);
    expect((await pr()).number).toBe(1);
    expect(w.gh.writes).toEqual(["pull_request example/ts-mini factory/T-0001"]);
    const done = effects().filter((e) => e.type === "side_effect_done");
    expect(done.map((e) => `${String(e.payload["key"])}#${String(e.payload["attempt"])} ${String(e.payload["outcome"])}`)).toEqual([
      "T-0001/publish/1/push#1 done", "T-0001/publish/1/pull_request#1 done", "T-0001/publish/1/push#2 found", "T-0001/publish/1/pull_request#2 found",
    ]);
  });

  it("does not take another commit's PR for its own", async () => {
    await w.gh.createPullRequest({ repo: "example/ts-mini", head: "factory/T-0001", base: "main", title: "old", body: "an earlier candidate", draft: false });
    expect((await pr()).number).toBe(2);
  });

  it("reconciles dangling intents at the next run: found when the effect happened, absent when it did not", async () => {
    // A run killed after the push and before its outcome, and another killed before the PR was opened.
    const box = outbox();
    w.store.append({ task_id: "T-0001", actor: { kind: "factoryctl", id: "factoryctl" }, type: "side_effect_intent", payload: { key: "T-0001/publish/1/push", kind: "push", attempt: 1, remote: w.remote, branch: "factory/T-0001", commit: w.commit } });
    git(w.mirror, ["fetch", "-q", w.clone, "+refs/heads/factory/T-0001:refs/heads/factory/T-0001"]);
    git(w.mirror, ["push", "-q", w.remote, "refs/heads/factory/T-0001:refs/heads/factory/T-0001"]);
    w.store.append({ task_id: "T-0001", actor: { kind: "factoryctl", id: "factoryctl" }, type: "side_effect_intent", payload: { key: "T-0001/publish/1/pull_request", kind: "pull_request", attempt: 1, repo: "example/ts-mini", head: "factory/T-0001", base: "main", commit: w.commit } });
    expect(danglingIntents(w.store.events("T-0001"))).toHaveLength(2);
    expect(await box.reconcile()).toEqual([
      { key: "T-0001/publish/1/push", attempt: 1, outcome: "found" },
      { key: "T-0001/publish/1/pull_request", attempt: 1, outcome: "absent" },
    ]);
    expect(danglingIntents(w.store.events("T-0001"))).toEqual([]);
    expect(await box.reconcile()).toEqual([]);
  });

  it("leaves an intent it cannot look up dangling, for the next run", async () => {
    w.store.append({ task_id: "T-0001", actor: { kind: "factoryctl", id: "factoryctl" }, type: "side_effect_intent", payload: { key: "T-0001/publish/1/pull_request", kind: "pull_request", attempt: 1, repo: "example/ts-mini", head: "factory/T-0001", base: "main", commit: w.commit } });
    expect(await outbox(null).reconcile()).toEqual([]);
    expect(danglingIntents(w.store.events("T-0001"))).toHaveLength(1);
  });

  it("records a failed attempt as such, so it never dangles", async () => {
    const gh = { ...w.gh, createPullRequest: () => Promise.reject(new Error("HTTP 422")) };
    await expect(outbox(gh).pullRequest(where, { repo: "example/ts-mini", head: "factory/T-0001", base: "main", title: "t", body: "b", draft: false, commit: w.commit })).rejects.toThrow("HTTP 422");
    expect(effects().at(-1)?.payload).toMatchObject({ kind: "pull_request", outcome: "failed", error: "HTTP 422" });
    expect(danglingIntents(w.store.events("T-0001"))).toEqual([]);
  });

  it("finds comments by their marker and check runs by their external_id", async () => {
    const c = { stage: "publish", round: 1, name: "evidence" };
    const first = await outbox().comment(c, { repo: "example/ts-mini", issue: 1, body: "Gate evidence" });
    expect(first.body).toContain(commentMarker("T-0001/publish/1/comment/evidence"));
    expect((await outbox().comment(c, { repo: "example/ts-mini", issue: 1, body: "Gate evidence" })).id).toBe(first.id);
    const check = { repo: "example/ts-mini", name: "software-factory", headSha: w.commit, conclusion: "success" as const, title: "t", summary: "s" };
    const run = await outbox().checkRun(c, check);
    expect(w.gh.checks[0]?.externalId).toBe("T-0001/publish/1/check_run/evidence");
    expect(await outbox().checkRun(c, check)).toEqual(run);
    expect(w.gh.writes).toEqual(["comment example/ts-mini 1", "check_run example/ts-mini software-factory"]);
    // A dangling intent of either kind reconciles by the same lookup.
    w.store.append({ task_id: "T-0001", actor: { kind: "factoryctl", id: "factoryctl" }, type: "side_effect_intent", payload: { key: "T-0001/publish/1/comment/evidence", kind: "comment", attempt: 3, repo: "example/ts-mini", issue: 1 } });
    w.store.append({ task_id: "T-0001", actor: { kind: "factoryctl", id: "factoryctl" }, type: "side_effect_intent", payload: { key: "T-0001/publish/1/check_run/evidence", kind: "check_run", attempt: 3, repo: "example/ts-mini", sha: w.commit, name: "software-factory" } });
    expect((await outbox().reconcile()).map((r) => r.outcome)).toEqual(["found", "found"]);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("conformance: every effect goes through the outbox", () => {
  it("leaves no push or GitHub write outside the outbox", () => {
    const effectCall = /\b(pushFromMirror|createPullRequest|createComment|updateComment|createCheckRun|mergePullRequest)\s*\(/;
    // target/change.ts is the one other place (ADR 0003): the operator's onboarding and offboarding PRs, which belong to no task.
    const allowed = new Set(["controller/src/github/outbox.ts", "controller/src/github/client.ts", "controller/src/github/testing.ts", "controller/src/git/repo.ts", "controller/src/target/change.ts"]);
    const offenders = sources(join(REPO_ROOT, "controller/src"))
      .map((f) => relative(REPO_ROOT, f))
      .filter((f) => !allowed.has(f) && effectCall.test(readFileSync(join(REPO_ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
    // The rule has teeth: the outbox itself makes these calls.
    expect(effectCall.test(readFileSync(join(REPO_ROOT, "controller/src/github/outbox.ts"), "utf8"))).toBe(true);
  });
});
