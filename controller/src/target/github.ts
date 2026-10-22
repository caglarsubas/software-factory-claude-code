// What onboarding and offboarding read from GitHub with the operator's token (P2-11), and how
// they check the factory App's access to a target (ADR 0003): the operator adds or removes the
// repository in the App's installation by hand, and factoryctl verifies it by minting an
// installation token narrowed to that one repository.
import { appTokens, type AppConfig } from "../github/app.ts";
import { caller, GitHubError } from "../github/client.ts";

export interface TargetReads {
  repository(repo: string): Promise<{ defaultBranch: string; visibility: "public" | "private" }>;
  /** Whether a branch protection or a ruleset protects the branch. */
  protectedBranch(repo: string, branch: string): Promise<boolean>;
  /** The login of the token's user: the operator. */
  login(): Promise<string>;
}

export function targetReads(token: string, api: string, fetchFn: typeof fetch = fetch): TargetReads {
  const call = caller(token, api, fetchFn);
  return {
    async repository(repo) {
      const r = (await call("GET", `/repos/${repo}`)) as { default_branch: string; private: boolean };
      return { defaultBranch: r.default_branch, visibility: r.private ? "private" : "public" };
    },
    async protectedBranch(repo, branch) {
      const b = (await call("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`)) as { protected?: boolean };
      if (b.protected === true) return true;
      const rules = (await call("GET", `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`)) as unknown[];
      return rules.length > 0;
    },
    async login() {
      return ((await call("GET", "/user")) as { login: string }).login;
    },
  };
}

/**
 * Whether the App's installation reaches the repository: GitHub mints a token narrowed to it
 * only when it does (422 otherwise).
 */
export async function appAccess(o: { app: AppConfig; api: string; repo: string; fetchFn?: typeof fetch }): Promise<{ installed: boolean; detail: string }> {
  try {
    await appTokens({ app: o.app, api: o.api, repositories: [o.repo.split("/")[1] ?? o.repo], ...(o.fetchFn === undefined ? {} : { fetchFn: o.fetchFn }) }).refresh();
    return { installed: true, detail: `the App's installation ${String(o.app.installationId)} reaches ${o.repo}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("HTTP 422")) return { installed: false, detail: `the App's installation ${String(o.app.installationId)} does not reach ${o.repo}` };
    throw new GitHubError(`the App's access to ${o.repo} could not be checked: ${message}`);
  }
}

/** Where the operator adds or removes a repository in the App's installation. */
export const installationSettings = (app: AppConfig): string => `https://github.com/settings/installations/${String(app.installationId)}`;

/** Deletes the footprint's rulesets by name (offboarding); an absent one counts as removed. Needs Administration: write. */
export async function removeRulesets(o: { repo: string; token: string; api: string; names: readonly string[]; fetchFn?: typeof fetch }): Promise<string[]> {
  const call = caller(o.token, o.api, o.fetchFn ?? fetch);
  const existing = (await call("GET", `/repos/${o.repo}/rulesets?per_page=100`)) as { id: number; name: string }[];
  const done: string[] = [];
  for (const name of o.names) {
    const found = existing.find((r) => r.name === name);
    if (found === undefined) continue;
    const res = await (o.fetchFn ?? fetch)(`${o.api}/repos/${o.repo}/rulesets/${String(found.id)}`, { method: "DELETE", headers: { authorization: `Bearer ${o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
    if (!res.ok && res.status !== 404) throw new GitHubError(`DELETE /repos/${o.repo}/rulesets/${String(found.id)}: HTTP ${String(res.status)}${res.status === 403 ? " (the token needs Administration: write on the repository)" : ""}`);
    done.push(`removed ruleset ${name} (${String(found.id)}) from ${o.repo}`);
  }
  return done;
}
