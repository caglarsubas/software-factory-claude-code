// The GitHub REST calls factoryctl makes, against a fake fetch.
import { describe, expect, it } from "vitest";
import { restCommitChecks, restGitHub } from "./client.ts";

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: typeof fetch = (url, init) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fn };
}

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
    const f = fakeFetch({ message: "Not Found" }, 404);
    await expect(restCommitChecks("t0ken", "https://api.example", f.fn).checkRuns("owner/name", "b".repeat(40))).rejects.toThrow(/HTTP 404/);
    expect(f.calls[0]?.init.headers).toHaveProperty("authorization", "Bearer t0ken");
  });
});

describe("restGitHub", () => {
  it("finds an open PR by head branch before creating one", async () => {
    const f = fakeFetch([{ number: 7, html_url: "https://github.com/owner/name/pull/7" }]);
    expect(await restGitHub("t0ken", "https://api.example", f.fn).findPullRequest("owner/name", "factory/T-0001")).toEqual({ number: 7, url: "https://github.com/owner/name/pull/7" });
    expect(f.calls[0]?.url).toBe("https://api.example/repos/owner/name/pulls?state=open&head=owner%3Afactory%2FT-0001");
  });
});
