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

export class GitHubError extends Error {}

export function restGitHub(token: string, api = "https://api.github.com", fetchFn: typeof fetch = fetch): GitHub {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchFn(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new GitHubError(`${method} ${path}: HTTP ${String(res.status)}`);
    return res.json();
  };
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
