// Test support: GitHub in memory, and the same served over HTTP as the REST API restGitHub
// calls, so a factoryctl process can be pointed at it with FACTORY_GITHUB_API_URL.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { CheckRunInput, CheckRunRef, GitHub, IssueComment, PullRequest, PullRequestInput } from "./client.ts";

export interface MemoryGitHub extends GitHub {
  prs: (PullRequestInput & PullRequest)[];
  issueComments: (IssueComment & { repo: string; issue: number })[];
  checks: (CheckRunInput & CheckRunRef)[];
  /** Every call that changed something, in order. */
  writes: string[];
}

/** `headOf` answers where a branch points when a PR is opened from it. */
export function memoryGitHub(headOf: (repo: string, branch: string) => string = () => "0".repeat(40)): MemoryGitHub {
  const prs: MemoryGitHub["prs"] = [];
  const issueComments: MemoryGitHub["issueComments"] = [];
  const checks: MemoryGitHub["checks"] = [];
  const writes: string[] = [];
  const view = (p: PullRequestInput & PullRequest): PullRequest => ({ number: p.number, url: p.url, state: p.state, merged: p.merged, headSha: p.headSha });
  return {
    prs,
    issueComments,
    checks,
    writes,
    pullRequests: (repo, head) => Promise.resolve(prs.filter((p) => p.repo === repo && p.head === head).map(view)),
    pullRequest: (repo, number) => {
      const p = prs.find((x) => x.repo === repo && x.number === number);
      return p === undefined ? Promise.reject(new Error(`no PR ${String(number)} in ${repo}`)) : Promise.resolve(view(p));
    },
    createPullRequest: (input) => {
      writes.push(`pull_request ${input.repo} ${input.head}`);
      const number = prs.filter((p) => p.repo === input.repo).length + 1;
      const p = { ...input, number, url: `https://github.com/${input.repo}/pull/${String(number)}`, state: "open" as const, merged: false, headSha: headOf(input.repo, input.head) };
      prs.push(p);
      return Promise.resolve(view(p));
    },
    comments: (repo, issue) => Promise.resolve(issueComments.filter((c) => c.repo === repo && c.issue === issue).map((c) => ({ id: c.id, url: c.url, body: c.body }))),
    createComment: (repo, issue, body) => {
      writes.push(`comment ${repo} ${String(issue)}`);
      const c = { repo, issue, id: issueComments.length + 1, url: `https://github.com/${repo}/pull/${String(issue)}#issuecomment-${String(issueComments.length + 1)}`, body };
      issueComments.push(c);
      return Promise.resolve({ id: c.id, url: c.url, body });
    },
    findCheckRun: (repo, sha, externalId) => {
      const r = checks.find((c) => c.repo === repo && c.headSha === sha && c.externalId === externalId);
      return Promise.resolve(r === undefined ? null : { id: r.id, url: r.url });
    },
    createCheckRun: (input) => {
      writes.push(`check_run ${input.repo} ${input.name}`);
      const r = { ...input, id: checks.length + 1, url: `https://github.com/${input.repo}/runs/${String(checks.length + 1)}` };
      checks.push(r);
      return Promise.resolve({ id: r.id, url: r.url });
    },
  };
}

const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
};

const rest = (p: PullRequest) => ({ number: p.number, html_url: p.url, state: p.state, merged_at: p.merged ? "2026-10-13T00:00:00Z" : null, head: { sha: p.headSha } });

/** Serves `gh` on a loopback port as the subset of the REST API restGitHub uses. */
export async function serveGitHub(gh: GitHub): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const send = (status: number, data: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const m = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(url.pathname);
      const repo = m?.[1] ?? "";
      const resource = m?.[2] ?? "";
      if (req.method === "GET" && resource === "pulls") {
        const head = (url.searchParams.get("head") ?? "").split(":")[1] ?? "";
        send(200, (await gh.pullRequests(repo, head)).map(rest));
      } else if (req.method === "POST" && resource === "pulls") {
        const b = await body(req);
        send(201, rest(await gh.createPullRequest({ repo, head: String(b["head"]), base: String(b["base"]), title: String(b["title"]), body: String(b["body"]), draft: b["draft"] === true })));
      } else if (req.method === "GET" && /^pulls\/[0-9]+$/.test(resource)) {
        send(200, rest(await gh.pullRequest(repo, Number(resource.split("/")[1]))));
      } else {
        send(404, { message: "Not Found" });
      }
    })().catch((e: unknown) => {
      send(500, { message: e instanceof Error ? e.message : String(e) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
