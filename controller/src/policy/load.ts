// Loading and validating policy, config and profile files. A target profile can only
// append rules that raise a tier: protected paths and restricted paths.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createValidator, type Validator } from "../schemas/validate.ts";
import type { RiskPolicy, Rule, Tier } from "./engine.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Policy and config files and the schema each must satisfy. */
export const POLICY_FILES = {
  "policies/risk.yaml": "risk-policy.schema.json",
  "policies/budgets.yaml": "budgets-policy.schema.json",
  "policies/approvals.yaml": "approvals-policy.schema.json",
  "policies/merge.yaml": "merge-policy.schema.json",
  "policies/tools.yaml": "tools-policy.schema.json",
  "config/factory.yaml": "factory-config.schema.json",
} as const;

export interface Profile {
  protected_paths: { glob: string; minimum_risk: Tier; note?: string }[];
  restricted: { glob: string; note?: string }[];
  /** The target's own migration paths bring in the migration reviewer (P2-09), as the default migrations rule does. */
  reviewers?: { migration_paths?: string[] };
}

export class PolicyError extends Error {}

/** Parses a YAML file and validates it; callers narrow the result to the schema's type. */
export function loadYaml(path: string, schema: string, validator: Validator = createValidator()): unknown {
  const data: unknown = parse(readFileSync(path, "utf8"));
  const result = validator.validate(schema, data);
  if (!result.valid) throw new PolicyError(`${path} does not match ${schema}: ${result.errors.join("; ")}`);
  return data;
}

/** The profile's protected and restricted paths become extra rules; they can only raise. */
export function withProfile(policy: RiskPolicy, profile: Profile): RiskPolicy {
  const extra: Rule[] = [
    ...profile.protected_paths.map((p) => ({
      when: { any_path: [p.glob] },
      minimum_risk: p.minimum_risk,
      note: `profile: ${p.note ?? p.glob}`,
    })),
    ...profile.restricted.map((r) => ({
      when: { any_path: [r.glob] },
      minimum_risk: "Restricted" as const,
      note: `profile restricted: ${r.note ?? r.glob}`,
    })),
    ...((profile.reviewers?.migration_paths ?? []).length > 0 ? [{ when: { any_path: profile.reviewers?.migration_paths ?? [] }, minimum_risk: "R3" as const, reviews: ["migration" as const], note: "profile: schema migrations" }] : []),
  ];
  // Profile rules run before the default rules so uncertainty (raise_by) still applies last.
  const firstRaise = policy.rules.findIndex((r) => r.raise_by !== undefined);
  const at = firstRaise === -1 ? policy.rules.length : firstRaise;
  return { ...policy, rules: [...policy.rules.slice(0, at), ...extra, ...policy.rules.slice(at)] };
}

/**
 * The paths the policy guards: every enforced rule's `any_path` that puts a change at R3, or at
 * Restricted. The footprint's CODEOWNERS (P2-11) and the code graph's blast radius (P2-13) read them.
 */
export function protectedGlobs(risk: RiskPolicy): { r3: string[]; restricted: string[] } {
  const of = (tier: Tier): string[] => [...new Set(risk.rules.filter((r) => r.minimum_risk === tier && r.mode !== "shadow").flatMap((r) => r.when.any_path ?? []))];
  return { r3: of("R3"), restricted: of("Restricted") };
}

export function loadRiskPolicy(root: string = REPO_ROOT, profilePath?: string): RiskPolicy {
  const validator = createValidator();
  const policy = loadYaml(join(root, "policies/risk.yaml"), "risk-policy.schema.json", validator) as RiskPolicy;
  if (profilePath === undefined) return policy;
  const profile = loadYaml(profilePath, "profile.schema.json", validator) as Profile;
  return withProfile(policy, profile);
}
