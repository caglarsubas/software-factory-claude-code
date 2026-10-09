// The GitHub side effects factoryctl performs. Agents never hold this token (ROADMAP §3.2).
export interface PullRequest {
  number: number;
  url: string;
}

export interface PullRequestInput {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface GitHub {
  /** The open PR for `head`, if one exists: re-running publish must not open a second. */
  findPullRequest(repo: string, head: string): Promise<PullRequest | null>;
  createPullRequest(input: PullRequestInput): Promise<PullRequest>;
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

/** A public repository needs no token for reads. */
function caller(token: string | null, api: string, fetchFn: typeof fetch): Call {
  return async (method, path, body) => {
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

export function restCommitChecks(token: string | null, api = "https://api.github.com", fetchFn: typeof fetch = fetch): CommitChecks {
  const call = caller(token, api, fetchFn);
  return {
    async checkRuns(repo, sha) {
      const body = (await call("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)) as { check_runs: { name: string; status: string; conclusion: string | null; app: { slug?: string } | null }[] };
      return body.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, app: r.app?.slug ?? null }));
    },
  };
}

export function restGitHub(token: string, api = "https://api.github.com", fetchFn: typeof fetch = fetch): GitHub {
  const call = caller(token, api, fetchFn);
  return {
    async findPullRequest(repo, head) {
      const owner = repo.split("/")[0] ?? "";
      const prs = (await call("GET", `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`)) as { number: number; html_url: string }[];
      const pr = prs[0];
      return pr === undefined ? null : { number: pr.number, url: pr.html_url };
    },
    async createPullRequest(i) {
      const pr = (await call("POST", `/repos/${i.repo}/pulls`, { title: i.title, head: i.head, base: i.base, body: i.body, draft: i.draft })) as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url };
    },
  };
}
