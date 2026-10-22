// The operator's changes to a target (P2-11, ADR 0003): the onboarding, update and offboarding
// PRs. They carry workflow files and belong to no task, so they go through here rather than
// the task outbox, with the operator's token, on `software-factory/**` branches (never
// `factory/**`, which is the App's and which policy-check holds to a verdict).
//
// Like the outbox, every step finds before it acts. The commit is built in the target's mirror,
// without a checkout, from the recorded base, files, identity and time, so building it again
// gives the same SHA; the push is skipped when the branch already points at it, and the PR when
// one is already open or merged from that branch.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authEnv, git, remoteBranchSha, type GitAuth } from "../git/repo.ts";
import type { GitHub, PullRequest } from "../github/client.ts";

export const CHANGE_IDENTITY = { name: "software-factory onboarding", email: "onboarding@software-factory.invalid" };

/**
 * A commit on `base` with these files written (null deletes), made in a (bare) repository: the
 * same base, files, message and date give the same commit.
 */
export function buildCommit(repo: string, base: string, files: Readonly<Record<string, string | null>>, message: string, date: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "sf-change-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: join(tmp, "index"),
    GIT_AUTHOR_NAME: CHANGE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: CHANGE_IDENTITY.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: CHANGE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: CHANGE_IDENTITY.email,
    GIT_COMMITTER_DATE: date,
  };
  const run = (args: string[], input?: string): string => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env, ...(input === undefined ? {} : { input }) });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  try {
    run(["read-tree", base]);
    // --index-info needs no work tree, which a bare mirror lacks: mode 0 removes an entry.
    const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) =>
      content === null ? `0 ${"0".repeat(40)}\t${path}` : `100644 ${run(["hash-object", "-w", "--stdin"], content)}\t${path}`);
    if (entries.length > 0) run(["update-index", "--index-info"], `${entries.join("\n")}\n`);
    return run(["commit-tree", run(["write-tree"]), "-p", base, "-m", message]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface Proposal {
  repo: string;
  /** The target's mirror, which holds the commit. */
  mirror: string;
  remote: string;
  branch: string;
  commit: string;
  /** The target's default branch, the PR's base. */
  baseBranch: string;
  title: string;
  body: string;
  github: GitHub;
  auth: GitAuth | null;
  /** Each side effect, as it is about to happen and once it has. */
  journal: (entry: Record<string, unknown>) => void;
  /** Marks the instants between steps (kill-point tests). */
  probe?: (point: string) => void;
}

/** Pushes the commit to its branch and opens its PR, each only if it is not there yet; returns the PR. */
export async function propose(p: Proposal): Promise<PullRequest> {
  if (remoteBranchSha(p.mirror, p.remote, p.branch, p.auth) !== p.commit) {
    p.journal({ step: "push", intent: true, branch: p.branch, commit: p.commit });
    git(p.mirror, ["-c", "core.hooksPath=/dev/null", "push", "--quiet", "--force", p.remote, `${p.commit}:refs/heads/${p.branch}`], { env: authEnv(p.remote, p.auth) });
    p.journal({ step: "push", done: true, branch: p.branch, commit: p.commit });
  }
  p.probe?.("pushed");
  const existing = (await p.github.pullRequests(p.repo, p.branch)).find((pr) => pr.state === "open" || (pr.merged && pr.headSha === p.commit));
  if (existing !== undefined) return existing;
  p.journal({ step: "pull_request", intent: true, branch: p.branch });
  const pr = await p.github.createPullRequest({ repo: p.repo, head: p.branch, base: p.baseBranch, title: p.title, body: p.body, draft: false });
  p.journal({ step: "pull_request", done: true, number: pr.number, url: pr.url });
  return pr;
}
