// Test support for releases: a factory source repository built from this checkout's working
// tree (so tests install the code under test, committed or not), tagged like a release.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../policy/load.ts";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=op@example.invalid", "-c", "user.name=op", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository at `dest` holding this checkout's tracked and unignored files, tagged `tag`; returns the tagged commit. */
export function factorySource(dest: string, tag = "v0.1.0", origin = "https://github.com/example/software-factory.git"): string {
  const files = git(REPO_ROOT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter((f) => f !== "" && existsSync(join(REPO_ROOT, f)));
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
