// The policy engine: a pure function from diff facts and policy to a risk tier, the
// reviews it requires, and a trace of every rule it evaluated. A model may propose a
// tier; the engine only ever raises it (ROADMAP §3.1, principle 5).
import picomatch from "picomatch";

export const TIERS = ["R0", "R1", "R2", "R3", "Restricted"] as const;
export type Tier = (typeof TIERS)[number];
export type TierAction = "auto_merge" | "approver_and_policy" | "human_required" | "prepare_only";
export type Sink = "code_exec" | "deserialization" | "shell";
export type ReviewKind = "security" | "dependency" | "migration" | "ux";

export interface Condition {
  any_path?: string[];
  dependency_added?: true;
  sink_added?: Sink[];
  diff_lines_gt?: number;
  secret_material?: true;
  graph_reaches_protected_within_hops?: number;
  classification_uncertain?: true;
  operation_requested?: true;
}

export interface Rule {
  when: Condition;
  minimum_risk?: Tier;
  raise_by?: number;
  reviews?: ReviewKind[];
  mode?: "enforce" | "shadow";
  note?: string;
}

export interface RiskPolicy {
  schema_version: 1;
  tiers: Record<Tier, TierAction>;
  baseline: { default: Tier; low_risk: { all_paths: string[]; tier: Tier } };
  manifests: string[];
  rules: Rule[];
}

export interface ChangedFile {
  path: string;
  /** For renames: the old path, which is judged too. */
  previousPath?: string;
  additions: number;
  deletions: number;
}

export interface DiffFacts {
  files: ChangedFile[];
  /** New dynamic-execution sinks reported by the SAST gate. */
  sinksAdded: Sink[];
  secretMaterial: boolean;
  classificationUncertain: boolean;
  operationRequested: boolean;
  /** Code-graph distance from changed nodes to a protected node; null when unknown. */
  graphHopsToProtected: number | null;
  /** The triager's proposal. It can raise the tier, never lower it. */
  proposedTier?: Tier;
}

export interface TraceEntry {
  source: "baseline" | "proposed" | "rule";
  rule?: number;
  note?: string;
  matched: boolean;
  shadow: boolean;
  tierAfter: Tier;
}

export interface Decision {
  tier: Tier;
  action: TierAction;
  reviews: ReviewKind[];
  trace: TraceEntry[];
}

const rank = (t: Tier): number => TIERS.indexOf(t);
const atLeast = (current: Tier, floor: Tier): Tier => (rank(floor) > rank(current) ? floor : current);
const raisedBy = (current: Tier, steps: number): Tier =>
  TIERS[Math.min(rank(current) + steps, TIERS.length - 1)] ?? "Restricted";

// Case-insensitive and dot-aware: `src/Auth/x.ts` and `.hidden/auth/x` must not dodge `**/auth/**`.
const matcher = (globs: string[]) => picomatch(globs, { dot: true, nocase: true });

function changedPaths(files: ChangedFile[]): string[] {
  const paths = files.flatMap((f) => (f.previousPath === undefined ? [f.path] : [f.path, f.previousPath]));
  return paths.map((p) => p.replace(/^\.\//, ""));
}

function conditionHolds(when: Condition, facts: DiffFacts, paths: string[], policy: RiskPolicy): boolean {
  const checks: boolean[] = [];
  if (when.any_path !== undefined) {
    const isMatch = matcher(when.any_path);
    checks.push(paths.some((p) => isMatch(p)));
  }
  if (when.dependency_added !== undefined) {
    const isManifest = matcher(policy.manifests);
    checks.push(paths.some((p) => isManifest(p)));
  }
  if (when.sink_added !== undefined) {
    const wanted = new Set(when.sink_added);
    checks.push(facts.sinksAdded.some((s) => wanted.has(s)));
  }
  if (when.diff_lines_gt !== undefined) {
    const lines = facts.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
    checks.push(lines > when.diff_lines_gt);
  }
  if (when.secret_material !== undefined) checks.push(facts.secretMaterial);
  if (when.classification_uncertain !== undefined) checks.push(facts.classificationUncertain);
  if (when.operation_requested !== undefined) checks.push(facts.operationRequested);
  if (when.graph_reaches_protected_within_hops !== undefined) {
    const hops = facts.graphHopsToProtected;
    checks.push(hops !== null && hops <= when.graph_reaches_protected_within_hops);
  }
  // An empty condition never matches; the schema forbids it anyway.
  return checks.length > 0 && checks.every(Boolean);
}

export function evaluate(facts: DiffFacts, policy: RiskPolicy): Decision {
  const paths = changedPaths(facts.files);
  const trace: TraceEntry[] = [];
  const reviews = new Set<ReviewKind>();

  // An empty file list means the diff facts are missing, so it never qualifies as low risk.
  const isLowRisk = matcher(policy.baseline.low_risk.all_paths);
  const lowRisk = paths.length > 0 && paths.every((p) => isLowRisk(p));
  let tier: Tier = lowRisk ? policy.baseline.low_risk.tier : policy.baseline.default;
  trace.push({ source: "baseline", note: lowRisk ? "all paths low-risk" : "default", matched: true, shadow: false, tierAfter: tier });

  if (facts.proposedTier !== undefined) {
    tier = atLeast(tier, facts.proposedTier);
    trace.push({ source: "proposed", note: `proposed ${facts.proposedTier}`, matched: true, shadow: false, tierAfter: tier });
  }

  policy.rules.forEach((rule, index) => {
    const matched = conditionHolds(rule.when, facts, paths, policy);
    const shadow = rule.mode === "shadow";
    let next = tier;
    if (matched) {
      if (rule.minimum_risk !== undefined) next = atLeast(next, rule.minimum_risk);
      if (rule.raise_by !== undefined) next = raisedBy(next, rule.raise_by);
    }
    if (matched && !shadow) {
      tier = next;
      for (const r of rule.reviews ?? []) reviews.add(r);
    }
    trace.push({
      source: "rule",
      rule: index,
      ...(rule.note === undefined ? {} : { note: rule.note }),
      matched,
      shadow,
      tierAfter: shadow ? next : tier,
    });
  });

  return { tier, action: policy.tiers[tier], reviews: [...reviews].sort(), trace };
}
