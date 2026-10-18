// The footprint (P2-05b): the rendered target files and rulesets, and the properties that keep
// them safe. policy-check never checks out or runs the PR and can only read; every action is
// pinned by SHA; the required checks are exactly the jobs the workflows run, pinned to Actions.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadFixture } from "../fixtures/targets.ts";
import { loadYaml } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { applyRulesets, FootprintError, footprintRulesets, GITHUB_ACTIONS_APP_ID, renderFootprint, REQUIRED_CHECKS, type FootprintProfile } from "./footprint.ts";

const validator = createValidator();
const fixture = loadFixture("ts-mini", validator);
const profile = loadYaml(fixture.profilePath, "profile.schema.json", validator) as FootprintProfile;
const REF = "1".repeat(40);
const render = (over: Partial<Parameters<typeof renderFootprint>[0]> = {}) => renderFootprint({ profile, appId: 5364464, factoryRepo: "caglarsubas/software-factory-claude-code", factoryRef: REF, factoryTag: "v0.11.0", validator, ...over });

interface Step { uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }
interface Workflow { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { name: string; permissions: Record<string, string>; steps: Step[] }> }

describe("the footprint", () => {
  const files = render();
  const wf = (path: string): Workflow => parse(files[path] ?? "") as Workflow;

  it("renders the target policy policy-check reads, valid, with the profile's paths and approvers", () => {
    expect(Object.keys(files).sort()).toEqual([".factory/gates.yaml", ".factory/policy.yaml", ".github/workflows/factory-gates.yml", ".github/workflows/policy-check.yml"]);
    const policy = parse(files[".factory/policy.yaml"] ?? "") as Record<string, unknown>;
    expect(validator.validate("target-policy.schema.json", policy).errors).toEqual([]);
    expect(policy).toMatchObject({ app_id: 5364464, approvers: ["caglarsubas"], protected_paths: [{ glob: "src/auth/**", minimum_risk: "R3" }], restricted: [] });
    expect(parse(files[".factory/gates.yaml"] ?? "")).toMatchObject({ target: { repo: "caglarsubas/factory-fixture-ts-mini" }, commands: { test: "node --test" }, gates: { adapters: ["typescript"] } });
    for (const f of Object.values(files)) expect(f).not.toContain("@FACTORY_");
  });

  it("pins every action by commit SHA and the factory by its release commit", () => {
    for (const path of [".github/workflows/factory-gates.yml", ".github/workflows/policy-check.yml"]) {
      for (const job of Object.values(wf(path).jobs)) {
        for (const s of job.steps) {
          if (s.uses !== undefined) expect(s.uses, path).toMatch(/^[a-z0-9-]+\/[a-z0-9/-]+@[0-9a-f]{40}$/);
          if (s.with?.["repository"] !== undefined) expect(s.with["ref"], path).toBe(REF);
          if (s.uses?.startsWith("actions/checkout@") === true) expect(s.with?.["persist-credentials"], path).toBe(false);
        }
      }
      expect(wf(path).permissions, path).toEqual({});
    }
    expect(files[".github/workflows/policy-check.yml"]).toContain(`ref: "${REF}" # v0.11.0`);
  });

  it("never lets policy-check check out or run the PR, and gives it a read-only token", () => {
    const pc = wf(".github/workflows/policy-check.yml");
    expect(Object.keys(pc.on)).toEqual(["pull_request_target"]);
    const job = pc.jobs["policy-check"];
    expect(job?.permissions).toEqual({ contents: "read", "pull-requests": "read", checks: "read" });
    const checkouts = (job?.steps ?? []).filter((s) => s.uses?.startsWith("actions/checkout@") === true);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.with).toMatchObject({ repository: "caglarsubas/software-factory-claude-code", ref: REF });
    const text = files[".github/workflows/policy-check.yml"] ?? "";
    expect(text).not.toMatch(/secrets\.|github\.event\.pull_request\.head|github\.head_ref/);
    // Nothing from the event reaches a shell: the CLI reads the event file itself.
    for (const s of job?.steps ?? []) expect(s.run ?? "", "a run step").not.toContain("${{");
  });

  it("makes exactly the workflows' jobs required, pinned to GitHub Actions, and leaves the App only factory/** branches", () => {
    const [main, branches] = footprintRulesets();
    const required = ((main?.["rules"] as { type: string; parameters?: { required_status_checks?: { context: string; integration_id: number }[] } }[]).find((r) => r.type === "required_status_checks")?.parameters?.required_status_checks ?? []);
    expect(required).toEqual([{ context: wf(".github/workflows/factory-gates.yml").jobs["gates"]?.name, integration_id: 15368 }, { context: wf(".github/workflows/policy-check.yml").jobs["policy-check"]?.name, integration_id: 15368 }]);
    // What factoryctl waits for before it merges is exactly what the ruleset requires.
    expect(required).toEqual(REQUIRED_CHECKS.map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP_ID })));
    expect(main?.["conditions"]).toEqual({ ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } });
    expect(branches?.["conditions"]).toEqual({ ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH", "refs/heads/factory/**"] } });
    expect((branches?.["rules"] as { type: string }[]).map((r) => r.type)).toEqual(["creation", "update", "deletion"]);
    // Only the repository's admins bypass, for mirror-fixture --reset; never the App.
    for (const r of [main, branches]) expect(r?.["bypass_actors"]).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]);
  });

  it("refuses a moving ref, a profile without approvers, or an invalid policy", () => {
    expect(() => render({ factoryRef: "main" })).toThrow(FootprintError);
    expect(() => render({ factoryTag: "latest" })).toThrow(FootprintError);
    const without: FootprintProfile = { target: profile.target, commands: profile.commands, gates: profile.gates, protected_paths: profile.protected_paths, restricted: profile.restricted };
    expect(() => render({ profile: without })).toThrow(/names no governance.approvers/);
    expect(() => render({ appId: 0 })).toThrow(/target policy/);
  });

  it("creates a missing ruleset and replaces one of the same name", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      return Promise.resolve(Response.json(init?.method === "GET" ? [{ id: 9, name: "factory-main" }] : { id: 10 }));
    }) as typeof fetch;
    expect(await applyRulesets({ repo: "o/r", token: "t", api: "https://api.example", fetchFn })).toEqual(["replaced ruleset factory-main (9) on o/r", "created ruleset factory-branches on o/r"]);
    expect(calls).toEqual(["GET /repos/o/r/rulesets", "PUT /repos/o/r/rulesets/9", "POST /repos/o/r/rulesets"]);
    const refused = (async () => Promise.resolve(new Response("", { status: 403 }))) as typeof fetch;
    await expect(applyRulesets({ repo: "o/r", token: "t", api: "https://api.example", fetchFn: refused })).rejects.toThrow(/Administration: write/);
  });
});
