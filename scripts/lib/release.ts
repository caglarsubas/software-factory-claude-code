// Release rules (ROADMAP P1-09): a release is a version tag that equals plugin.json's version
// and has its own section in CHANGELOG.md, whose text becomes the GitHub release notes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Section {
  version: string;
  date: string | null;
  body: string;
}

const HEADING = /^## \[([^\]]+)\](?: - ([0-9]{4}-[0-9]{2}-[0-9]{2}))?\s*$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** The `## [version] - date` sections of a Keep a Changelog file, in file order. */
export function sections(changelog: string): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;
  const lines: string[] = [];
  const flush = (): void => {
    if (current !== null) out.push({ ...current, body: lines.join("\n").trim() });
    lines.length = 0;
  };
  for (const line of changelog.split("\n")) {
    const m = HEADING.exec(line);
    if (m !== null) {
      flush();
      current = { version: m[1] ?? "", date: m[2] ?? null, body: "" };
    } else if (current !== null) {
      // Link references at the foot belong to no section.
      if (/^\[[^\]]+\]: /.test(line)) continue;
      lines.push(line);
    }
  }
  flush();
  return out;
}

/** What is wrong with the changelog, the plugin version and (when given) a tag; empty when they agree. */
export function checkRelease(i: { changelog: string; pluginVersion: string; tag?: string }): string[] {
  const problems: string[] = [];
  const all = sections(i.changelog);
  if (all[0]?.version !== "Unreleased") problems.push("CHANGELOG.md must open with an [Unreleased] section");
  const releases = all.filter((s) => s.version !== "Unreleased");
  for (const s of releases) {
    if (!SEMVER.test(s.version)) problems.push(`CHANGELOG.md: [${s.version}] is not a version`);
    if (s.date === null) problems.push(`CHANGELOG.md: [${s.version}] has no date`);
    if (!new RegExp(`^\\[${s.version.replaceAll(".", "\\.")}\\]: https://`, "m").test(i.changelog)) problems.push(`CHANGELOG.md: [${s.version}] has no link reference`);
  }
  const versions = releases.map((s) => s.version);
  if (new Set(versions).size !== versions.length) problems.push("CHANGELOG.md: a version appears twice");
  const mine = releases.find((s) => s.version === i.pluginVersion);
  if (mine === undefined) problems.push(`CHANGELOG.md has no section for plugin.json's version ${i.pluginVersion}`);
  else if (mine.body === "") problems.push(`CHANGELOG.md: [${i.pluginVersion}] is empty`);
  if (releases[0] !== undefined && releases[0].version !== i.pluginVersion) problems.push(`plugin.json's version ${i.pluginVersion} is not the newest release in CHANGELOG.md (${releases[0].version})`);
  if (i.tag !== undefined && i.tag !== `v${i.pluginVersion}`) problems.push(`the tag ${i.tag} does not match plugin.json's version ${i.pluginVersion}`);
  return problems;
}

export function releaseNotes(changelog: string, version: string): string {
  const s = sections(changelog).find((x) => x.version === version);
  if (s === undefined) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return `${s.body}\n`;
}

export function readRelease(root: string): { changelog: string; pluginVersion: string } {
  const plugin = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string };
  return { changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"), pluginVersion: plugin.version };
}
