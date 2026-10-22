// The private store (ROADMAP §10, ADR 0003): one directory per onboarded target under
// `$FACTORY_HOME/targets/<owner>__<name>/`, holding
//
//   target.json      its onboarding record (schemas/target.schema.json)
//   profile.yaml     its profile, drafted by `onboard` and edited by the operator
//   inventory.json   what onboarding found in it (schemas/inventory.schema.json)
//   journal.ndjson   every onboarding step and side effect, one line each, for audit
//
// The replica copies it; only an offboarding purge deletes it.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256, writeAtomic } from "../fsutil.ts";
import type { Home } from "../home.ts";
import type { Validator } from "../schemas/validate.ts";

export type TargetState = "drafted" | "confirmed" | "proposed" | "merged" | "active" | "offboarding";

export interface LayerRecord {
  created: string[];
  blocks: string[];
  settings: string[];
}

export interface AdmissionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Admission {
  at: string;
  head: string;
  profile_digest: string;
  passed: boolean;
  checks: AdmissionCheck[];
}

/** A confirmed change, without what it wrote. */
export interface Change {
  at: string;
  by: string;
  profile_digest: string;
  release: { repo: string; sha: string; tag: string };
  branch: string;
  base: string;
  commit: string;
}

export interface Confirmed extends Change {
  layer: LayerRecord;
  /** An update's record of the change it replaces, until the update merges or its PR is closed. */
  replaces?: Change;
}

/** The change alone, as `replaces` keeps it. */
export const changeOf = (c: Change): Change => ({ at: c.at, by: c.by, profile_digest: c.profile_digest, release: c.release, branch: c.branch, base: c.base, commit: c.commit });

export interface TargetRecord {
  schema_version: 1;
  repo: string;
  remote: string;
  default_branch: string;
  state: TargetState;
  created_at: string;
  updated_at: string;
  admission?: Admission;
  confirmed?: Confirmed;
  pr?: { number: number; url: string };
  active?: { at: string; rulesets: string[] };
  offboard?: Offboard;
}

/** Offboarding, step by step: each recorded once done. */
export interface Offboard {
  at: string;
  by: string;
  reason?: string;
  local_only: boolean;
  app?: { at: string; detail: string };
  rulesets?: { at: string; removed: string[] };
  change?: { branch: string; base: string; commit: string; files: string[] };
  pr?: { number: number; url: string };
  cleaned?: { at: string; detail: string };
  purge?: { at: string; journal: string; tasks: string[]; titles: string[]; budgets_before: Record<string, number> };
}

export class RegistryError extends Error {}

export const targetSlug = (repo: string): string => repo.replace("/", "__");
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** The target's directory: one path component under `targets/`, whatever the operator typed. */
export function targetDir(home: Home, repo: string): string {
  if (!REPO.test(repo)) throw new RegistryError(`not a repository: ${repo} (owner/name)`);
  return join(home.targets, targetSlug(repo));
}
export const profileFile = (home: Home, repo: string): string => join(targetDir(home, repo), "profile.yaml");
export const inventoryFile = (home: Home, repo: string): string => join(targetDir(home, repo), "inventory.json");
const recordFile = (home: Home, repo: string): string => join(targetDir(home, repo), "target.json");

/** The profile's digest, as admission and confirmation record it: an edit after either shows. */
export const profileDigest = (home: Home, repo: string): string => sha256(readFileSync(profileFile(home, repo)));

export function readTarget(home: Home, repo: string, validator: Validator): TargetRecord | null {
  const path = recordFile(home, repo);
  if (!existsSync(path)) return null;
  const record: unknown = JSON.parse(readFileSync(path, "utf8"));
  const check = validator.validate("target.schema.json", record);
  if (!check.valid) throw new RegistryError(`${path}: ${check.errors.join("; ")}`);
  return record as TargetRecord;
}

export function writeTarget(home: Home, record: TargetRecord, validator: Validator): void {
  const check = validator.validate("target.schema.json", record);
  if (!check.valid) throw new RegistryError(`the record for ${record.repo}: ${check.errors.join("; ")}`);
  mkdirSync(targetDir(home, record.repo), { recursive: true, mode: 0o700 });
  writeAtomic(recordFile(home, record.repo), `${JSON.stringify(record, null, 2)}\n`);
}

/** Every target in the store, by repository. */
export function listTargets(home: Home, validator: Validator): TargetRecord[] {
  if (!existsSync(home.targets)) return [];
  return readdirSync(home.targets).sort().flatMap((slug) => {
    const repo = slug.replace("__", "/");
    const r = readTarget(home, repo, validator);
    return r === null ? [] : [r];
  });
}

/**
 * An onboarded target's profile, as the operator confirmed it: refused while onboarding is not
 * finished, or when the profile changed since (an --update proposes the change first).
 */
export function activeProfile(home: Home, repo: string, validator: Validator): { path: string; record: TargetRecord } {
  const record = readTarget(home, repo, validator);
  if (record === null) throw new RegistryError(`${repo} is not onboarded: factoryctl onboard ${repo}`);
  if (record.state !== "active") throw new RegistryError(`${repo} is ${record.state}, not active: factoryctl onboard ${repo} takes it further`);
  if (!existsSync(profileFile(home, repo))) throw new RegistryError(`${profileFile(home, repo)} is missing: restore it from the replica, or onboard ${repo} again`);
  if (record.confirmed?.profile_digest !== profileDigest(home, repo)) throw new RegistryError(`${profileFile(home, repo)} changed since it was confirmed: factoryctl onboard ${repo} --update proposes the change`);
  return { path: profileFile(home, repo), record };
}

/** One audit line in the target's journal. */
export function journal(home: Home, repo: string, entry: Record<string, unknown>, now: Date = new Date()): void {
  mkdirSync(targetDir(home, repo), { recursive: true, mode: 0o700 });
  appendFileSync(join(targetDir(home, repo), "journal.ndjson"), `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
}
