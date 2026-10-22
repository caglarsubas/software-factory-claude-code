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

/** What GitHub records about an issue's intake label and edits (P2-04), oldest first. */
export interface IssueEvent {
  kind: "labeled" | "unlabeled" | "renamed";
  /** The label's name, for labeled and unlabeled. */
  label: string | null;
  actor: string | null;
  at: string;
}

/** An open issue carrying the intake label, as intake reads it (P2-04). */
export interface IntakeIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  /** When the body was last edited, or null if never. */
  lastEditedAt: string | null;
  events: IssueEvent[];
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
  /** Every check run on a commit, with the app that posted it (P2-05b: the required checks). */
  checkRunsOn(repo: string, sha: string): Promise<CheckState[]>;
  /** Squash-merges the PR only if its head is still `sha` (P2-05b); GitHub refuses otherwise. */
  mergePullRequest(repo: string, number: number, sha: string): Promise<MergeResult>;
  /** Open issues (never PRs) carrying `label`, with their label and title events (P2-04). */
  intakeIssues(repo: string, label: string): Promise<IntakeIssue[]>;
  comment(repo: string, id: number): Promise<IssueComment>;
  updateComment(repo: string, id: number, body: string): Promise<IssueComment>;
}

export interface CheckState {
  name: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
}

export interface MergeResult {
  merged: boolean;
  /** The merge commit on the base branch. */
  sha: string;
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

export type Call = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** A token, or where to get a current one: the App's installation tokens expire within the hour. */
export type TokenSource = string | (() => Promise<string>);

/** A public repository needs no token for reads. */
export function caller(source: TokenSource | null, api: string, fetchFn: typeof fetch): Call {
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

// One GraphQL query per poll: REST has no time for an issue body's last edit, which intake needs
// to hold an edit made after the label (P2-04).
const INTAKE_QUERY = `query($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(labels: [$label], states: OPEN, first: 50, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url title body lastEditedAt
        timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT]) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt actor { login } label { name } }
            ... on UnlabeledEvent { createdAt actor { login } label { name } }
            ... on RenamedTitleEvent { createdAt actor { login } }
          }
        }
      }
    }
  }
}`;

interface GraphIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  lastEditedAt: string | null;
  timelineItems: { nodes: { __typename: string; createdAt: string; actor: { login: string } | null; label?: { name: string } }[] };
}

const KINDS: Record<string, IssueEvent["kind"]> = { LabeledEvent: "labeled", UnlabeledEvent: "unlabeled", RenamedTitleEvent: "renamed" };

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
    async checkRunsOn(repo, sha) {
      const all: CheckState[] = [];
      for (let page = 1; page <= PAGES; page++) {
        const body = (await call("GET", `/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${String(page)}`)) as { check_runs: { name: string; status: string; conclusion: string | null; app: { id: number } | null }[] };
        all.push(...body.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, appId: r.app?.id ?? null })));
        if (body.check_runs.length < 100) break;
      }
      return all;
    },
    async mergePullRequest(repo, number, sha) {
      const r = (await call("PUT", `/repos/${repo}/pulls/${String(number)}/merge`, { sha, merge_method: "squash" })) as { merged: boolean; sha: string };
      return { merged: r.merged, sha: r.sha };
    },
    async intakeIssues(repo, label) {
      const [owner = "", name = ""] = repo.split("/");
      const all: IntakeIssue[] = [];
      let after: string | null = null;
      for (let page = 0; page < PAGES; page++) {
        const r = (await call("POST", "/graphql", { query: INTAKE_QUERY, variables: { owner, name, label, after } })) as {
          data?: { repository: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GraphIssue[] } } | null };
          errors?: { message: string }[];
        };
        if (r.errors !== undefined && r.errors.length > 0) throw new GitHubError(`POST /graphql: ${r.errors.map((e) => e.message).join("; ")}`);
        const issues = r.data?.repository?.issues;
        if (issues === undefined) throw new GitHubError(`POST /graphql: no repository ${repo}`);
        for (const i of issues.nodes) {
          const events = i.timelineItems.nodes.flatMap((e): IssueEvent[] => {
            const kind = KINDS[e.__typename];
            return kind === undefined ? [] : [{ kind, label: e.label?.name ?? null, actor: e.actor?.login ?? null, at: e.createdAt }];
          });
          all.push({ number: i.number, url: i.url, title: i.title, body: i.body, lastEditedAt: i.lastEditedAt, events });
        }
        if (!issues.pageInfo.hasNextPage) break;
        after = issues.pageInfo.endCursor;
      }
      return all;
    },
    async comment(repo, id) {
      const c = (await call("GET", `/repos/${repo}/issues/comments/${String(id)}`)) as { id: number; html_url: string; body: string };
      return { id: c.id, url: c.html_url, body: c.body };
    },
    async updateComment(repo, id, body) {
      const c = (await call("PATCH", `/repos/${repo}/issues/comments/${String(id)}`, { body })) as { id: number; html_url: string; body: string };
      return { id: c.id, url: c.html_url, body: c.body };
    },
    async createCheckRun(i) {
      const r = (await call("POST", `/repos/${i.repo}/check-runs`, {
        name: i.name, head_sha: i.headSha, external_id: i.externalId, status: "completed", conclusion: i.conclusion, output: { title: i.title, summary: i.summary, ...(i.text === undefined ? {} : { text: i.text }) },
      })) as { id: number; html_url: string };
      return { id: r.id, url: r.html_url };
    },
  };
}

/** A commit on a PR, by the emails git recorded for it. */
export interface PullCommit {
  sha: string;
  authorEmail: string | null;
  committerEmail: string | null;
}

/** One entry of a repository's activity (pushes, branch changes, merges), newest first. */
export interface RepoActivity {
  type: string;
  ref: string;
  actor: string | null;
  at: string;
}

/** Read-only: what gate G2's evidence asks GitHub (G2-1's human commits and change requests, G2-2's push audit, G2-3's PR count). */
export interface GateReads {
  pullCommits(repo: string, number: number): Promise<PullCommit[]>;
  /** The states of the PR's reviews: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  pullReviews(repo: string, number: number): Promise<string[]>;
  pullRequests(repo: string, head: string): Promise<PullRequest[]>;
  /** The repository's activity since `since`. */
  activity(repo: string, since: string): Promise<RepoActivity[]>;
}

const nextLink = (link: string | null): string | null => /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1] ?? null;

export function restGateReads(token: TokenSource | null, api = "https://api.github.com", fetchFn: typeof fetch = fetch): GateReads {
  const call = caller(token, api, fetchFn);
  const list = async <T>(path: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const batch = (await call("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${String(page)}`)) as T[];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };
  return {
    async pullCommits(repo, number) {
      const commits = await list<{ sha: string; commit: { author: { email?: string } | null; committer: { email?: string } | null } }>(`/repos/${repo}/pulls/${String(number)}/commits`);
      return commits.map((c) => ({ sha: c.sha, authorEmail: c.commit.author?.email ?? null, committerEmail: c.commit.committer?.email ?? null }));
    },
    async pullReviews(repo, number) {
      return (await list<{ state: string }>(`/repos/${repo}/pulls/${String(number)}/reviews`)).map((r) => r.state);
    },
    async pullRequests(repo, head) {
      const owner = repo.split("/")[0] ?? "";
      return (await list<RestPull>(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}`)).map(pull);
    },
    // The activity API pages by cursor, in its Link header; newest first, so it stops at `since`.
    async activity(repo, since) {
      const all: RepoActivity[] = [];
      let url: string | null = `${api}/repos/${repo}/activity?per_page=100&direction=desc`;
      for (let page = 0; url !== null && page < PAGES * 10; page++) {
        const t = typeof token === "function" ? await token() : token;
        const res: Response = await fetchFn(url, { headers: { ...(t === null ? {} : { authorization: `Bearer ${t}` }), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
        if (!res.ok) throw new GitHubError(`GET /repos/${repo}/activity: HTTP ${String(res.status)}`);
        const batch = (await res.json()) as { ref: string; timestamp: string; activity_type: string; actor: { login: string } | null }[];
        const fresh = batch.filter((a) => Date.parse(a.timestamp) >= Date.parse(since));
        all.push(...fresh.map((a) => ({ type: a.activity_type, ref: a.ref, actor: a.actor?.login ?? null, at: a.timestamp })));
        if (fresh.length < batch.length) break;
        url = nextLink(res.headers.get("link"));
        if (url !== null && !url.startsWith(`${api}/`)) throw new GitHubError(`GET /repos/${repo}/activity: a next page off ${api}`);
      }
      return all;
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
