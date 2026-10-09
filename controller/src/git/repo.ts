// Git for factoryctl: a bare mirror per target, a per-task clone that shares its objects, and
// pushes that only ever happen from the mirror (ROADMAP §1 change 4). Credentials reach the git
// process through GIT_CONFIG_* variables for that one command, never through a file or a
// session's environment, and hooks never run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFile } from "../policy/engine.ts";
import { FACTORY_IDENTITY } from "../session/env.ts";

export class GitError extends Error {}

export interface GitAuth {
  /** A token for https://github.com remotes; unused for local remotes. */
  token: string;
}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

function authEnv(url: string, auth: GitAuth | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
  if (auth === null || !url.startsWith("https://github.com/")) return env;
  const basic = Buffer.from(`x-access-token:${auth.token}`).toString("base64");
  return { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

export function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: opts.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0 && opts.allowFail !== true) throw new GitError(`git ${args.filter((a) => !a.startsWith("AUTHORIZATION")).join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

export const githubRemote = (repo: string): string => `https://github.com/${repo}.git`;
export const mirrorPath = (mirrors: string, repo: string): string => join(mirrors, `${repo.replace("/", "__")}.git`);

/** Clone or refresh the bare mirror of a target; returns its path. */
export function syncMirror(mirrors: string, repo: string, remote: string, auth: GitAuth | null): string {
  const path = mirrorPath(mirrors, repo);
  const env = authEnv(remote, auth);
  if (!existsSync(path)) git(mirrors, ["clone", "--bare", "--quiet", remote, path], { env });
  git(path, ["fetch", "--quiet", "--prune", remote, "+refs/heads/*:refs/heads/*"], { env });
  return path;
}

export function resolveCommit(repo: string, rev: string): string {
  return git(repo, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]).trim();
}

/** A task's own clone on branch `branch` at `base`, sharing the mirror's objects. */
export function createTaskClone(mirror: string, dir: string, branch: string, base: string): void {
  git(join(dir, ".."), ["clone", "--shared", "--no-checkout", "--quiet", mirror, dir]);
  git(dir, ["config", "core.hooksPath", "/dev/null"]);
  git(dir, ["checkout", "--quiet", "-b", branch, base]);
}

export function head(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/** Commit everything the builder left uncommitted; returns whether a commit was made. */
export function commitAll(dir: string, message: string): boolean {
  git(dir, ["add", "-A"]);
  if (git(dir, ["status", "--porcelain"]).trim() === "") return false;
  git(dir, [...NO_HOOKS, "-c", `user.name=${FACTORY_IDENTITY.name}`, "-c", `user.email=${FACTORY_IDENTITY.email}`, "commit", "--quiet", "--no-verify", "-m", message]);
  return true;
}

/** Files changed between two commits, with renames resolved, for the policy engine. */
export function changedFiles(dir: string, base: string, candidate: string): ChangedFile[] {
  const out = git(dir, ["diff", "--numstat", "-z", "-M", "--no-ext-diff", base, candidate]);
  const tokens = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i] ?? "";
    if (head === "") continue;
    const [add = "0", del = "0", path = ""] = head.split("\t");
    const count = (n: string): number => (n === "-" ? 0 : Number(n));
    if (path === "") {
      // Rename: "add\tdel\t\0old\0new\0".
      const previousPath = tokens[++i] ?? "";
      const newPath = tokens[++i] ?? "";
      files.push({ path: newPath, previousPath, additions: count(add), deletions: count(del) });
    } else {
      files.push({ path, additions: count(add), deletions: count(del) });
    }
  }
  return files;
}

export function diffPatch(dir: string, base: string, candidate: string, maxBytes: number): string {
  const patch = git(dir, ["diff", "--no-color", "--no-ext-diff", "-M", base, candidate]);
  return patch.length <= maxBytes ? patch : `${patch.slice(0, maxBytes)}\n\n[diff truncated at ${String(maxBytes)} bytes]\n`;
}

/** Bring the task branch into the mirror, then push it from there. */
export function pushFromMirror(mirror: string, clone: string, branch: string, remote: string, auth: GitAuth | null): string {
  git(mirror, ["fetch", "--quiet", clone, `+refs/heads/${branch}:refs/heads/${branch}`]);
  git(mirror, [...NO_HOOKS, "push", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`], { env: authEnv(remote, auth) });
  return resolveCommit(mirror, `refs/heads/${branch}`);
}
