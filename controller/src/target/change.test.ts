// The operator's changes to a target (P2-11): the commit is the same every time it is built, and
// a run killed between the push and the PR ends, when run again, with one push and one PR.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "../cli/testing.ts";
import { memoryGitHub } from "../github/testing.ts";
import { buildCommit, CHANGE_IDENTITY, propose } from "./change.ts";

const scratch = mkdtempSync(join(tmpdir(), "change-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A bare remote with one commit on main and a hook that logs every branch update, and its mirror. */
function target(name: string): { remote: string; mirror: string; base: string; pushes: () => string[] } {
  const root = join(scratch, name);
  const seed = join(root, "seed");
  git(scratch, ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "# t\n");
  writeFileSync(join(seed, "CLAUDE.md"), "Use tabs.\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "base"]);
  const remote = join(root, "remote.git");
  git(root, ["clone", "-q", "--bare", seed, remote]);
  const log = join(root, "pushes.log");
  writeFileSync(log, "");
  writeFileSync(join(remote, "hooks/post-receive"), `#!/bin/sh\nwhile read old new ref; do echo "$ref $new" >> '${log}'; done\n`);
  chmodSync(join(remote, "hooks/post-receive"), 0o755);
  const mirror = join(root, "mirror.git");
  git(root, ["clone", "-q", "--mirror", remote, mirror]);
  return { remote, mirror, base: git(mirror, ["rev-parse", "refs/heads/main"]), pushes: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== "") };
}

const AT = "2026-10-22T09:00:00.000Z";

describe("the operator's changes", () => {
  it("builds the same commit from the same base, files, message and date, without a checkout", () => {
    const t = target("build");
    const files = { ".factory/policy.yaml": "a: 1\n", "CLAUDE.md": "Use tabs.\n\nfactory\n", "README.md": null };
    const one = buildCommit(t.mirror, t.base, files, "Add the footprint", AT);
    expect(buildCommit(t.mirror, t.base, { ...files }, "Add the footprint", AT)).toBe(one);
    expect(buildCommit(t.mirror, t.base, files, "Add the footprint", "2026-10-22T09:00:01.000Z")).not.toBe(one);
    expect(git(t.mirror, ["ls-tree", "-r", "--name-only", one]).split("\n")).toEqual([".factory/policy.yaml", "CLAUDE.md"]);
    expect(git(t.mirror, ["show", `${one}:CLAUDE.md`])).toBe("Use tabs.\n\nfactory");
    expect(git(t.mirror, ["log", "-1", "--format=%an <%ae>|%cn|%P", one])).toBe(`${CHANGE_IDENTITY.name} <${CHANGE_IDENTITY.email}>|${CHANGE_IDENTITY.name}|${t.base}`);
    // The mirror's index and refs are untouched.
    expect(git(t.mirror, ["rev-parse", "refs/heads/main"])).toBe(t.base);
  });

  it("pushes once and opens one PR, when a run dies between the push and the PR and runs again", async () => {
    const t = target("kill");
    const gh = memoryGitHub((_, branch) => spawnSync("git", ["-C", t.remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim());
    const commit = buildCommit(t.mirror, t.base, { ".factory/policy.yaml": "a: 1\n" }, "Add the footprint", AT);
    const journal: Record<string, unknown>[] = [];
    const proposal = {
      repo: "example/t", mirror: t.mirror, remote: t.remote, branch: "software-factory/onboard", commit, baseBranch: "main", title: "Onboard", body: "The footprint.", github: gh, auth: null,
      journal: (e: Record<string, unknown>) => {
        journal.push(e);
      },
    };
    await expect(propose({ ...proposal, probe: (p) => {
      if (p === "pushed") throw new Error("killed");
    } })).rejects.toThrow("killed");
    expect(t.pushes()).toEqual([`refs/heads/software-factory/onboard ${commit}`]);
    expect(gh.prs).toEqual([]);
    const pr = await propose(proposal);
    expect(t.pushes()).toHaveLength(1);
    expect(gh.writes).toEqual(["pull_request example/t software-factory/onboard"]);
    expect(pr).toMatchObject({ number: 1, state: "open", headSha: commit });
    // Again: nothing to do. Merged at the same head: still nothing.
    expect(await propose(proposal)).toMatchObject({ number: 1 });
    const merged = gh.prs[0];
    if (merged !== undefined) Object.assign(merged, { state: "closed", merged: true, headSha: commit });
    expect(await propose(proposal)).toMatchObject({ number: 1, merged: true });
    expect(gh.writes).toHaveLength(1);
    expect(journal.map((e) => `${String(e["step"])} ${e["intent"] === true ? "intent" : "done"}`)).toEqual(["push intent", "push done", "pull_request intent", "pull_request done"]);
    // A new commit on the same branch (a confirm after an edit) moves it, and the open PR follows.
    const next = buildCommit(t.mirror, t.base, { ".factory/policy.yaml": "a: 2\n" }, "Add the footprint", AT);
    if (merged !== undefined) Object.assign(merged, { state: "open", merged: false });
    expect(await propose({ ...proposal, commit: next })).toMatchObject({ number: 1, headSha: next });
    expect(t.pushes()).toEqual([`refs/heads/software-factory/onboard ${commit}`, `refs/heads/software-factory/onboard ${next}`]);
  });
});
