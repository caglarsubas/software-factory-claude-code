// P2-05 "done when": a forged verdict is rejected. policy-check against GitHub in memory: a
// verdict from the wrong app, for a stale commit, at a lower tier than the diff, with a digest
// that does not match, or hiding a sink under R1 fails; R3 and needs_human pass only with an
// approver's review of the head; a human's PR is left alone.
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadRiskPolicy } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import type { Sink } from "../../../gates/src/findings.ts";
import { addedLinesOf, policyCheck, POLICY_FILE, type PolicyReads, type PrFile, type Review, type VerdictRun } from "./policy-check.ts";
import { renderVerdict, type Verdict } from "./verdict.ts";

const REPO = "octo/target";
const APP = 4242;
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const validator = createValidator();
const risk = loadRiskPolicy();

const targetPolicy = { schema_version: 1, app_id: APP, approvers: ["operator"], protected_paths: [{ glob: "src/auth/**", minimum_risk: "R3", note: "authentication" }], restricted: [{ glob: "infra/prod/**" }] };

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  schema_version: 1, task_id: "T-0001", repo: REPO, head_sha: HEAD, base_commit: BASE, tier: "R1", decision: "approve", reviews: [],
  spec_digest: `sha256:${"1".repeat(64)}`, artifacts: [{ path: "verdict.json", digest: `sha256:${"2".repeat(64)}` }], factory: { version: "v0.10.0", policy: `sha256:${"3".repeat(64)}` }, ...over,
});

const run = (v: Verdict, over: Partial<VerdictRun> = {}): VerdictRun => ({ appId: APP, headSha: v.head_sha, conclusion: "success", text: renderVerdict(v).text, ...over });

const file = (path: string, patch = "@@ -1,1 +1,2 @@\n context\n+export const added = 1;", content = "context\nexport const added = 1;\n"): PrFile & { content: string } => ({ path, additions: 1, deletions: 0, status: "modified", patch, content });

interface World {
  headRef?: string;
  headRepo?: string;
  files?: (PrFile & { content: string })[];
  runs?: VerdictRun[];
  reviews?: Review[];
  policy?: string | null;
}

function reads(w: World): PolicyReads {
  const files = w.files ?? [file("src/cart.ts")];
  return {
    pull: () => Promise.resolve({ headRef: w.headRef ?? "factory/T-0001", headSha: HEAD, headRepo: w.headRepo ?? REPO, baseSha: BASE, state: "open" }),
    files: () => Promise.resolve(files.map((f): PrFile => ({ path: f.path, additions: f.additions, deletions: f.deletions, status: f.status, ...(f.patch === undefined ? {} : { patch: f.patch }) }))),
    // GitHub lists a commit's check runs: a run posted on another commit is never among them.
    verdictRuns: (_repo, sha) => Promise.resolve((w.runs ?? [run(verdict())]).filter((r) => r.headSha === sha)),
    reviews: () => Promise.resolve(w.reviews ?? []),
    file: (_repo, sha, path) => {
      if (path === POLICY_FILE) return Promise.resolve(sha === BASE ? (w.policy === undefined ? stringify(targetPolicy) : w.policy) : stringify({ ...targetPolicy, app_id: 1 }));
      return Promise.resolve(sha === HEAD ? (files.find((f) => f.path === path)?.content ?? null) : null);
    },
  };
}

/** A stand-in for the opengrep scan: a sink is any added line calling eval. */
const scanSinks = (files: readonly { content: string; added: number[] }[]): Promise<Sink[]> =>
  Promise.resolve(files.some((f) => f.added.some((n) => /\beval\(/.test(f.content.split("\n")[n - 1] ?? ""))) ? ["code_exec"] : []);

const check = (w: World) => policyCheck({ repo: REPO, pr: 7, reads: reads(w), risk, validator, scanSinks });

describe("policy-check", () => {
  it("passes a factory PR whose verdict holds, and leaves a human's PR to human review", async () => {
    expect(await check({})).toMatchObject({ conclusion: "success", computedTier: "R1", verdictTier: "R1" });
    expect(await check({ headRef: "feature/x", runs: [] })).toMatchObject({ conclusion: "success", title: "not a factory PR" });
    // A fork's factory/ branch is not the factory's.
    expect(await check({ headRepo: "mallory/target", runs: [] })).toMatchObject({ conclusion: "success", title: "not a factory PR" });
  });

  it("rejects a verdict from another app, and says so", async () => {
    const r = await check({ runs: [run(verdict(), { appId: 99 })] });
    expect(r).toMatchObject({ conclusion: "failure", title: "no factory verdict" });
    expect(r.reasons.join("\n")).toContain("from another app or a workflow were ignored");
    // A workflow's run (no app) never counts either, beside the real one or not.
    expect(await check({ runs: [run(verdict(), { appId: null })] })).toMatchObject({ conclusion: "failure", title: "no factory verdict" });
  });

  it("rejects a stale verdict: posted on an older commit, or judging one", async () => {
    // Posted on the old head: GitHub does not list it on the new one.
    expect(await check({ runs: [run(verdict({ head_sha: OLD }))] })).toMatchObject({ conclusion: "failure", title: "no factory verdict" });
    // Posted on the new head but judging the old one.
    const r = await check({ runs: [run(verdict({ head_sha: OLD }), { headSha: HEAD })] });
    expect(r).toMatchObject({ conclusion: "failure", title: "verdict rejected" });
    expect(r.reasons[0]).toContain(`judged ${OLD.slice(0, 12)}`);
  });

  it("rejects a verdict whose tier is below the one the diff computes", async () => {
    const r = await check({ files: [file("src/auth/session.ts")] });
    expect(r).toMatchObject({ conclusion: "failure", title: "verdict rejected", computedTier: "R3", verdictTier: "R1" });
    expect(r.reasons[0]).toBe("the verdict's tier R1 is below the computed R3");
    // A dependency manifest makes it R2 at least, from the release's own rules.
    expect(await check({ files: [file("package.json")] })).toMatchObject({ conclusion: "failure", computedTier: "R2" });
  });

  it("rejects a verdict whose content does not match its digest", async () => {
    const text = renderVerdict(verdict({ tier: "R3" })).text.replace('"tier":"R3"', '"tier":"R0"');
    const r = await check({ runs: [{ appId: APP, headSha: HEAD, conclusion: "success", text }] });
    expect(r).toMatchObject({ conclusion: "failure", title: "verdict digest mismatch" });
    expect(await check({ runs: [{ appId: APP, headSha: HEAD, conclusion: "success", text: "no verdict here" }] })).toMatchObject({ conclusion: "failure", title: "unreadable verdict" });
  });

  it("finds a sink hidden under an R1 verdict in the head's added lines", async () => {
    const hidden = file("src/pricing/rules.ts", "@@ -1,1 +1,2 @@\n export const rules = [];\n+export const apply = (s: string) => eval(s);", "export const rules = [];\nexport const apply = (s: string) => eval(s);\n");
    const r = await check({ files: [hidden] });
    expect(r).toMatchObject({ conclusion: "failure", title: "verdict rejected", computedTier: "R3" });
    expect(r.reasons.join("\n")).toContain("sinks added: code_exec");
    // A sink on a line the PR did not add is the base's, not this PR's.
    const old = file("src/pricing/rules.ts", "@@ -1,1 +1,2 @@\n export const apply = (s: string) => eval(s);\n+export const rules = [];", "export const apply = (s: string) => eval(s);\nexport const rules = [];\n");
    expect(await check({ files: [old] })).toMatchObject({ conclusion: "success", computedTier: "R1" });
    // No patch from GitHub (a very large diff): the whole file is scanned, so the sink is still found.
    const large = { path: old.path, additions: old.additions, deletions: old.deletions, status: old.status, content: old.content };
    expect(await check({ files: [large] })).toMatchObject({ conclusion: "failure", computedTier: "R3" });
  });

  it("holds R3 and needs_human until a listed approver approves this very head", async () => {
    const r3 = { files: [file("src/auth/session.ts")], runs: [run(verdict({ tier: "R3" }))] };
    expect(await check(r3)).toMatchObject({ conclusion: "failure", title: "R3: waiting for an approver" });
    expect(await check({ ...r3, reviews: [{ login: "operator", state: "APPROVED", commitId: OLD }] })).toMatchObject({ conclusion: "failure" });
    expect(await check({ ...r3, reviews: [{ login: "someone", state: "APPROVED", commitId: HEAD }] })).toMatchObject({ conclusion: "failure" });
    // A later change request withdraws an approval.
    expect(await check({ ...r3, reviews: [{ login: "operator", state: "APPROVED", commitId: HEAD }, { login: "operator", state: "CHANGES_REQUESTED", commitId: HEAD }] })).toMatchObject({ conclusion: "failure" });
    expect(await check({ ...r3, reviews: [{ login: "operator", state: "APPROVED", commitId: HEAD }, { login: "operator", state: "COMMENTED", commitId: HEAD }] })).toMatchObject({ conclusion: "success", title: "R3: approved by operator" });
    const passed = { runs: [run(verdict({ decision: "needs_human" }))] };
    expect(await check(passed)).toMatchObject({ conclusion: "failure", title: "R1: waiting for an approver" });
    expect(await check({ ...passed, reviews: [{ login: "operator", state: "APPROVED", commitId: HEAD }] })).toMatchObject({ conclusion: "success" });
  });

  it("never passes Restricted, a pending or failed verdict, two verdicts, or a target without a policy", async () => {
    expect(await check({ files: [file("infra/prod/main.tf")], runs: [run(verdict({ tier: "Restricted" }))] })).toMatchObject({ conclusion: "failure", title: "Restricted: prepare only" });
    expect(await check({ runs: [run(verdict(), { conclusion: "failure" })] })).toMatchObject({ conclusion: "failure", title: "verdict rejected" });
    expect(await check({ runs: [run(verdict()), run(verdict({ tier: "R2" }))] })).toMatchObject({ conclusion: "failure", title: "conflicting verdicts" });
    expect(await check({ policy: null })).toMatchObject({ conclusion: "failure", title: "no target policy" });
    expect(await check({ policy: "schema_version: 1\napp_id: 4242\n" })).toMatchObject({ conclusion: "failure", title: "invalid target policy" });
  });

  it("reads the policy from the base: the head cannot name its own app", async () => {
    // reads() serves a head policy naming app 1; a verdict from app 1 must still be ignored.
    expect(await check({ runs: [run(verdict(), { appId: 1 })] })).toMatchObject({ conclusion: "failure", title: "no factory verdict" });
  });

  it("counts added lines from GitHub's patch", () => {
    expect(addedLinesOf("@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10,0 +11,1 @@\n+z\n\\ No newline at end of file")).toEqual([2, 3, 11]);
  });
});
