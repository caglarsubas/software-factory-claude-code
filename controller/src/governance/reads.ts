// policy-check's GitHub reads, over REST with the workflow's own read-only token.
import { GitHubError, type TokenSource } from "../github/client.ts";
import { VERDICT_CHECK } from "./verdict.ts";
import type { PolicyReads, PrFile, Review, VerdictRun } from "./policy-check.ts";

/** GitHub lists at most 3000 files of a PR; a larger one cannot be judged and fails closed. */
const MAX_PAGES = 30;

export function restPolicyReads(token: TokenSource | null, api = "https://api.github.com", fetchFn: typeof fetch = fetch): PolicyReads {
  const request = async (path: string, accept = "application/vnd.github+json"): Promise<Response> => {
    const t = typeof token === "function" ? await token() : token;
    return fetchFn(`${api}${path}`, { headers: { ...(t === null ? {} : { authorization: `Bearer ${t}` }), accept, "x-github-api-version": "2022-11-28" } });
  };
  const json = async (path: string): Promise<unknown> => {
    const res = await request(path);
    if (!res.ok) throw new GitHubError(`GET ${path}: HTTP ${String(res.status)}`);
    return res.json();
  };
  const pages = async <T>(path: string, pick: (body: unknown) => T[]): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = pick(await json(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${String(page)}`));
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new GitHubError(`${path}: more than ${String(MAX_PAGES * 100)} entries`);
  };
  return {
    async pull(repo, number) {
      const p = (await json(`/repos/${repo}/pulls/${String(number)}`)) as { state: "open" | "closed"; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { sha: string } };
      return { headRef: p.head.ref, headSha: p.head.sha, headRepo: p.head.repo?.full_name ?? "", baseSha: p.base.sha, state: p.state };
    },
    files(repo, number) {
      return pages(`/repos/${repo}/pulls/${String(number)}/files`, (b) =>
        (b as { filename: string; previous_filename?: string; additions: number; deletions: number; status: string; patch?: string }[]).map((f): PrFile => ({
          path: f.filename, ...(f.previous_filename === undefined ? {} : { previousPath: f.previous_filename }), additions: f.additions, deletions: f.deletions, status: f.status, ...(f.patch === undefined ? {} : { patch: f.patch }),
        })));
    },
    verdictRuns(repo, sha) {
      // filter=all: every run with the name, not only each app's latest, so a second one is seen.
      return pages(`/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(VERDICT_CHECK)}&filter=all`, (b) =>
        (b as { check_runs: { app: { id: number } | null; head_sha: string; conclusion: string | null; output: { text: string | null } }[] }).check_runs.map((r): VerdictRun => ({ appId: r.app?.id ?? null, headSha: r.head_sha, conclusion: r.conclusion, text: r.output.text })));
    },
    reviews(repo, number) {
      return pages(`/repos/${repo}/pulls/${String(number)}/reviews`, (b) =>
        (b as { user: { login: string } | null; state: string; commit_id: string }[]).map((r): Review => ({ login: r.user?.login ?? "", state: r.state, commitId: r.commit_id })));
    },
    async file(repo, sha, path) {
      const res = await request(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "application/vnd.github.raw+json");
      if (res.status === 404) return null;
      if (!res.ok) throw new GitHubError(`GET contents ${path}@${sha.slice(0, 12)}: HTTP ${String(res.status)}`);
      return res.text();
    },
  };
}
