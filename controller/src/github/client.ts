// The GitHub calls factoryctl makes. Agents never hold this token (ROADMAP §3.2). Every call
// that changes GitHub goes through the outbox (outbox.ts), which pairs it with a lookup: each
// effect can be found again after a crash, by the PR's head commit, a comment's marker or a
// check run's external_id.
export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  /** The commit the PR's branch pointed at when GitHub answered. */
  headSha: string;
}

export interface PullRequestInput {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface IssueComment {
  id: number;
  url: string;
  body: string;
}

export interface CheckRunInput {
  repo: string;
  name: string;
  headSha: string;
  /** The outbox key: how the run is found again. */
  externalId: string;
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  /** Longer output: the factory/verdict run carries its canonical verdict here (P2-05). */
  text?: string;
}

export interface CheckRunRef {
  id: number;
  url: string;
}

export interface GitHub {
  /** The PRs from `head` in the repository's own owner, open or closed. */
  pullRequests(repo: string, head: string): Promise<PullRequest[]>;
  pullRequest(repo: string, number: number): Promise<PullRequest>;
  createPullRequest(input: PullRequestInput): Promise<PullRequest>;
  comments(repo: string, issue: number): Promise<IssueComment[]>;
  createComment(repo: string, issue: number, body: string): Promise<IssueComment>;
  findCheckRun(repo: string, sha: string, externalId: string): Promise<CheckRunRef | null>;
  /** Needs a GitHub App token: a fine-grained personal token cannot create check runs. */
  createCheckRun(input: CheckRunInput): Promise<CheckRunRef>;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  /** Slug of the GitHub App that posted it. */
  app: string | null;
}

/** Read-only: the check runs on a commit, for gate evidence (G0-4). */
export interface CommitChecks {
  checkRuns(repo: string, sha: string): Promise<CheckRun[]>;
}

export class GitHubError extends Error {}

type Call = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** A token, or where to get a current one: the App's installation tokens expire within the hour. */
export type TokenSource = string | (() => Promise<string>);

/** A public repository needs no token for reads. */
function caller(source: TokenSource | null, api: string, fetchFn: typeof fetch): Call {
  return async (method, path, body) => {
    const token = typeof source === "function" ? await source() : source;
    const res = await fetchFn(`${api}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new GitHubError(`${method} ${path}: HTTP ${String(res.status)}`);
    return res.json();
  };
}

export function restCommitChecks(token: TokenSource | null, api = "https://api.github.com", fetchFn: typeof fetch = fetch): CommitChecks {
  const call = caller(token, api, fetchFn);
  return {
    async checkRuns(repo, sha) {
      const body = (await call("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)) as { check_runs: { name: string; status: string; conclusion: string | null; app: { slug?: string } | null }[] };
      return body.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, app: r.app?.slug ?? null }));
    },
  };
}

interface RestPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  head: { sha: string };
}

const pull = (p: RestPull): PullRequest => ({ number: p.number, url: p.html_url, state: p.state, merged: p.merged_at !== null, headSha: p.head.sha });

const PAGES = 10;

export function restGitHub(token: TokenSource, api = "https://api.github.com", fetchFn: typeof fetch = fetch): GitHub {
  const call = caller(token, api, fetchFn);
  return {
    async pullRequests(repo, head) {
      const owner = repo.split("/")[0] ?? "";
      const prs = (await call("GET", `/repos/${repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${head}`)}`)) as RestPull[];
      return prs.map(pull);
    },
    async pullRequest(repo, number) {
      return pull((await call("GET", `/repos/${repo}/pulls/${String(number)}`)) as RestPull);
    },
    async createPullRequest(i) {
      return pull((await call("POST", `/repos/${i.repo}/pulls`, { title: i.title, head: i.head, base: i.base, body: i.body, draft: i.draft })) as RestPull);
    },
    async comments(repo, issue) {
      const all: IssueComment[] = [];
      for (let page = 1; page <= PAGES; page++) {
        const batch = (await call("GET", `/repos/${repo}/issues/${String(issue)}/comments?per_page=100&page=${String(page)}`)) as { id: number; html_url: string; body: string }[];
        all.push(...batch.map((c) => ({ id: c.id, url: c.html_url, body: c.body })));
        if (batch.length < 100) break;
      }
      return all;
    },
    async createComment(repo, issue, body) {
      const c = (await call("POST", `/repos/${repo}/issues/${String(issue)}/comments`, { body })) as { id: number; html_url: string; body: string };
      return { id: c.id, url: c.html_url, body: c.body };
    },
    async findCheckRun(repo, sha, externalId) {
      for (let page = 1; page <= PAGES; page++) {
        const body = (await call("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${String(page)}`)) as { check_runs: { id: number; html_url: string; external_id: string | null }[] };
        const run = body.check_runs.find((r) => r.external_id === externalId);
        if (run !== undefined) return { id: run.id, url: run.html_url };
        if (body.check_runs.length < 100) break;
      }
      return null;
    },
    async createCheckRun(i) {
      const r = (await call("POST", `/repos/${i.repo}/check-runs`, {
        name: i.name, head_sha: i.headSha, external_id: i.externalId, status: "completed", conclusion: i.conclusion, output: { title: i.title, summary: i.summary, ...(i.text === undefined ? {} : { text: i.text }) },
      })) as { id: number; html_url: string };
      return { id: r.id, url: r.html_url };
    },
  };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * FACTORY_GITHUB_API_URL: GitHub Enterprise or, for tests, a stub. The token goes wherever this
 * points, so it must be https, or plain http on this machine's loopback interface.
 */
export function githubApiUrl(value: string | undefined): string {
  if (value === undefined || value === "") return "https://api.github.com";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubError(`FACTORY_GITHUB_API_URL is not a URL: ${value}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new GitHubError("FACTORY_GITHUB_API_URL must be https, or http on a loopback address");
  return value.replace(/\/+$/, "");
}

export const isLoopbackApi = (api: string): boolean => LOOPBACK.has(new URL(api).hostname);
