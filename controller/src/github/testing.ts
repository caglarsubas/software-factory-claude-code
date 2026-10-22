// Test support: GitHub in memory, and the same served over HTTP as the REST API restGitHub
// calls, so a factoryctl process can be pointed at it with FACTORY_GITHUB_API_URL.
import { verify, type KeyObject } from "node:crypto";
import { GITHUB_ACTIONS_APP_ID } from "../governance/footprint.ts";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { CheckRunInput, CheckRunRef, GitHub, IntakeIssue, IssueComment, PullRequest, PullRequestInput } from "./client.ts";

export interface MemoryGitHub extends GitHub {
  prs: (PullRequestInput & PullRequest)[];
  /** The checks GitHub Actions posts on a commit (gates, policy-check): set by a test, as the target's workflows would. */
  actionsRuns: { repo: string; sha: string; name: string; status: string; conclusion: string | null }[];
  issueComments: (IssueComment & { repo: string; issue: number })[];
  checks: (CheckRunInput & CheckRunRef)[];
  /** Open issues by repository, as intake reads them (P2-04): set by a test, as people would. */
  issues: Map<string, (IntakeIssue & { labels: string[] })[]>;
  /** Every call that changed something, in order. */
  writes: string[];
  /** Repositories as the operator's token reads them (P2-11): default branch, visibility, protection. */
  repos: Map<string, { defaultBranch: string; private: boolean; protected: boolean }>;
  /** Each repository's rulesets, as created through the API, with their ids. */
  rulesets: Map<string, ({ id: number; name: string } & Record<string, unknown>)[]>;
  /** The operator's login (GET /user). */
  login: string;
}

/** GitHub Actions' own app ID: the required checks are pinned to it. */
export const GITHUB_ACTIONS_APP = GITHUB_ACTIONS_APP_ID;

/** `headOf` answers where a branch points when a PR is opened from it. */
export function memoryGitHub(headOf: (repo: string, branch: string) => string = () => "0".repeat(40)): MemoryGitHub {
  const prs: MemoryGitHub["prs"] = [];
  const issueComments: MemoryGitHub["issueComments"] = [];
  const checks: MemoryGitHub["checks"] = [];
  const writes: string[] = [];
  const actionsRuns: MemoryGitHub["actionsRuns"] = [];
  const issues: MemoryGitHub["issues"] = new Map();
  const repos: MemoryGitHub["repos"] = new Map();
  const rulesets: MemoryGitHub["rulesets"] = new Map();
  // An open PR follows its branch, as GitHub's does.
  const view = (p: PullRequestInput & PullRequest): PullRequest => ({ number: p.number, url: p.url, state: p.state, merged: p.merged, headSha: p.state === "open" ? headOf(p.repo, p.head) || p.headSha : p.headSha });
  return {
    prs,
    actionsRuns,
    issues,
    repos,
    rulesets,
    login: "operator",
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
    checkRunsOn: (repo, sha) =>
      Promise.resolve([
        ...actionsRuns.filter((r) => r.repo === repo && r.sha === sha).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, appId: GITHUB_ACTIONS_APP })),
        ...checks.filter((c) => c.repo === repo && c.headSha === sha).map((c) => ({ name: c.name, status: "completed", conclusion: c.conclusion, appId: null })),
      ]),
    mergePullRequest: (repo, number, sha) => {
      const p = prs.find((x) => x.repo === repo && x.number === number);
      if (p === undefined) return Promise.reject(new Error(`no PR ${String(number)} in ${repo}`));
      const head = view(p).headSha;
      // GitHub answers 409 when the head moved and 405 when the PR cannot be merged.
      if (p.state !== "open" || p.merged) return Promise.reject(new Error(`PUT /repos/${repo}/pulls/${String(number)}/merge: HTTP 405`));
      if (head !== sha) return Promise.reject(new Error(`PUT /repos/${repo}/pulls/${String(number)}/merge: HTTP 409`));
      writes.push(`merge ${repo} ${String(number)}`);
      p.state = "closed";
      p.merged = true;
      p.headSha = head;
      return Promise.resolve({ merged: true, sha: `${"f".repeat(39)}${String(number % 10)}` });
    },
    intakeIssues: (repo, label) => Promise.resolve((issues.get(repo) ?? []).filter((i) => i.labels.includes(label)).map((i) => structuredClone({ number: i.number, url: i.url, title: i.title, body: i.body, lastEditedAt: i.lastEditedAt, events: i.events }))),
    comment: (repo, id) => {
      const c = issueComments.find((x) => x.repo === repo && x.id === id);
      return c === undefined ? Promise.reject(new Error(`GET /repos/${repo}/issues/comments/${String(id)}: HTTP 404`)) : Promise.resolve({ id: c.id, url: c.url, body: c.body });
    },
    updateComment: (repo, id, body) => {
      const c = issueComments.find((x) => x.repo === repo && x.id === id);
      if (c === undefined) return Promise.reject(new Error(`PATCH /repos/${repo}/issues/comments/${String(id)}: HTTP 404`));
      writes.push(`comment_edit ${repo} ${String(id)}`);
      c.body = body;
      return Promise.resolve({ id: c.id, url: c.url, body });
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
  /** The repositories (names) the installation reaches; a token narrowed to any other is refused with 422. Absent: every repository. */
  repositories?: Set<string>;
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
          const wanted = Array.isArray(b["repositories"]) ? (b["repositories"] as string[]) : [];
          if (app.repositories !== undefined && wanted.some((r) => !app.repositories?.has(r))) {
            send(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
            return;
          }
          const token = `ghs_test${String(app.minted.length + 1)}`;
          app.minted.push({ token, repositories: Array.isArray(b["repositories"]) ? (b["repositories"] as string[]) : null });
          send(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: app.permissions });
        } else {
          send(404, { message: "Not Found" });
        }
        return;
      }
      app?.calls.push({ method: req.method ?? "", path: url.pathname, authorization: req.headers.authorization ?? "" });
      if (req.method === "GET" && url.pathname === "/user") {
        send(200, { login: gh.login });
        return;
      }
      const whole = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && whole !== null) {
        const r = gh.repos.get(whole[1] ?? "");
        if (r === undefined) send(404, { message: "Not Found" });
        else send(200, { full_name: whole[1], default_branch: r.defaultBranch, private: r.private });
        return;
      }
      const m = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(url.pathname);
      const repo = m?.[1] ?? "";
      const resource = m?.[2] ?? "";
      const sets = gh.rulesets.get(repo) ?? [];
      const rulesetId = /^rulesets\/([0-9]+)$/.exec(resource)?.[1];
      if (req.method === "GET" && /^branches\/[^/]+$/.test(resource)) {
        send(200, { name: resource.slice("branches/".length), protected: gh.repos.get(repo)?.protected ?? false });
      } else if (req.method === "GET" && /^rules\/branches\/[^/]+$/.test(resource)) {
        send(200, sets.flatMap((r) => (r["rules"] as unknown[] | undefined) ?? []));
      } else if (req.method === "GET" && resource === "rulesets") {
        send(200, sets.map((r) => ({ id: r.id, name: r.name })));
      } else if (rulesetId !== undefined) {
        const at = sets.findIndex((r) => r.id === Number(rulesetId));
        if (at === -1) {
          send(404, { message: "Not Found" });
        } else if (req.method === "GET") {
          send(200, sets[at]);
        } else if (req.method === "PUT") {
          const b = await body(req);
          sets[at] = { ...b, id: Number(rulesetId), name: String(b["name"]) };
          gh.writes.push(`ruleset_replace ${repo} ${String(b["name"])}`);
          send(200, sets[at]);
        } else if (req.method === "DELETE") {
          gh.writes.push(`ruleset_delete ${repo} ${sets[at]?.name ?? ""}`);
          sets.splice(at, 1);
          res.writeHead(204).end();
        } else {
          send(404, { message: "Not Found" });
        }
      } else if (req.method === "POST" && resource === "rulesets") {
        const b = await body(req);
        const created = { ...b, id: 1000 + [...gh.rulesets.values()].flat().length + gh.writes.length, name: String(b["name"]) };
        gh.rulesets.set(repo, [...sets, created]);
        gh.writes.push(`ruleset_create ${repo} ${created.name}`);
        send(201, created);
      } else if (req.method === "GET" && resource === "pulls") {
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
        const actions = gh.actionsRuns.filter((r) => r.repo === repo && r.sha === sha);
        send(200, {
          total_count: runs.length + actions.length,
          check_runs: [
            ...runs.map((c) => ({ id: c.id, html_url: c.url, external_id: c.externalId, name: c.name, head_sha: c.headSha, status: "completed", conclusion: c.conclusion, app: app === undefined ? null : { id: app.id, slug: "factory-test" }, output: { title: c.title, summary: c.summary, text: c.text ?? null } })),
            ...actions.map((r, k) => ({ id: 100_000 + k, html_url: "", external_id: null, name: r.name, head_sha: r.sha, status: r.status, conclusion: r.conclusion, app: { id: GITHUB_ACTIONS_APP, slug: "github-actions" }, output: { title: null, summary: null, text: null } })),
          ],
        });
      } else if (req.method === "PUT" && /^pulls\/[0-9]+\/merge$/.test(resource)) {
        const b = await body(req);
        try {
          send(200, { ...(await gh.mergePullRequest(repo, Number(resource.split("/")[1]), String(b["sha"]))), message: "Pull Request successfully merged" });
        } catch (e) {
          send(Number(/HTTP ([0-9]{3})/.exec(String(e))?.[1] ?? "500"), { message: String(e) });
        }
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
  // This process blocks in synchronous git calls for seconds at a time. With a server-side keep-alive
  // timeout, a timer that expired meanwhile closes a pooled connection before the server reads the
  // request a client already sent on it (ECONNRESET, "fetch failed"): the client closes idle connections instead.
  server.keepAliveTimeout = 0;
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
