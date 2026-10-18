// doctor's drift checks (P2-08): the runner's managed settings against what the release
// generates, and this repository's ruleset on GitHub against the release's copy.
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appCheck, doctor, rulesetCheck, rulesetDiff } from "./doctor.ts";
import { memoryGitHub, serveGitHub, type StubApp } from "./github/testing.ts";
import { factoryHome } from "./home.ts";
import { REPO_ROOT } from "./policy/load.ts";
import { loadRelease } from "./release.ts";
import { createValidator } from "./schemas/validate.ts";

const scratch = mkdtempSync(join(tmpdir(), "doctor-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const release = loadRelease(createValidator());
const expected = JSON.parse(readFileSync(join(REPO_ROOT, ".github/rulesets/main.json"), "utf8")) as Parameters<typeof rulesetDiff>[0];
const home = factoryHome({ FACTORY_HOME: join(scratch, "home") });

describe("doctor's drift checks", () => {
  it("passes the release's own managed settings and fails a drifted copy", () => {
    const check = (root: string) => doctor(home, { ...release, root }, join(scratch, "no-key"), {}).find((c) => c.name === "managed settings");
    expect(check(release.root)?.status).toBe("ok");
    const copy = join(scratch, "release");
    cpSync(join(REPO_ROOT, "runner"), join(copy, "runner"), { recursive: true });
    const file = join(copy, "runner/managed-settings.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"allowManagedHooksOnly": true', '"allowManagedHooksOnly": false'));
    expect(check(copy)).toMatchObject({ status: "fail" });
    expect(check(join(scratch, "nothing"))).toMatchObject({ status: "fail", detail: expect.stringContaining("missing") as unknown });
  });

  it("names every difference between the expected ruleset and GitHub's", () => {
    expect(rulesetDiff(expected, structuredClone(expected))).toEqual([]);
    const live = structuredClone(expected);
    live.enforcement = "evaluate";
    live.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole" }];
    live.rules = (live.rules ?? []).filter((r) => r.type !== "deletion").map((r) => (r.type === "pull_request" ? { ...r, parameters: { ...r.parameters, required_review_thread_resolution: false } } : r));
    live.rules.push({ type: "creation" });
    const diffs = rulesetDiff(expected, live);
    expect(diffs).toEqual(expect.arrayContaining([
      "enforcement is evaluate, expected active",
      'bypass actors ["RepositoryRole:5"], expected []',
      "rule deletion is missing",
      "pull_request.required_review_thread_resolution is false, expected true",
      "rule creation is not in the expected ruleset",
    ]));
    expect(diffs).toHaveLength(5);
  });

  it("takes a boolean parameter GitHub leaves out as its default, false", () => {
    const want = { name: "r", rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }] };
    expect(rulesetDiff(want, { name: "r", rules: [{ type: "update" }] })).toEqual([]);
    expect(rulesetDiff(want, { name: "r", rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: true } }] })).toEqual(["update.update_allows_fetch_and_merge is true, expected false"]);
    expect(rulesetDiff({ name: "r", rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: true } }] }, { name: "r", rules: [{ type: "update" }] })).toEqual(["update.update_allows_fetch_and_merge is undefined, expected true"]);
  });

  it("reads the ruleset from GitHub, and warns rather than fails when the token may not", async () => {
    const answer = (routes: Record<string, [number, unknown]>): typeof fetch => (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const [status, body] = routes[new URL(href).pathname] ?? [404, null];
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    });
    const base = { repo: "o/r", expected, token: "t", api: "https://api.example" };
    expect(await rulesetCheck({ ...base, fetchFn: answer({ "/repos/o/r/rulesets": [200, [{ id: 7, name: "main" }]], "/repos/o/r/rulesets/7": [200, expected] }) })).toMatchObject({ status: "ok" });
    expect(await rulesetCheck({ ...base, fetchFn: answer({ "/repos/o/r/rulesets": [200, [{ id: 7, name: "main" }]], "/repos/o/r/rulesets/7": [200, { ...expected, enforcement: "disabled" }] }) })).toMatchObject({ status: "fail", detail: "enforcement is disabled, expected active" });
    expect(await rulesetCheck({ ...base, fetchFn: answer({ "/repos/o/r/rulesets": [200, []] }) })).toMatchObject({ status: "fail", detail: expect.stringContaining("no ruleset named main") as unknown });
    expect(await rulesetCheck({ ...base, fetchFn: answer({ "/repos/o/r/rulesets": [403, null] }) })).toMatchObject({ status: "warn", detail: expect.stringContaining("Administration: read") as unknown });
  });

  it("checks the factory App: its key, the App GitHub knows by it, its exact permissions and its installation", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = join(scratch, "app.pem");
    writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
    const app: StubApp = { id: 4242, installationId: 77, publicKey: keys.publicKey, permissions: { checks: "write", contents: "write", metadata: "read", pull_requests: "write" }, minted: [], calls: [] };
    const api = await serveGitHub(memoryGitHub(), app);
    try {
      const env = { FACTORY_GITHUB_APP_ID: "4242", FACTORY_GITHUB_APP_INSTALLATION_ID: "77", FACTORY_GITHUB_APP_KEY_FILE: keyFile };
      expect((await appCheck({ home, env, api: api.url })).map((c) => [c.name, c.status])).toEqual([["github app", "ok"], ["github app permissions", "ok"], ["github app installation", "ok"]]);
      app.permissions = { ...app.permissions, workflows: "write" };
      expect((await appCheck({ home, env, api: api.url })).find((c) => c.name === "github app permissions")).toMatchObject({ status: "fail", detail: "workflows is write, expected not granted" });
      // Another app's key: GitHub refuses the JWT.
      expect(await appCheck({ home, env: { ...env, FACTORY_GITHUB_APP_ID: "5" }, api: api.url })).toEqual([expect.objectContaining({ status: "fail", detail: expect.stringContaining("HTTP 401") as unknown })]);
      expect(await appCheck({ home, env: {}, api: api.url })).toEqual([expect.objectContaining({ status: "warn", detail: expect.stringContaining("factoryctl app init") as unknown })]);
      expect(await appCheck({ home, env: { ...env, FACTORY_GITHUB_APP_KEY_FILE: join(scratch, "none.pem") }, api: api.url })).toEqual([expect.objectContaining({ status: "fail", detail: expect.stringContaining("missing") as unknown })]);
    } finally {
      await api.close();
    }
  });
});
