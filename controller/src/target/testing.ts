// Test support for onboarding and offboarding (P2-11): ts-mini with CI of its own, in a bare
// remote whose hook logs every branch update, and a factory checkout tagged with a release.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../cli/testing.ts";
import { buildTargetRepo, loadFixture } from "../fixtures/targets.ts";
import type { Validator } from "../schemas/validate.ts";

export interface TargetRemote {
  remote: string;
  /** The default branch's commit before anything of the factory's. */
  base: string;
  /** Every branch update the remote received, as `ref sha`. */
  pushes: () => string[];
}

/** ts-mini with a CI workflow of its own, as a bare remote under `root` (which must exist). */
export function targetRemote(root: string, validator: Validator): TargetRemote {
  const seed = join(root, "seed");
  buildTargetRepo(loadFixture("ts-mini", validator), seed);
  mkdirSync(join(seed, ".github/workflows"), { recursive: true });
  writeFileSync(join(seed, ".github/workflows/ci.yml"), "on: pull_request\njobs: {}\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "ci"]);
  const remote = join(root, "remote.git");
  git(root, ["clone", "-q", "--bare", seed, remote]);
  const log = join(root, "pushes.log");
  writeFileSync(log, "");
  writeFileSync(join(remote, "hooks/post-receive"), `#!/bin/sh\nwhile read old new ref; do echo "$ref $new" >> '${log}'; done\n`);
  chmodSync(join(remote, "hooks/post-receive"), 0o755);
  return { remote, base: git(remote, ["rev-parse", "refs/heads/main"]), pushes: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== "") };
}

/** A factory checkout whose origin is on GitHub and whose `tag` names its one commit, as --factory-ref resolves it. */
export function factorySource(dir: string, tag: string): { dir: string; sha: string } {
  git(join(dir, ".."), ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "factory\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "release"]);
  git(dir, ["tag", tag]);
  git(dir, ["remote", "add", "origin", "https://github.com/example/factory.git"]);
  return { dir, sha: git(dir, ["rev-parse", "HEAD"]) };
}
