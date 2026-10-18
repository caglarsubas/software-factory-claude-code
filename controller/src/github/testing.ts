// Test support: GitHub in memory, and the same served over HTTP as the REST API restGitHub
// calls, so a factoryctl process can be pointed at it with FACTORY_GITHUB_API_URL.
import { verify, type KeyObject } from "node:crypto";
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
  // An open PR follows its branch, as GitHub's does.
  const view = (p: PullRequestInput & PullRequest): PullRequest => ({ number: p.number, url: p.url, state: p.state, merged: p.merged, headSha: p.state === "open" ? headOf(p.repo, p.head) || p.headSha : p.headSha });
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

/** A GitHub App the stub answers for (P2-05): JWTs must verify against `publicKey`. */
export interface StubApp {
  id: number;
  installationId: number;
  publicKey: KeyObject;
  permissions: Record<string, string>;
  /** Every installation token minted, with the repositories it was narrowed to. */
  minted: { token: string; repositories: string[] | null }[];
  /** The Authorization header of every REST call other than the App's own. */
  calls: { method: string; path: string; authorization: string }[];
}

/** Verifies an RS256 App JWT: signature, issuer and expiry. */
function appJwtValid(header: string | undefined, app: StubApp): boolean {
  const jwt = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  const [h = "", p = "", sig = ""] = (jwt ?? "").split(".");
  if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), app.publicKey, Buffer.from(sig, "base64url"))) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { iss?: string; exp?: number };
  return claims.iss === String(app.id) && (claims.exp ?? 0) > Date.now() / 1000;
}

/** Serves `gh` on a loopback port as the subset of the REST API restGitHub uses, and the App's token routes when `app` is given. */
export async function serveGitHub(gh: MemoryGitHub, app?: StubApp): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const send = (status: number, data: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (app !== undefined && url.pathname.startsWith("/app")) {
        if (!appJwtValid(req.headers.authorization, app)) {
          send(401, { message: "A JSON web token could not be decoded" });
        } else if (req.method === "GET" && url.pathname === "/app") {
          send(200, { id: app.id, slug: "factory-test", permissions: app.permissions });
        } else if (req.method === "POST" && url.pathname === `/app/installations/${String(app.installationId)}/access_tokens`) {
          const b = await body(req);
          const token = `ghs_test${String(app.minted.length + 1)}`;
          app.minted.push({ token, repositories: Array.isArray(b["repositories"]) ? (b["repositories"] as string[]) : null });
          send(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: app.permissions });
        } else {
          send(404, { message: "Not Found" });
        }
        return;
      }
      app?.calls.push({ method: req.method ?? "", path: url.pathname, authorization: req.headers.authorization ?? "" });
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
      } else if (req.method === "GET" && /^commits\/[0-9a-f]{40}\/check-runs$/.test(resource)) {
        const sha = resource.split("/")[1];
        const runs = gh.checks.filter((c) => c.repo === repo && c.headSha === sha);
        send(200, { total_count: runs.length, check_runs: runs.map((c) => ({ id: c.id, html_url: c.url, external_id: c.externalId, name: c.name, head_sha: c.headSha, status: "completed", conclusion: c.conclusion, app: app === undefined ? null : { id: app.id, slug: "factory-test" }, output: { title: c.title, summary: c.summary, text: c.text ?? null } })) });
      } else if (req.method === "POST" && resource === "check-runs") {
        const b = await body(req);
        const output = b["output"] as { title: string; summary: string; text?: string };
        send(201, await gh.createCheckRun({ repo, name: String(b["name"]), headSha: String(b["head_sha"]), externalId: String(b["external_id"]), conclusion: b["conclusion"] as "success", title: output.title, summary: output.summary, ...(output.text === undefined ? {} : { text: output.text }) }).then((r) => ({ id: r.id, html_url: r.url })));
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
