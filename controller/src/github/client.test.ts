// The GitHub REST calls factoryctl makes, against a fake fetch.
import { describe, expect, it } from "vitest";
import { githubApiUrl, isLoopbackApi, restCommitChecks, restGitHub } from "./client.ts";

function fakeFetch(...bodies: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: typeof fetch = (url, init) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    const next = bodies.length > 1 ? bodies.shift() : bodies[0];
    const [body, status] = Array.isArray(next) && next.length === 2 && typeof next[1] === "number" ? (next as [unknown, number]) : [next, 200];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fn };
}

const SHA = "c".repeat(40);
const restPull = (number: number, over: Record<string, unknown> = {}) => ({ number, html_url: `https://github.com/owner/name/pull/${String(number)}`, state: "open", merged_at: null, head: { sha: SHA }, ...over });

describe("restCommitChecks", () => {
  it("reads a commit's check runs without a token on a public repository", async () => {
    const f = fakeFetch({ total_count: 2, check_runs: [{ name: "ci", status: "completed", conclusion: "success", app: { slug: "github-actions" } }, { name: "gates", status: "in_progress", conclusion: null, app: null }] });
    const runs = await restCommitChecks(null, "https://api.example", f.fn).checkRuns("owner/name", "a".repeat(40));
    expect(runs).toEqual([
      { name: "ci", status: "completed", conclusion: "success", app: "github-actions" },
      { name: "gates", status: "in_progress", conclusion: null, app: null },
    ]);
    expect(f.calls[0]?.url).toBe(`https://api.example/repos/owner/name/commits/${"a".repeat(40)}/check-runs?per_page=100`);
    expect(f.calls[0]?.init.headers).not.toHaveProperty("authorization");
  });

  it("sends the token when it has one, and fails on an HTTP error", async () => {
    const f = fakeFetch([{ message: "Not Found" }, 404]);
    await expect(restCommitChecks("t0ken", "https://api.example", f.fn).checkRuns("owner/name", "b".repeat(40))).rejects.toThrow(/HTTP 404/);
    expect(f.calls[0]?.init.headers).toHaveProperty("authorization", "Bearer t0ken");
  });
});

describe("restGitHub", () => {
  it("lists a branch's PRs in every state, with their head commit and whether they merged", async () => {
    const f = fakeFetch([restPull(7, { state: "closed", merged_at: "2026-10-13T09:00:00Z" }), restPull(9)]);
    expect(await restGitHub("t0ken", "https://api.example", f.fn).pullRequests("owner/name", "factory/T-0001")).toEqual([
      { number: 7, url: "https://github.com/owner/name/pull/7", state: "closed", merged: true, headSha: SHA },
      { number: 9, url: "https://github.com/owner/name/pull/9", state: "open", merged: false, headSha: SHA },
    ]);
    expect(f.calls[0]?.url).toBe("https://api.example/repos/owner/name/pulls?state=all&per_page=100&head=owner%3Afactory%2FT-0001");
  });

  it("creates and reads PRs, comments and check runs", async () => {
    const f = fakeFetch(
      [restPull(3), 201],
      restPull(3, { state: "closed" }),
      [{ id: 11, html_url: "https://github.com/owner/name/pull/3#issuecomment-11", body: "hello <!-- m -->" }],
      [{ id: 12, html_url: "https://github.com/owner/name/pull/3#issuecomment-12", body: "again" }, 201],
      { total_count: 2, check_runs: [{ id: 1, html_url: "https://github.com/owner/name/runs/1", external_id: null }, { id: 2, html_url: "https://github.com/owner/name/runs/2", external_id: "T-0001/publish/1/check_run/evidence" }] },
      [{ id: 5, html_url: "https://github.com/owner/name/runs/5" }, 201],
    );
    const gh = restGitHub("t0ken", "https://api.example", f.fn);
    expect(await gh.createPullRequest({ repo: "owner/name", head: "factory/T-0001", base: "main", title: "t", body: "b", draft: false })).toMatchObject({ number: 3, state: "open" });
    expect(await gh.pullRequest("owner/name", 3)).toMatchObject({ number: 3, state: "closed", merged: false });
    expect(await gh.comments("owner/name", 3)).toEqual([{ id: 11, url: "https://github.com/owner/name/pull/3#issuecomment-11", body: "hello <!-- m -->" }]);
    expect(await gh.createComment("owner/name", 3, "again")).toMatchObject({ id: 12 });
    expect(await gh.findCheckRun("owner/name", SHA, "T-0001/publish/1/check_run/evidence")).toEqual({ id: 2, url: "https://github.com/owner/name/runs/2" });
    expect(await gh.createCheckRun({ repo: "owner/name", name: "factory", headSha: SHA, externalId: "k", conclusion: "success", title: "t", summary: "s" })).toEqual({ id: 5, url: "https://github.com/owner/name/runs/5" });
    expect(f.calls.map((c) => `${c.init.method ?? ""} ${c.url.replace("https://api.example", "")}`)).toEqual([
      "POST /repos/owner/name/pulls",
      "GET /repos/owner/name/pulls/3",
      "GET /repos/owner/name/issues/3/comments?per_page=100&page=1",
      "POST /repos/owner/name/issues/3/comments",
      `GET /repos/owner/name/commits/${SHA}/check-runs?per_page=100&page=1`,
      "POST /repos/owner/name/check-runs",
    ]);
    expect(JSON.parse(f.calls[5]?.init.body as string)).toMatchObject({ head_sha: SHA, external_id: "k", status: "completed", conclusion: "success" });
  });
});

describe("intake reads (P2-04)", () => {
  it("reads labelled issues and their label and title events in one GraphQL query per page", async () => {
    const node = (number: number) => ({
      number, url: `https://github.com/owner/name/issues/${String(number)}`, title: "T", body: "B", lastEditedAt: number === 2 ? "2026-10-19T09:00:00Z" : null,
      timelineItems: { nodes: [
        { __typename: "LabeledEvent", createdAt: "2026-10-19T08:00:00Z", actor: { login: "maintainer" }, label: { name: "factory" } },
        { __typename: "UnlabeledEvent", createdAt: "2026-10-19T08:01:00Z", actor: null, label: { name: "factory" } },
        { __typename: "RenamedTitleEvent", createdAt: "2026-10-19T08:02:00Z", actor: { login: "someone" } },
      ] },
    });
    const f = fakeFetch(
      { data: { repository: { issues: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node(1)] } } } },
      { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(2)] } } } },
    );
    const issues = await restGitHub("t", "https://api.example", f.fn).intakeIssues("owner/name", "factory");
    expect(issues.map((i) => [i.number, i.lastEditedAt])).toEqual([[1, null], [2, "2026-10-19T09:00:00Z"]]);
    expect(issues[0]?.events).toEqual([
      { kind: "labeled", label: "factory", actor: "maintainer", at: "2026-10-19T08:00:00Z" },
      { kind: "unlabeled", label: "factory", actor: null, at: "2026-10-19T08:01:00Z" },
      { kind: "renamed", label: null, actor: "someone", at: "2026-10-19T08:02:00Z" },
    ]);
    expect(f.calls.map((c) => `${c.init.method ?? ""} ${c.url}`)).toEqual(["POST https://api.example/graphql", "POST https://api.example/graphql"]);
    expect(JSON.parse(f.calls[1]?.init.body as string)).toMatchObject({ variables: { owner: "owner", name: "name", label: "factory", after: "c1" } });
  });

  it("fails on a GraphQL error rather than reading no issues", async () => {
    const f = fakeFetch({ data: null, errors: [{ message: "Resource not accessible by integration" }] });
    await expect(restGitHub("t", "https://api.example", f.fn).intakeIssues("owner/name", "factory")).rejects.toThrow(/Resource not accessible by integration/);
  });

  it("reads and edits one comment", async () => {
    const f = fakeFetch({ id: 9, html_url: "https://github.com/owner/name/issues/3#issuecomment-9", body: "old" }, { id: 9, html_url: "https://github.com/owner/name/issues/3#issuecomment-9", body: "new" });
    const gh = restGitHub("t", "https://api.example", f.fn);
    expect((await gh.comment("owner/name", 9)).body).toBe("old");
    expect((await gh.updateComment("owner/name", 9, "new")).body).toBe("new");
    expect(f.calls.map((c) => `${c.init.method ?? ""} ${c.url}`)).toEqual(["GET https://api.example/repos/owner/name/issues/comments/9", "PATCH https://api.example/repos/owner/name/issues/comments/9"]);
    expect(JSON.parse(f.calls[1]?.init.body as string)).toEqual({ body: "new" });
  });
});

describe("FACTORY_GITHUB_API_URL", () => {
  it("defaults to api.github.com, and takes https or loopback http only", () => {
    expect(githubApiUrl(undefined)).toBe("https://api.github.com");
    expect(githubApiUrl("https://ghe.example/api/v3/")).toBe("https://ghe.example/api/v3");
    expect(githubApiUrl("http://127.0.0.1:4010")).toBe("http://127.0.0.1:4010");
    expect(isLoopbackApi("http://127.0.0.1:4010")).toBe(true);
    expect(isLoopbackApi("https://api.github.com")).toBe(false);
    expect(() => githubApiUrl("http://ghe.example")).toThrow(/https, or http on a loopback address/);
    expect(() => githubApiUrl("not a url")).toThrow(/is not a URL/);
  });
});
