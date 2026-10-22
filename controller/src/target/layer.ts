// The onboarding layer (ROADMAP §2.7, P2-11): what onboarding writes into a target besides the
// governance footprint, for the people who work in it.
//
//   CODEOWNERS                        a marked block: the approvers own every R3 and Restricted path and the factory's own files
//   CLAUDE.md                         a marked section: how the factory works in this repository
//   .claude/rules/factory-invariants.md   a file the factory owns: the profile's invariants
//   .claude/settings.json             the factory's marketplace and its plugin, enabled for the repository
//
// Each is merged into what the target already has, and recorded, so offboarding takes out
// exactly what onboarding put in and leaves the rest byte for byte. Pure functions: the caller
// reads the target's files and commits the result.
import type { RiskPolicy, Tier } from "../policy/engine.ts";
import type { LayerRecord } from "./registry.ts";

export class LayerError extends Error {}

export const INVARIANTS_FILE = ".claude/rules/factory-invariants.md";
export const SETTINGS_FILE = ".claude/settings.json";
const OWNED_HEADER = "<!-- Written by the software factory's onboarding (P2-11): change it through the target's profile, not here. -->\n";

const MD = { begin: "<!-- BEGIN software-factory -->", end: "<!-- END software-factory -->" };
const HASH = { begin: "# BEGIN software-factory", end: "# END software-factory" };

/** The factory's plugin and its marketplace, as `claude plugin install` names them. */
export const MARKETPLACE = "software-factory";
export const PLUGIN = "software-factory@software-factory";

interface Markers {
  begin: string;
  end: string;
}

function find(text: string, m: Markers, file: string): { start: number; end: number } | null {
  const starts = text.split(m.begin).length - 1;
  const ends = text.split(m.end).length - 1;
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) throw new LayerError(`${file}: the factory's block markers were edited (${String(starts)} begin, ${String(ends)} end); fix them by hand first`);
  const start = text.indexOf(m.begin);
  const end = text.indexOf(m.end) + m.end.length;
  if (end < start) throw new LayerError(`${file}: the factory's block markers are out of order; fix them by hand first`);
  return { start, end: text[end] === "\n" ? end + 1 : end };
}

/** Puts the block in place of the factory's old one, or after the file's content with a blank line between. */
export function upsertBlock(text: string | null, block: string, m: Markers, file: string): string {
  const body = `${m.begin}\n${block}${block.endsWith("\n") ? "" : "\n"}${m.end}\n`;
  if (text === null || text === "") return body;
  const at = find(text, m, file);
  if (at !== null) return text.slice(0, at.start) + body + text.slice(at.end);
  return `${text}${text.endsWith("\n") ? "" : "\n"}\n${body}`;
}

/** Takes the factory's block out, with the blank line upsertBlock put before it. */
export function dropBlock(text: string, m: Markers, file: string): string {
  const at = find(text, m, file);
  if (at === null) return text;
  const before = text.slice(0, at.start);
  return (before.endsWith("\n\n") ? before.slice(0, -1) : before) + text.slice(at.end);
}

/** A profile glob as a CODEOWNERS pattern: anchored at the root unless it starts with `**`. */
export function codeownersPattern(glob: string): string[] {
  const brace = /\{([^{}]*)\}/.exec(glob);
  if (brace !== null) return (brace[1] ?? "").split(",").flatMap((alt) => codeownersPattern(glob.replace(brace[0], alt)));
  return [glob.startsWith("**/") || glob.startsWith("/") ? glob : `/${glob}`];
}

export interface LayerInput {
  repo: string;
  profile: {
    protected_paths: { glob: string; minimum_risk: Tier }[];
    restricted: { glob: string }[];
    invariants?: { id: string; text: string; check?: string }[];
    spec_dir: string;
    governance?: { approvers: string[] };
  };
  /** The release's risk policy with the profile's rules in it (withProfile). */
  risk: RiskPolicy;
  release: { repo: string; tag: string };
  /** The footprint's own files: the approvers own them too. */
  footprint: string[];
  /** A file's content on the target's base, or null. */
  existing: (path: string) => string | null;
  /** The settings entries an earlier onboarding added (its record): an update writes them anew, such as the release's ref. */
  owned?: readonly string[];
}

/** The R3 and Restricted globs, the policy's and the profile's, in order and once each. */
function guarded(risk: RiskPolicy): { r3: string[]; restricted: string[] } {
  const of = (tier: Tier): string[] => [...new Set(risk.rules.filter((r) => r.minimum_risk === tier && r.mode !== "shadow").flatMap((r) => r.when.any_path ?? []))];
  return { r3: of("R3"), restricted: of("Restricted") };
}

/** The layer's files, merged into the target's, and the record of what it added. */
export function renderLayer(i: LayerInput): { files: Record<string, string>; record: LayerRecord } {
  const approvers = i.profile.governance?.approvers ?? [];
  if (approvers.length === 0) throw new LayerError(`${i.repo}'s profile names no governance.approvers`);
  const owners = approvers.map((a) => (a.startsWith("@") ? a : `@${a}`)).join(" ");
  const { r3, restricted } = guarded(i.risk);
  const record: LayerRecord = { created: [], blocks: [], settings: [] };
  const files: Record<string, string> = {};

  const codeownersPath = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].find((p) => i.existing(p) !== null) ?? ".github/CODEOWNERS";
  const owned = [...r3, ...restricted, ...i.footprint, INVARIANTS_FILE, SETTINGS_FILE, codeownersPath, "CLAUDE.md"];
  const lines = [...new Set(owned.flatMap(codeownersPattern))].map((p) => `${p} ${owners}`);
  const codeowners = i.existing(codeownersPath);
  files[codeownersPath] = upsertBlock(codeowners, `# The software factory's approvers own these paths (P2-11); the rest of this file is yours.\n${lines.join("\n")}\n`, HASH, codeownersPath);
  record.blocks.push(codeownersPath);
  if (codeowners === null) record.created.push(codeownersPath);

  const list = (globs: string[]): string => (globs.length === 0 ? "none" : globs.map((g) => `\`${g}\``).join(", "));
  const section = [
    "## The software factory",
    "",
    `This repository is a target of the [software factory](https://github.com/${i.release.repo}), release \`${i.release.tag}\`. The factory works on tasks in \`factory/**\` branches and opens their PRs; nothing it does merges without its gates, its \`policy-check\` and, where the tier needs one, a person.`,
    "",
    `- **Needs a person's approval (R3):** ${list(r3)}.`,
    `- **The factory never changes (Restricted):** ${list(restricted)}.`,
    `- **Specs:** \`${i.profile.spec_dir}\`. **Invariants:** \`${INVARIANTS_FILE}\`.`,
    `- **The factory's files** (\`.factory/\`, its two workflows, and the marked blocks here and in CODEOWNERS) change through its profile, not by hand.`,
    "- **In your own sessions:** the `software-factory` plugin, enabled in `.claude/settings.json`, adds the factory's reviewers and `/software-factory:factory-review`. Its hooks run with Node 24.",
    "",
  ].join("\n");
  const claude = i.existing("CLAUDE.md");
  files["CLAUDE.md"] = upsertBlock(claude, section, MD, "CLAUDE.md");
  record.blocks.push("CLAUDE.md");
  if (claude === null) record.created.push("CLAUDE.md");

  const prior = i.existing(INVARIANTS_FILE);
  if (prior !== null && !prior.startsWith(OWNED_HEADER)) throw new LayerError(`${INVARIANTS_FILE} exists and is not the factory's; move it, then onboard again`);
  const invariants = i.profile.invariants ?? [];
  files[INVARIANTS_FILE] = `${OWNED_HEADER}# Invariants\n\n${invariants.length === 0 ? "The profile declares none.\n" : invariants.map((v) => `- **${v.id}:** ${v.text}${v.check === undefined ? "" : ` Checked by \`${v.check}\`.`}`).join("\n") + "\n"}`;
  record.created.push(INVARIANTS_FILE);

  const raw = i.existing(SETTINGS_FILE);
  let settings: Record<string, unknown>;
  try {
    settings = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    throw new LayerError(`${SETTINGS_FILE} is not valid JSON; fix it, then onboard again`);
  }
  if (typeof settings !== "object" || Array.isArray(settings)) throw new LayerError(`${SETTINGS_FILE} is not a JSON object`);
  // An entry already there is the repository's own, unless the factory's record says it added it:
  // the repository's stays as it is, and offboarding leaves it.
  const add = (key: string, entry: string, value: unknown): void => {
    const table = (settings[key] ?? {}) as Record<string, unknown>;
    if (entry in table && !(i.owned ?? []).includes(`${key}.${entry}`)) return;
    settings[key] = { ...table, [entry]: value };
    record.settings.push(`${key}.${entry}`);
  };
  add("extraKnownMarketplaces", MARKETPLACE, { source: { source: "github", repo: i.release.repo, ref: i.release.tag } });
  add("enabledPlugins", PLUGIN, true);
  files[SETTINGS_FILE] = `${JSON.stringify(settings, null, 2)}\n`;
  if (raw === null) record.created.push(SETTINGS_FILE);
  return { files, record };
}

/**
 * What offboarding writes back (null deletes): each block comes out, each settings key the layer
 * added is removed, and a file it created goes when nothing of anyone else's is left in it.
 */
export function removeLayer(record: LayerRecord, existing: (path: string) => string | null): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of record.blocks) {
    const text = existing(path);
    if (text === null) continue;
    const left = dropBlock(text, path.endsWith(".md") ? MD : HASH, path);
    out[path] = record.created.includes(path) && left.trim() === "" ? null : left;
  }
  for (const path of record.created) {
    if (path === SETTINGS_FILE || record.blocks.includes(path) || existing(path) === null) continue;
    out[path] = null;
  }
  const raw = existing(SETTINGS_FILE);
  if (raw !== null && record.settings.length > 0) {
    // "table.entry", where an entry (a plugin id) may itself hold dots: the table is up to the first.
    const added = new Map<string, Set<string>>();
    for (const key of record.settings) {
      const table = key.slice(0, key.indexOf("."));
      added.set(table, (added.get(table) ?? new Set()).add(key.slice(key.indexOf(".") + 1)));
    }
    const settings = Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, unknown>).flatMap(([table, value]) => {
      const entries = added.get(table);
      if (entries === undefined || typeof value !== "object" || value === null) return [[table, value]];
      const kept = Object.fromEntries(Object.entries(value).filter(([entry]) => !entries.has(entry)));
      return Object.keys(kept).length === 0 ? [] : [[table, kept]];
    }));
    out[SETTINGS_FILE] = record.created.includes(SETTINGS_FILE) && Object.keys(settings).length === 0 ? null : `${JSON.stringify(settings, null, 2)}\n`;
  }
  return out;
}

/** Whether a path is one the layer would put a block of the factory's in, and the block is there. */
export function hasBlock(text: string, path: string): boolean {
  return find(text, path.endsWith(".md") ? MD : HASH, path) !== null;
}

