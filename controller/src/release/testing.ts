// Test support for releases: a factory source repository built from this checkout's working
// tree (so tests install the code under test, committed or not), tagged like a release.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../policy/load.ts";

/** The tag a release of this working tree must carry: v<plugin.json version>. */
export const PLUGIN_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string }).version;
export const RELEASE_TAG = `v${PLUGIN_VERSION}`;

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * This checkout's files: git's tracked and unignored files in a work tree. The gates run the
 * suite on an exported commit with no .git, which holds only tracked files, so there every file
 * but the installed dependencies is the same set.
 */
function sourceFiles(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (listed.status === 0) return listed.stdout.split("\0").filter((f) => f !== "" && existsSync(join(REPO_ROOT, f)));
  return readdirSync(REPO_ROOT, { recursive: true, encoding: "utf8" }).filter((f) => !f.split("/").some((part) => part === "node_modules" || part === ".git") && !lstatSync(join(REPO_ROOT, f)).isDirectory());
}

/** A repository at `dest` holding this checkout's tracked and unignored files, tagged `tag`; returns the tagged commit. */
export function factorySource(dest: string, tag = RELEASE_TAG, origin = "https://github.com/example/software-factory.git"): string {
  const files = sourceFiles();
  for (const f of files) {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    cpSync(join(REPO_ROOT, f), join(dest, f), { verbatimSymlinks: true });
  }
  git(dest, ["init", "-q", "-b", "main"]);
  git(dest, ["remote", "add", "origin", origin]);
  git(dest, ["add", "-A"]);
  git(dest, ["commit", "-qm", "factory"]);
  git(dest, ["tag", "-a", tag, "-m", tag]);
  return git(dest, ["rev-parse", "HEAD"]);
}

/** A new commit that bumps plugin.json to `version`, tagged v<version>; returns the commit. */
export function bumpRelease(source: string, version: string): string {
  const path = join(source, "plugin/.claude-plugin/plugin.json");
  writeFileSync(path, readFileSync(path, "utf8").replace(/"version": "[^"]+"/, `"version": "${version}"`));
  git(source, ["commit", "-qam", `release ${version}`]);
  git(source, ["tag", `v${version}`]);
  return git(source, ["rev-parse", "HEAD"]);
}

/** Stand-in for `pnpm install`: link this checkout's installed dependencies into the release. */
export function linkDeps(dir: string): void {
  for (const pkg of ["", "controller", "gates"]) {
    if (existsSync(join(REPO_ROOT, pkg, "node_modules"))) symlinkSync(join(REPO_ROOT, pkg, "node_modules"), join(dir, pkg, "node_modules"));
  }
}
