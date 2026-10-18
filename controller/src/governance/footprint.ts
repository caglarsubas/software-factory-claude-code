// A target's governance footprint (P2-05b): the files the factory needs on a target's default
// branch, and the rulesets that make its checks binding.
//
//   .factory/policy.yaml              the App, the approvers, protected and restricted paths (policy-check reads it from the base)
//   .factory/gates.yaml               the profile's commands and gate adapters (the gates job reads it)
//   .github/workflows/factory-gates.yml   the gates on pull_request, from the pinned release
//   .github/workflows/policy-check.yml    policy-check on pull_request_target, from the pinned release
//
// The workflows pin the factory by commit, never by a tag that could move.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { GitHubError } from "../github/client.ts";
import { REPO_ROOT } from "../policy/load.ts";
import type { Tier } from "../policy/engine.ts";
import type { Validator } from "../schemas/validate.ts";
import type { TargetPolicy } from "./policy-check.ts";

const TEMPLATES = join(REPO_ROOT, "profiles/template/footprint");
export const RULESET_NAMES = ["factory-main", "factory-branches"] as const;
/** The checks factory-main requires, each from GitHub Actions: what factoryctl waits for before it merges. */
export const REQUIRED_CHECKS = ["gates", "policy-check"] as const;
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The parts of a target profile the footprint is made from. */
export interface FootprintProfile {
  target: { repo: string };
  commands: Record<string, string>;
  gates: { adapters: string[]; sast_rules?: string[] };
  protected_paths: { glob: string; minimum_risk: Tier; note?: string }[];
  restricted: { glob: string; note?: string }[];
  governance?: { approvers: string[] };
}

export interface FootprintInput {
  profile: FootprintProfile;
  appId: number;
  /** This repository on GitHub, owner/name. */
  factoryRepo: string;
  /** The release commit the workflows run. */
  factoryRef: string;
  /** The release's tag, as a comment beside the commit. */
  factoryTag: string;
  validator: Validator;
}

export class FootprintError extends Error {}

const HEADER = "# Written by the software factory's footprint (P2-05b): change it through the factory's profile, not here.\n";

/** Path → content of every footprint file, ready to commit on the target's default branch. */
export function renderFootprint(i: FootprintInput): Record<string, string> {
  if (!/^[0-9a-f]{40}$/.test(i.factoryRef)) throw new FootprintError(`the factory ref must be a full commit SHA, not ${i.factoryRef}`);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(i.factoryRepo)) throw new FootprintError(`not a repository: ${i.factoryRepo}`);
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(i.factoryTag)) throw new FootprintError(`not a release tag: ${i.factoryTag}`);
  const approvers = i.profile.governance?.approvers;
  if (approvers === undefined) throw new FootprintError(`${i.profile.target.repo}'s profile names no governance.approvers`);
  const policy: TargetPolicy = { schema_version: 1, app_id: i.appId, approvers, protected_paths: i.profile.protected_paths, restricted: i.profile.restricted };
  const valid = i.validator.validate("target-policy.schema.json", policy);
  if (!valid.valid) throw new FootprintError(`the target policy for ${i.profile.target.repo}: ${valid.errors.join("; ")}`);
  const workflow = (name: string): string =>
    readFileSync(join(TEMPLATES, name), "utf8").replaceAll("@FACTORY_REPO@", i.factoryRepo).replaceAll("@FACTORY_REF@", i.factoryRef).replaceAll("@FACTORY_TAG@", i.factoryTag);
  return {
    ".factory/policy.yaml": HEADER + stringify(policy),
    ".factory/gates.yaml": HEADER + stringify({ target: { repo: i.profile.target.repo }, commands: i.profile.commands, gates: i.profile.gates }),
    ".github/workflows/factory-gates.yml": workflow("factory-gates.yml"),
    ".github/workflows/policy-check.yml": workflow("policy-check.yml"),
  };
}

export interface Ruleset {
  name: string;
  [key: string]: unknown;
}

export function footprintRulesets(): Ruleset[] {
  return RULESET_NAMES.map((n) => JSON.parse(readFileSync(join(TEMPLATES, "rulesets", `${n}.json`), "utf8")) as Ruleset);
}

/**
 * Creates or replaces each footprint ruleset on `repo`, by name. Needs a token with
 * Administration: write on the repository, which the factory App never has: the operator's.
 */
export async function applyRulesets(o: { repo: string; token: string; api: string; rulesets?: Ruleset[]; fetchFn?: typeof fetch }): Promise<string[]> {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await (o.fetchFn ?? fetch)(`${o.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new GitHubError(`${method} ${path}: HTTP ${String(res.status)}${res.status === 403 || res.status === 404 ? " (the token needs Administration: write on the repository)" : ""}`);
    return res.json();
  };
  const existing = (await call("GET", `/repos/${o.repo}/rulesets?per_page=100`)) as { id: number; name: string }[];
  const done: string[] = [];
  for (const r of o.rulesets ?? footprintRulesets()) {
    const found = existing.find((e) => e.name === r.name);
    if (found === undefined) {
      await call("POST", `/repos/${o.repo}/rulesets`, r);
      done.push(`created ruleset ${r.name} on ${o.repo}`);
    } else {
      await call("PUT", `/repos/${o.repo}/rulesets/${String(found.id)}`, r);
      done.push(`replaced ruleset ${r.name} (${String(found.id)}) on ${o.repo}`);
    }
  }
  return done;
}
