// The factory/verdict text (P2-05): canonical JSON, so its digest is stable, round-tripped
// through the check run's output; and the REST reads policy-check makes with the Actions token.
import { describe, expect, it } from "vitest";
import { restPolicyReads } from "./reads.ts";
import { canonicalJson, parseVerdict, renderVerdict, VerdictParseError, verdictDigest, type Verdict } from "./verdict.ts";

const v: Verdict = {
  schema_version: 1, task_id: "T-0001", repo: "o/r", head_sha: "a".repeat(40), base_commit: "b".repeat(40), tier: "R2", decision: "approve", reviews: ["dependency", "security"],
  spec_digest: `sha256:${"1".repeat(64)}`, artifacts: [{ path: "verdict.json", digest: `sha256:${"2".repeat(64)}` }], factory: { version: "v0.10.0", policy: `sha256:${"3".repeat(64)}` },
};

describe("the verdict", () => {
  it("is canonical JSON: sorted keys at every level, no whitespace, undefined dropped", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: undefined } })).toBe('{"a":{"d":[2,{"y":null,"z":1}]},"b":1}');
    expect(verdictDigest({ ...v })).toBe(verdictDigest(JSON.parse(JSON.stringify(v)) as Verdict));
  });

  it("round-trips through the check run's text with its digest, and refuses anything else", () => {
    const out = renderVerdict(v);
    expect(out.title).toBe(`R2 · approved · ${"a".repeat(12)}`);
    expect(out.summary).toContain("reviewed by code, security, dependency");
    const parsed = parseVerdict(out.text);
    expect(parsed.verdict).toEqual(v);
    expect(parsed.stated).toBe(verdictDigest(v));
    expect(() => parseVerdict(null)).toThrow(VerdictParseError);
    expect(() => parseVerdict("```json factory-verdict\n{}\n```\n")).toThrow(/states no digest/);
    expect(() => parseVerdict(out.text.replace('"schema_version":1', '"schema_version":2'))).toThrow(/schema_version/);
  });
});

describe("policy-check's reads", () => {
  it("pages through files, lists every verdict run, and reads files raw, null when missing", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(url);
      seen.push(`${u.pathname}${u.search} ${new Headers(init?.headers).get("accept") ?? ""}`);
      const page = Number(u.searchParams.get("page") ?? "1");
      if (u.pathname.endsWith("/files")) return Promise.resolve(Response.json(Array.from({ length: page === 1 ? 100 : 3 }, (_, k) => ({ filename: `f${String(page)}-${String(k)}.ts`, additions: 1, deletions: 0, status: "added", patch: "@@ -0,0 +1 @@\n+x" }))));
      if (u.pathname.endsWith("/check-runs")) return Promise.resolve(Response.json({ total_count: 1, check_runs: [{ app: { id: 7 }, head_sha: "a".repeat(40), conclusion: "success", output: { text: "t" } }] }));
      if (u.pathname.endsWith("/missing.yaml")) return Promise.resolve(new Response("", { status: 404 }));
      if (u.pathname.includes("/contents/")) return Promise.resolve(new Response("raw content"));
      return Promise.resolve(Response.json({ state: "open", head: { ref: "factory/T-1", sha: "a".repeat(40), repo: null }, base: { sha: "b".repeat(40) } }));
    }) as typeof fetch;
    const r = restPolicyReads("t", "https://api.example", fetchFn);
    expect(await r.files("o/r", 1)).toHaveLength(103);
    expect(await r.verdictRuns("o/r", "a".repeat(40))).toEqual([{ appId: 7, headSha: "a".repeat(40), conclusion: "success", text: "t" }]);
    expect(seen.find((s) => s.includes("check-runs"))).toContain("check_name=factory%2Fverdict&filter=all");
    expect(await r.file("o/r", "c".repeat(40), ".factory/policy.yaml")).toBe("raw content");
    expect(seen.at(-1)).toContain("application/vnd.github.raw+json");
    expect(await r.file("o/r", "c".repeat(40), "missing.yaml")).toBeNull();
    // A deleted fork has no head repository: never mistaken for the target's own branch.
    expect(await r.pull("o/r", 1)).toMatchObject({ headRepo: "", headRef: "factory/T-1" });
  });
});

describe("policy-check's entry point", () => {
  it("takes the PR from a pull_request_target event only, and writes a summary a person can read", async () => {
    const { prFromEvent, summaryMarkdown } = await import("./policy-check-cli.ts");
    expect(prFromEvent({ action: "synchronize", pull_request: { number: 12 } })).toBe(12);
    expect(() => prFromEvent({ merge_group: {} })).toThrow(/pull_request_target events only/);
    expect(() => prFromEvent(null)).toThrow();
    const md = summaryMarkdown("o/r", 12, { conclusion: "failure", title: "verdict rejected", reasons: ["the verdict's tier R1 is below the computed R3", "computed tier R3"], computedTier: "R3", verdictTier: "R1" });
    expect(md).toContain("## policy-check: failed: verdict rejected");
    expect(md).toContain("o/r#12: computed tier R3, verdict tier R1.");
    expect(md).toContain("- the verdict's tier R1 is below the computed R3");
  });
});
