// Release install (P0-09: "tag v0.1.0 installed to releases/"): a tagged commit's tree, read-only,
// verified by digest, pinned by the operator, and run through $FACTORY_HOME/bin/factoryctl.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureHome, factoryHome } from "../home.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { findRelease, installRelease, listReleases, makeWritable, pinnedSha, pinRelease, repositoryOf, verifyRelease, writeShim } from "./install.ts";
import { bumpRelease, factorySource, linkDeps } from "./testing.ts";

const validator = createValidator();
const root = mkdtempSync(join(tmpdir(), "release-"));
afterAll(() => {
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
});

const source = join(root, "source");
const sha = factorySource(source);
const home = factoryHome({ FACTORY_HOME: join(root, "factory") });
ensureHome(home);
const install = (tag: string, installDeps: (dir: string) => void = () => undefined) => installRelease({ home, source, tag, by: "operator", validator, installDeps });

describe("release install", () => {
  it("installs the tagged commit's tree read-only, with a valid RELEASE.json", async () => {
    const r = await install("v0.1.0", linkDeps);
    expect(r).toMatchObject({ dir: join(home.releases, sha), installed: true });
    expect(validator.validate("release.schema.json", JSON.parse(readFileSync(join(r.dir, "RELEASE.json"), "utf8"))).errors).toEqual([]);
    expect(r.info).toMatchObject({ sha, tag: "v0.1.0", repository: "example/software-factory", installed_by: "operator", plugin_version: "0.1.0" });
    // Exactly the commit's files: the working tree's untracked and ignored files never ship.
    const tracked = spawnSync("git", ["-C", source, "ls-files"], { encoding: "utf8" }).stdout.trim().split("\n");
    for (const f of tracked.slice(0, 50)) expect(existsSync(join(r.dir, f)), f).toBe(true);
    expect(existsSync(join(r.dir, ".git"))).toBe(false);
    for (const f of ["RELEASE.json", "controller/src/cli/factoryctl.ts", "plugin/hooks/guard.ts"]) expect(lstatSync(join(r.dir, f)).mode & 0o222, f).toBe(0);
    expect(lstatSync(join(r.dir, "controller")).mode & 0o222).toBe(0);
    expect(verifyRelease(r.dir, validator)).toMatchObject({ ok: true });
    expect(loadRelease(validator, r.dir).info).toEqual(r.info);
  });

  it("installs once, and refuses to reuse a release that was modified", async () => {
    expect((await install("v0.1.0")).installed).toBe(false);
    const file = join(home.releases, sha, "policies/risk.yaml");
    makeWritable(file);
    writeFileSync(file, `${readFileSync(file, "utf8")}# edited\n`);
    expect(verifyRelease(join(home.releases, sha), validator)).toMatchObject({ ok: false });
    await expect(install("v0.1.0")).rejects.toThrow(/modified after install/);
    writeFileSync(file, readFileSync(file, "utf8").replace("# edited\n", ""));
    expect(verifyRelease(join(home.releases, sha), validator)).toMatchObject({ ok: true });
  });

  it("installs only a version tag that agrees with plugin.json", async () => {
    await expect(install("main")).rejects.toThrow(/version tag/);
    await expect(install("v9.9.9")).rejects.toThrow(/not a tag/);
    spawnSync("git", ["-C", source, "tag", "v0.0.9", sha]);
    await expect(install("v0.0.9")).rejects.toThrow(/already installed as v0\.1\.0/);
    spawnSync("git", ["-C", source, "-c", "user.email=op@example.invalid", "-c", "user.name=op", "commit", "-q", "--allow-empty", "-m", "unbumped"]);
    spawnSync("git", ["-C", source, "tag", "v0.2.0"]);
    await expect(install("v0.2.0")).rejects.toThrow(/plugin version 0\.1\.0/);
    expect(listReleases(home, validator).map((r) => r.tag)).toEqual(["v0.1.0"]);
    expect(spawnSync("ls", ["-A", home.releases], { encoding: "utf8" }).stdout.trim()).toBe(sha);
  });

  it("pins a release, moves the pin to another, and finds releases by tag or commit", async () => {
    expect(pinRelease(home, sha)).toBeNull();
    expect(readlinkSync(home.current)).toBe(join("releases", sha));
    const next = bumpRelease(source, "0.1.1");
    await install("v0.1.1");
    expect(pinRelease(home, next)).toBe(sha);
    expect(pinnedSha(home)).toBe(next);
    expect(findRelease(home, validator, "v0.1.0").sha).toBe(sha);
    expect(findRelease(home, validator, sha.slice(0, 12)).tag).toBe("v0.1.0");
    expect(() => findRelease(home, validator, "v7.0.0")).toThrow(/no installed release/);
    expect(() => pinRelease(home, "0".repeat(40))).toThrow(/no installed release/);
    pinRelease(home, sha);
  });

  it("writes a shim that runs factoryctl from the pinned release", { timeout: 60_000 }, () => {
    const shim = writeShim(home);
    expect(readFileSync(shim, "utf8")).toContain('"$FACTORY_HOME/current/controller/src/cli/factoryctl.ts"');
    const r = spawnSync("sh", [shim, "doctor"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: root, FACTORY_HOME: home.root } });
    expect(r.stdout).toMatch(new RegExp(`^ok {4}installed release: v0\\.1\\.0 \\(${sha.slice(0, 12)}\\): [0-9]+ files intact$`, "m"));
    expect(r.stdout).toContain(`plugin 0.1.0 at ${join(home.releases, sha)}`);
  });
});

describe("repositoryOf", () => {
  it.each([
    ["https://github.com/owner/name.git", "owner/name"],
    ["git@github.com:owner/name.git", "owner/name"],
    ["http://proxy@127.0.0.1:8080/git/owner/name", "owner/name"],
    ["/srv/git/plain", "git/plain"],
  ])("%s → %s", (url, repo) => {
    expect(repositoryOf(url)).toBe(repo);
  });
});
