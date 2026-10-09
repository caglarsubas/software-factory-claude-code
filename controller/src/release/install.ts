// Installing a factory release (ROADMAP §2.4, P0-09). `releases/<sha>/` holds a tagged commit's
// tree, read from the object database like the gates read a candidate, plus its locked runtime
// dependencies, and is read-only once installed. The operator's pin (`current`) selects the
// release that $FACTORY_HOME/bin/factoryctl runs, so tasks on the factory's own repository run
// the last release and a PR never judges itself (§3.3). Only the operator moves the pin.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { commitTime, listTree, writeTar } from "../../../gates/src/tree.ts";
import { treeDigest } from "../digest.ts";
import type { Home } from "../home.ts";
import { loadYaml } from "../policy/load.ts";
import { readReleaseInfo, type FactoryConfig, type ReleaseInfo } from "../release.ts";
import type { Validator } from "../schemas/validate.ts";

export class ReleaseError extends Error {}

const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/;

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout.trim() };
}

/** owner/name from a GitHub remote URL (https, ssh or a proxy that keeps the path); null otherwise. */
export function repositoryOf(url: string): string | null {
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return m === null ? null : `${m[1] ?? ""}/${m[2] ?? ""}`;
}

/** Runtime dependencies from the release's own lockfile: no lifecycle scripts, and copies rather than links into the shared store, so the read-only release owns every file. */
export function pnpmInstall(dir: string): void {
  const r = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prod", "--ignore-scripts", "--package-import-method=copy", "--reporter=append-only"], { cwd: dir, encoding: "utf8", env: { ...process.env, CI: "1" } });
  if (r.status !== 0) throw new ReleaseError(`pnpm install in the release failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-5).join("; ")}`);
}

async function exportTree(source: string, sha: string, dest: string): Promise<string> {
  const entries = listTree(source, sha);
  const tar = spawn("tar", ["-x", "-f", "-", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => tar.on("close", resolve));
  await writeTar(source, entries, commitTime(source, sha), tar.stdin);
  if ((await exited) !== 0) throw new ReleaseError(`tar failed: ${stderr.trim()}`);
  return `sha256:${createHash("sha256").update(entries.map((e) => `${e.mode} ${e.oid} ${e.path}\n`).join("")).digest("hex")}`;
}

/** Post-order, so a non-root operator can still reach every child. */
function makeReadOnly(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) makeReadOnly(join(path, name));
    chmodSync(path, 0o555);
  } else {
    chmodSync(path, st.mode & 0o555);
  }
}

/** Undoes makeReadOnly, so a release can be removed (tests; a future `release remove`). */
export function makeWritable(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  chmodSync(path, st.mode | 0o200);
  if (st.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}

const skipReleaseJson = (rel: string): boolean => rel === "RELEASE.json";

export interface InstallInputs {
  home: Home;
  /** The operator's checkout of the factory repository, which holds the tag. */
  source: string;
  tag: string;
  by: string;
  validator: Validator;
  installDeps?: (dir: string) => void;
  now?: Date;
}

export interface Installed {
  dir: string;
  info: ReleaseInfo;
  /** false when the release was already installed and intact. */
  installed: boolean;
}

export async function installRelease(i: InstallInputs): Promise<Installed> {
  if (!TAG.test(i.tag)) throw new ReleaseError(`a release is a version tag like v0.1.0, not ${JSON.stringify(i.tag)}`);
  const resolved = git(i.source, ["rev-parse", "--verify", "--quiet", `refs/tags/${i.tag}^{commit}`]);
  if (!resolved.ok || !SHA.test(resolved.out)) throw new ReleaseError(`${i.tag} is not a tag in ${i.source}; fetch it first (git fetch --tags)`);
  const sha = resolved.out;
  const dir = join(i.home.releases, sha);
  if (existsSync(join(dir, "RELEASE.json"))) {
    const v = verifyRelease(dir, i.validator);
    if (!v.ok) throw new ReleaseError(`${dir} exists but was modified after install (${v.detail}); remove it by hand and install again`);
    if (v.info.tag !== i.tag) throw new ReleaseError(`${sha.slice(0, 12)} is already installed as ${v.info.tag}; one commit is one release`);
    return { dir, info: v.info, installed: false };
  }
  mkdirSync(i.home.releases, { recursive: true, mode: 0o700 });
  const tmp = join(i.home.releases, `.tmp-${sha}-${String(process.pid)}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o700 });
  try {
    const treeDigestValue = await exportTree(i.source, sha, tmp);
    (i.installDeps ?? pnpmInstall)(tmp);
    const config = loadYaml(join(tmp, "config/factory.yaml"), "factory-config.schema.json", i.validator) as FactoryConfig;
    const plugin = JSON.parse(readFileSync(join(tmp, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string };
    if (`v${plugin.version}` !== i.tag.replace(/-.*$/, "")) throw new ReleaseError(`${i.tag} carries plugin version ${plugin.version}; the tag and plugin.json must agree`);
    const origin = git(i.source, ["remote", "get-url", "origin"]);
    const files = treeDigest(tmp, skipReleaseJson);
    const info: ReleaseInfo = {
      schema_version: 1,
      sha,
      tag: i.tag,
      repository: origin.ok ? repositoryOf(origin.out) : null,
      installed_at: (i.now ?? new Date()).toISOString(),
      installed_by: i.by,
      tree_digest: treeDigestValue,
      files_digest: files.digest,
      files: files.files,
      plugin_version: plugin.version,
      claude_code: config.claude_code.version,
      agent_sdk: config.claude_code.agent_sdk,
    };
    const check = i.validator.validate("release.schema.json", info);
    if (!check.valid) throw new ReleaseError(`RELEASE.json: ${check.errors.join("; ")}`);
    writeFileSync(join(tmp, "RELEASE.json"), `${JSON.stringify(info, null, 2)}\n`);
    renameSync(tmp, dir);
    makeReadOnly(dir);
    return { dir, info, installed: true };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export interface Verification {
  ok: boolean;
  info: ReleaseInfo;
  detail: string;
}

/** Recomputes the files digest: an installed release is never modified. */
export function checkReleaseFiles(dir: string, info: ReleaseInfo): Verification {
  const now = treeDigest(dir, skipReleaseJson);
  const ok = now.digest === info.files_digest && basename(dir) === info.sha;
  return { ok, info, detail: ok ? `${String(now.files)} files intact` : `files digest ${now.digest}, installed as ${info.files_digest}` };
}

export function verifyRelease(dir: string, validator: Validator): Verification {
  const info = readReleaseInfo(dir, validator);
  if (info === null) throw new ReleaseError(`${dir} has no RELEASE.json`);
  return checkReleaseFiles(dir, info);
}

export function listReleases(home: Home, validator: Validator): ReleaseInfo[] {
  if (!existsSync(home.releases)) return [];
  return readdirSync(home.releases)
    .filter((name) => SHA.test(name))
    .flatMap((name) => {
      const info = readReleaseInfo(join(home.releases, name), validator);
      return info === null ? [] : [info];
    })
    .sort((a, b) => a.installed_at.localeCompare(b.installed_at));
}

/** The pinned release's commit, or null when nothing is pinned. */
export function pinnedSha(home: Home): string | null {
  if (!existsSync(home.current)) return null;
  const sha = basename(readlinkSync(home.current));
  return SHA.test(sha) ? sha : null;
}

/** Points `current` at an installed release, atomically; returns the previous pin. */
export function pinRelease(home: Home, sha: string): string | null {
  if (!SHA.test(sha) || !existsSync(join(home.releases, sha, "RELEASE.json"))) throw new ReleaseError(`no installed release ${sha}`);
  const previous = pinnedSha(home);
  const tmp = `${home.current}.tmp-${String(process.pid)}`;
  rmSync(tmp, { force: true });
  symlinkSync(join("releases", sha), tmp);
  renameSync(tmp, home.current);
  return previous;
}

/** $FACTORY_HOME/bin/factoryctl: runs factoryctl from the pinned release. */
export function writeShim(home: Home): string {
  mkdirSync(home.bin, { recursive: true, mode: 0o700 });
  const path = join(home.bin, "factoryctl");
  const quoted = `'${home.root.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "# factoryctl from the pinned release ($FACTORY_HOME/current), written by `factoryctl release install`.",
      `FACTORY_HOME="\${FACTORY_HOME:-${quoted}}"`,
      "export FACTORY_HOME",
      'exec node --disable-warning=ExperimentalWarning "$FACTORY_HOME/current/controller/src/cli/factoryctl.ts" "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

/** A tag or a commit prefix of an installed release. */
export function findRelease(home: Home, validator: Validator, ref: string): ReleaseInfo {
  const matches = listReleases(home, validator).filter((r) => r.tag === ref || (ref.length >= 7 && r.sha.startsWith(ref)));
  const only = matches[0];
  if (only === undefined || matches.length > 1) throw new ReleaseError(matches.length === 0 ? `no installed release matches ${ref}` : `${ref} matches more than one release`);
  return only;
}
