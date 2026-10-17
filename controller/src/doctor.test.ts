// doctor's drift checks (P2-08): the runner's managed settings against what the release
// generates, and this repository's ruleset on GitHub against the release's copy.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { doctor, rulesetCheck, rulesetDiff } from "./doctor.ts";
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
});
