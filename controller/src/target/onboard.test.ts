// `factoryctl onboard` (P2-11): from nothing to an active target against a stub GitHub, through
// the STOP, the footprint PR, the rulesets and the App's access; each run takes it one state
// further, a repeated run changes nothing, and a closed update leaves the target as it was.
// The CLI part runs the real factoryctl: the STOP holds inside Claude Code, a run killed between
// the push and the PR ends with one of each, and `task create --repo` takes the confirmed profile.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { GatesResult, RunOptions } from "../../../gates/src/run.ts";
import { CLI, git } from "../cli/testing.ts";
import { targetChecks } from "../doctor.ts";
import { loadFixture } from "../fixtures/targets.ts";
import { restGitHub } from "../github/client.ts";
import { memoryGitHub, serveGitHub, type MemoryGitHub, type StubApp } from "../github/testing.ts";
import { renderFootprint } from "../governance/footprint.ts";
import { ensureHome, factoryHome, type Home } from "../home.ts";
import { loadRiskPolicy } from "../policy/load.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { EventStore } from "../store/events.ts";
import { loadProfile } from "../task/task.ts";
import { admit, ADMISSION_TASK } from "./admission.ts";
import { targetReads, type TargetReads } from "./github.ts";
import { inventory, treeOf } from "./inventory.ts";
import { renderLayer, type LayerInput } from "./layer.ts";
import { onboard, OnboardError, type OnboardDeps } from "./onboard.ts";
import { activeProfile, profileDigest, profileFile, readTarget, RegistryError } from "./registry.ts";
import { factorySource, targetRemote } from "./testing.ts";

const scratch = mkdtempSync(join(tmpdir(), "onboard-"));
const validator = createValidator();
const release = loadRelease(validator);
const TAG = "v0.22.0";
const remotes = new Map<string, string>();
const gh: MemoryGitHub = memoryGitHub((repo, branch) => spawnSync("git", ["-C", remotes.get(repo) ?? "", "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim());
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyFile = join(scratch, "github-app.pem");
writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
// The installation reaches no target until a test adds one, as the operator would in its settings.
const app: StubApp = { id: 4242, installationId: 77, publicKey: keys.publicKey, permissions: { checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write" }, minted: [], calls: [], repositories: new Set() };
const appConfig = { appId: app.id, installationId: app.installationId, keyFile };
const appEnv = { FACTORY_GITHUB_APP_ID: String(app.id), FACTORY_GITHUB_APP_INSTALLATION_ID: String(app.installationId), FACTORY_GITHUB_APP_KEY_FILE: keyFile };
let api = { url: "", close: () => Promise.resolve() };
beforeAll(async () => {
  api = await serveGitHub(gh, app);
});
afterAll(async () => {
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

// A factory checkout with the release tag, which --factory-ref resolves in a development checkout.
const { dir: source, sha: factorySha } = factorySource(join(scratch, "factory-src"), TAG);

interface World {
  root: string;
  repo: string;
  name: string;
  remote: string;
  base: string;
  home: Home;
  pushes: () => string[];
}

/** ts-mini with CI of its own, in a bare remote that logs every branch update; a protected main on the stub. */
function world(name: string): World {
  const root = mkdtempSync(join(scratch, `${name}-`));
  const { remote, base, pushes } = targetRemote(root, validator);
  const repo = `example/${name}`;
  remotes.set(repo, remote);
  gh.repos.set(repo, { defaultBranch: "main", private: false, protected: true });
  const home = factoryHome({ FACTORY_HOME: join(root, "home") });
  ensureHome(home);
  return { root, repo, name, remote, base, home, pushes };
}

const gateRuns: RunOptions[] = [];
/** The gates, green unless a test says otherwise: one entry per command, as the gate runner names them. */
let gateStatus: "pass" | "fail" = "pass";
const runGates = (o: RunOptions): Promise<GatesResult> => {
  gateRuns.push(o);
  const gates = Object.keys(o.profile.commands).filter((k) => k !== "setup").map((name) => ({ name, status: gateStatus, duration_ms: 1, summary: gateStatus === "pass" ? "ok" : "1 test failed" }));
  return Promise.resolve({ schema_version: 1, task_id: o.taskId, candidate_commit: o.base, passed: gateStatus === "pass", gates, signals: { sink_added: [], secret_material: false } });
};

function deps(w: World, out: string[]): OnboardDeps {
  return {
    home: w.home, validator, release, token: "op-token", api: api.url, app: appConfig,
    github: restGitHub("op-token", api.url), reads: targetReads("op-token", api.url),
    runGates, gateImage: () => "software-factory-gates:test", operator: "op",
    now: () => new Date("2026-10-22T09:00:00.000Z"),
    out: (l) => out.push(l), log: () => undefined,
  };
}

const pin = { factoryRef: TAG, source };

/** What the operator does on GitHub: merge the PR into main (the remote holds its commit), and the target's gates pass on it. */
function merge(w: World, number: number, gates = true): string {
  const pr = gh.prs.find((p) => p.repo === w.repo && p.number === number);
  if (pr === undefined) throw new Error(`no PR ${String(number)}`);
  const head = git(w.remote, ["rev-parse", `refs/heads/${pr.head}`]);
  git(w.remote, ["update-ref", "refs/heads/main", head]);
  Object.assign(pr, { state: "closed", merged: true, headSha: head });
  if (gates) gh.actionsRuns.push({ repo: w.repo, sha: head, name: "gates", status: "completed", conclusion: "success" });
  return head;
}

const writesFor = (repo: string): string[] => gh.writes.filter((x) => x.includes(` ${repo} `) || x.endsWith(` ${repo}`));

describe("onboarding", () => {
  it("takes a target from nothing to active, one state per run, stopping where a person acts", async () => {
    const w = world("ts-mini");
    const out: string[] = [];
    const d = deps(w, out);
    const run = async (o: Parameters<typeof onboard>[1] = {}): Promise<number> => {
      out.length = 0;
      return onboard(w.repo, { remote: w.remote, ...o }, d);
    };

    // An unprotected default branch is not admitted, and nothing can be confirmed.
    gh.repos.set(w.repo, { defaultBranch: "main", private: false, protected: false });
    expect(await run(pin)).toBe(1);
    expect(out.at(-1)).toMatch(/^not admitted/);
    expect(out).toContain("fail  protection: main has no branch protection or ruleset: protect it first");
    expect(gateRuns.at(-1)).toMatchObject({ taskId: ADMISSION_TASK, base: w.base, image: "software-factory-gates:test" });
    expect(existsSync(join(w.home.worktrees, `${ADMISSION_TASK}-example__ts-mini`))).toBe(false);
    await expect(run({ confirm: true, ...pin })).rejects.toThrow(/was not admitted/);
    expect(readTarget(w.home, w.repo, validator)?.state).toBe("drafted");

    // Protected, and the operator's edit to the draft survives the next run: it is theirs once written.
    gh.repos.set(w.repo, { defaultBranch: "main", private: false, protected: true });
    const path = profileFile(w.home, w.repo);
    appendFileSync(path, "# reviewed by op\n");
    expect(await run(pin)).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("# reviewed by op\n");
    expect(out.at(-1)).toBe(`STOP: review ${path}, then: factoryctl onboard ${w.repo} --confirm`);
    const drafted = readTarget(w.home, w.repo, validator);
    expect(drafted).toMatchObject({ state: "drafted", remote: w.remote, admission: { passed: true, head: w.base, profile_digest: profileDigest(w.home, w.repo) } });
    expect(loadProfile(path, validator)).toMatchObject({ factory_release: TAG, governance: { approvers: ["operator"] }, commands: { test: "node --test" } });

    // The STOP: a profile changed after its admission is not confirmed.
    appendFileSync(path, "# one more look\n");
    await expect(run({ confirm: true, ...pin })).rejects.toThrow(/changed since its admission/);
    expect(await run(pin)).toBe(0);
    expect(writesFor(w.repo)).toEqual([]);

    // Confirmed: one deterministic commit, pushed to software-factory/onboard, and one PR.
    expect(await run({ confirm: true, ...pin })).toBe(0);
    const proposed = readTarget(w.home, w.repo, validator);
    expect(proposed).toMatchObject({ state: "proposed", pr: { number: 1 }, confirmed: { branch: "software-factory/onboard", base: w.base, release: { repo: "example/factory", sha: factorySha, tag: TAG }, profile_digest: profileDigest(w.home, w.repo) } });
    const commit = proposed?.confirmed?.commit ?? "";
    expect(w.pushes()).toEqual([`refs/heads/software-factory/onboard ${commit}`]);
    expect(writesFor(w.repo)).toEqual([`pull_request ${w.repo} software-factory/onboard`]);
    expect(gh.prs.find((p) => p.repo === w.repo)).toMatchObject({ base: "main", title: `Onboard this repository to the software factory (${TAG})` });
    // Its files are the footprint and the layer, as rendered from the confirmed profile on the base.
    const profile = loadProfile(path, validator);
    const footprint = renderFootprint({ profile: profile as unknown as Parameters<typeof renderFootprint>[0]["profile"], appId: app.id, factoryRepo: "example/factory", factoryRef: factorySha, factoryTag: TAG, validator });
    const base = treeOf(w.remote, w.base);
    const layer = renderLayer({ repo: w.repo, profile: profile as unknown as LayerInput["profile"], risk: loadRiskPolicy(release.root, path), release: { repo: "example/factory", tag: TAG }, footprint: Object.keys(footprint), existing: (p) => base.read(p) });
    const files = { ...footprint, ...layer.files };
    expect(git(w.remote, ["diff", "--name-only", w.base, commit]).split("\n").sort()).toEqual(Object.keys(files).sort());
    for (const [p, content] of Object.entries(files)) expect(git(w.remote, ["show", `${commit}:${p}`])).toBe(content.trimEnd());
    expect(proposed?.confirmed?.layer.blocks.sort()).toEqual(layer.record.blocks.sort());
    expect(proposed?.confirmed?.layer.created).toEqual(expect.arrayContaining(Object.keys(footprint)));

    // Until it merges, a run only waits.
    expect(await run()).toBe(0);
    expect(out).toEqual([`waiting for ${proposed?.pr?.url ?? ""} to merge`]);
    expect(writesFor(w.repo)).toHaveLength(1);

    // Merged, the gates green on it: the rulesets go on; the App does not reach the target yet.
    merge(w, 1);
    expect(await run()).toBe(1);
    expect(readTarget(w.home, w.repo, validator)?.state).toBe("merged");
    expect(writesFor(w.repo)).toEqual([`pull_request ${w.repo} software-factory/onboard`, `ruleset_create ${w.repo} factory-main`, `ruleset_create ${w.repo} factory-branches`]);
    expect(out.at(-1)).toMatch(new RegExp(`does not reach ${w.repo}\\. Add it: https://github\\.com/settings/installations/77 → .* add ts-mini → Save`));

    // The operator adds it: active. The rulesets, already right, are not written again.
    app.repositories?.add("ts-mini");
    expect(await run()).toBe(0);
    const active = readTarget(w.home, w.repo, validator);
    expect(active).toMatchObject({ state: "active", active: { rulesets: ["factory-main", "factory-branches"] } });
    expect(active?.confirmed?.replaces).toBeUndefined();
    expect(writesFor(w.repo)).toHaveLength(3);
    expect(out.at(-1)).toBe(`${w.repo} is active: release ${TAG}, PR ${proposed?.pr?.url ?? ""}, rulesets factory-main, factory-branches`);
    expect(activeProfile(w.home, w.repo, validator).path).toBe(path);

    // Active, a run checks again: a ruleset someone disabled is put back, the other left alone.
    const main = gh.rulesets.get(w.repo)?.find((r) => r.name === "factory-main");
    if (main !== undefined) main["enforcement"] = "disabled";
    expect(await run()).toBe(0);
    expect(writesFor(w.repo).slice(3)).toEqual([`ruleset_replace ${w.repo} factory-main`]);
    expect((await targetChecks({ home: w.home, validator, token: "op-token", api: api.url, env: appEnv })).map((c) => [c.name, c.status])).toEqual([
      [`target ${w.repo}`, "ok"], [`ruleset ${w.repo} factory-main`, "ok"], [`ruleset ${w.repo} factory-branches`, "ok"], [`target ${w.repo} app`, "ok"],
    ]);

    // A profile edit: tasks and intake refuse it until an update lands.
    writeFileSync(path, readFileSync(path, "utf8").replace("protected_paths: []\n", 'protected_paths: [{glob: "src/billing/**", minimum_risk: R3}]\n'));
    expect(() => activeProfile(w.home, w.repo, validator)).toThrow(RegistryError);
    expect((await targetChecks({ home: w.home, validator, token: null, api: api.url, env: appEnv }))[0]).toMatchObject({ status: "warn", detail: expect.stringContaining("--update proposes the change") as unknown });
    expect(await run({ update: true, ...pin })).toBe(0);
    const updating = readTarget(w.home, w.repo, validator);
    expect(updating).toMatchObject({ state: "proposed", pr: { number: 2 }, confirmed: { branch: "software-factory/update", replaces: { commit, profile_digest: active?.confirmed?.profile_digest } } });
    expect(git(w.remote, ["show", `${updating?.confirmed?.commit ?? ""}:.factory/policy.yaml`])).toContain("src/billing/**");

    // Closed without merging: the target stays on the change it had, and the edit is still refused.
    const update = gh.prs.find((p) => p.repo === w.repo && p.number === 2);
    if (update !== undefined) Object.assign(update, { state: "closed" });
    expect(await run()).toBe(1);
    const back = readTarget(w.home, w.repo, validator);
    expect(back).toMatchObject({ state: "active", confirmed: { commit, profile_digest: active?.confirmed?.profile_digest, branch: "software-factory/onboard" } });
    expect(back?.confirmed?.replaces).toBeUndefined();
    expect(() => activeProfile(w.home, w.repo, validator)).toThrow(/changed since it was confirmed/);

    // Proposed again and merged: the edit is the target's profile now.
    expect(await run({ update: true, ...pin })).toBe(0);
    expect(readTarget(w.home, w.repo, validator)?.pr?.number).toBe(3);
    merge(w, 3);
    expect(await run()).toBe(0);
    expect(readTarget(w.home, w.repo, validator)).toMatchObject({ state: "active", confirmed: { profile_digest: profileDigest(w.home, w.repo), branch: "software-factory/update" } });
    expect(activeProfile(w.home, w.repo, validator).record.state).toBe("active");
    // Every step is in the journal.
    const steps = readFileSync(join(w.home.targets, "example__ts-mini/journal.ndjson"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { step: string }).step);
    expect(steps).toEqual(expect.arrayContaining(["draft", "confirm", "push", "pull_request", "proposed", "merged", "active", "rulesets", "update", "closed"]));
  });

  it("refuses what it cannot do yet, and what was never asked", async () => {
    const w = world("refusals");
    const out: string[] = [];
    await expect(onboard("not a repo", {}, deps(w, out))).rejects.toThrow(OnboardError);
    await expect(onboard(w.repo, { confirm: true }, deps(w, out))).rejects.toThrow(/run factoryctl onboard example\/refusals first/);
    await expect(onboard(w.repo, { update: true }, deps(w, out))).rejects.toThrow(/not active/);
    await expect(onboard(w.repo, { remote: w.remote }, { ...deps(w, out), reads: null })).rejects.toThrow(/FACTORY_GITHUB_TOKEN is needed/);
    // A development checkout must name the release it pins.
    expect(await onboard(w.repo, { remote: w.remote }, deps(w, out))).toBe(0);
    await expect(onboard(w.repo, { confirm: true }, deps(w, out))).rejects.toThrow(/--factory-ref TAG/);
    await expect(onboard(w.repo, { confirm: true, ...pin }, { ...deps(w, out), app: null })).rejects.toThrow(/factoryctl app init/);
    expect(writesFor(w.repo)).toEqual([]);
  });
});

describe("admission", () => {
  it("needs a valid profile with approvers, CI of its own, a protected default branch and every command gate green in the gate image", async () => {
    const w = world("admission");
    const head = w.base;
    const inv = inventory(w.repo, head, "main", treeOf(w.remote, head));
    const reads: TargetReads = { repository: () => Promise.resolve({ defaultBranch: "main", visibility: "public" }), protectedBranch: () => Promise.reject(new Error("HTTP 403")), login: () => Promise.resolve("op") };
    const base = {
      home: w.home, repo: w.repo, mirror: w.remote, inventory: inv, profileDigest: `sha256:${"0".repeat(64)}`, validator, reads, runGates, gateImage: () => "img", now: new Date(), log: () => undefined,
    };
    const good = parse(readFileSync(loadFixture("ts-mini", validator).profilePath, "utf8")) as Record<string, unknown>;
    good["target"] = { repo: w.repo, default_branch: "main", visibility: "public" };
    gateStatus = "fail";
    try {
      const a = await admit({ ...base, profile: good, inventory: { ...inv, ci: [] } });
      expect(a.passed).toBe(false);
      expect(Object.fromEntries(a.checks.map((c) => [c.name, c.ok]))).toEqual({ profile: true, ci: false, protection: false, gates: false });
      expect(a.checks.find((c) => c.name === "protection")?.detail).toMatch(/could not read main's protection: HTTP 403/);
      expect(a.checks.find((c) => c.name === "gates")?.detail).toMatch(/^typecheck fail: 1 test failed/);
    } finally {
      gateStatus = "pass";
    }
    const ok = await admit({ ...base, profile: good, reads: { ...reads, protectedBranch: () => Promise.resolve(true) } });
    expect(ok.checks.filter((c) => !c.ok)).toEqual([]);
    expect(ok.passed).toBe(true);
    // An invalid profile, or another target's, is not run through the gates at all.
    const runs = gateRuns.length;
    const bad = await admit({ ...base, profile: { ...good, governance: { approvers: [] } } });
    expect(bad.checks.find((c) => c.name === "profile")?.ok).toBe(false);
    expect(bad.checks.find((c) => c.name === "gates")).toMatchObject({ ok: false, detail: "not run: the profile is not valid" });
    const other = await admit({ ...base, profile: { ...good, target: { repo: "example/other", default_branch: "main", visibility: "public" } } });
    expect(other.checks.find((c) => c.name === "profile")).toMatchObject({ ok: false, detail: `target.repo is example/other, not ${w.repo}` });
    expect(gateRuns).toHaveLength(runs + 1);
  });
});

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

describe("factoryctl onboard", () => {
  it("holds the STOP inside Claude Code, pushes once and opens one PR across a kill, and gives task create the confirmed profile", async () => {
    const w = world("cli");
    const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      PATH: process.env["PATH"] ?? "", HOME: w.root, USER: "op", FACTORY_HOME: w.home.root, FACTORY_GITHUB_TOKEN: "op-token", FACTORY_GITHUB_API_URL: api.url,
      ...appEnv, ...extra,
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
    const replay = (name: string, injection: Record<string, unknown>): string => {
      const dir = join(w.root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "replay.json"), JSON.stringify(injection));
      return dir;
    };
    const gates = replay("gates", { gates: {} });
    const ref = ["--factory-ref", TAG, "--source", source];

    let r = await factoryctl(["onboard", w.repo, "--remote", w.remote, ...ref, "--replay", gates]);
    expect(r.stderr).toBe("");
    expect(r).toMatchObject({ code: 0, stdout: expect.stringContaining(`STOP: review ${profileFile(w.home, w.repo)}`) as unknown });
    const record = readFileSync(join(w.home.targets, "example__cli/target.json"), "utf8");

    // The STOP is the operator's: inside a Claude Code session, --confirm writes nothing.
    r = await factoryctl(["onboard", w.repo, "--confirm", ...ref], { CLAUDECODE: "1" });
    expect(r).toMatchObject({ code: 2, stderr: "factoryctl: onboard refuses to run inside a Claude Code session\n" });
    expect(readFileSync(join(w.home.targets, "example__cli/target.json"), "utf8")).toBe(record);
    expect(await factoryctl(["onboard", w.repo, "--confirm", "--update"])).toMatchObject({ code: 2, stderr: expect.stringContaining("usage: factoryctl onboard") as unknown });

    // Killed between the push and the PR; the next run opens the PR and pushes nothing.
    r = await factoryctl(["onboard", w.repo, "--confirm", ...ref, "--replay", replay("kill", { kill_at: "pushed" })]);
    expect(r.signal).toBe("SIGKILL");
    expect(w.pushes()).toHaveLength(1);
    expect(writesFor(w.repo)).toEqual([]);
    r = await factoryctl(["onboard", w.repo]);
    expect(r).toMatchObject({ code: 0, stdout: expect.stringContaining("opened https://github.com/example/cli/pull/1") as unknown });
    expect(w.pushes()).toHaveLength(1);
    expect(writesFor(w.repo)).toEqual([`pull_request ${w.repo} software-factory/onboard`]);

    merge(w, 1);
    app.repositories?.add("cli");
    r = await factoryctl(["onboard", w.repo]);
    expect(r).toMatchObject({ code: 0, stdout: expect.stringContaining(`${w.repo} is active`) as unknown });

    // A task on an onboarded target: its confirmed profile and its remote.
    const body = join(w.root, "task.md");
    writeFileSync(body, "Add an isEmpty helper.\n");
    r = await factoryctl(["task", "create", "--repo", w.repo, "--title", "Add isEmpty", "--body-file", body]);
    expect(r).toMatchObject({ code: 0, stdout: "T-0001\n" });
    const store = EventStore.open(w.home.db);
    try {
      expect(store.events("T-0001")[0]?.payload["remote"]).toBe(w.remote);
    } finally {
      store.close();
    }
    expect(await factoryctl(["task", "create", "--repo", w.repo, "--profile", profileFile(w.home, w.repo), "--title", "x", "--body-file", body])).toMatchObject({ code: 2, stderr: expect.stringContaining("--profile or --repo") as unknown });
    expect(await factoryctl(["task", "create", "--repo", "example/none", "--title", "x", "--body-file", body])).toMatchObject({ code: 2, stderr: "factoryctl: example/none is not onboarded: factoryctl onboard example/none\n" });
    appendFileSync(profileFile(w.home, w.repo), "# edited\n");
    expect(await factoryctl(["task", "create", "--repo", w.repo, "--title", "x", "--body-file", body])).toMatchObject({ code: 2, stderr: expect.stringContaining("changed since it was confirmed") as unknown });
  }, 120_000);
});
