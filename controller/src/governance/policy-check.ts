// policy-check (P2-05): the required check that decides whether a factory PR may merge, run by
// the target's own pull_request_target workflow. It runs only code from the base branch and the
// pinned factory release, and reads the PR's head as data, never as code:
//
//   - the base branch's .factory/policy.yaml names the factory App, the human approvers and the
//     target's protected and restricted paths;
//   - the tier is computed again from GitHub's own diff and a sink scan of the head's added lines;
//   - the factory/verdict check run must come from that App, on the PR's head, with a digest that
//     matches its verdict and a tier at least the computed one;
//   - a tier the approvals ladder leaves to a human (R2 and above in P2), and anything the
//     approver passed to a human, needs an approving review on the head commit from a listed
//     approver; a prepare_only tier (Restricted) never passes.
//
// Only factory/** heads are held to a verdict: a human's PR is left to human review.
import { parse } from "yaml";
import type { Sink } from "../../../gates/src/findings.ts";
import { evaluate, TIERS, type ChangedFile, type RiskPolicy, type Tier } from "../policy/engine.ts";
import { withProfile } from "../policy/load.ts";
import type { MergeAction } from "../release.ts";
import type { Validator } from "../schemas/validate.ts";
import { parseVerdict, VERDICT_CHECK, verdictDigest, VerdictParseError, type Verdict } from "./verdict.ts";

export const POLICY_FILE = ".factory/policy.yaml";
export const FACTORY_BRANCH_PREFIX = "factory/";

export interface TargetPolicy {
  schema_version: 1;
  /** The factory App whose verdicts count. */
  app_id: number;
  /** GitHub logins whose approving review clears a human_merge tier and needs_human. */
  approvers: string[];
  protected_paths: { glob: string; minimum_risk: Tier; note?: string }[];
  restricted: { glob: string; note?: string }[];
}

export interface PullInfo {
  headRef: string;
  headSha: string;
  /** owner/name of the head's repository: a fork's differs from the base's. */
  headRepo: string;
  baseSha: string;
  state: "open" | "closed";
}

export interface PrFile extends ChangedFile {
  status: string;
  /** GitHub's unified diff for the file; absent for binary or very large files. */
  patch?: string;
}

export interface VerdictRun {
  appId: number | null;
  headSha: string;
  conclusion: string | null;
  text: string | null;
}

export interface Review {
  login: string;
  state: string;
  commitId: string;
}

/** What policy-check reads from GitHub: the Actions token's read access is enough. */
export interface PolicyReads {
  pull(repo: string, number: number): Promise<PullInfo>;
  files(repo: string, number: number): Promise<PrFile[]>;
  verdictRuns(repo: string, sha: string): Promise<VerdictRun[]>;
  reviews(repo: string, number: number): Promise<Review[]>;
  /** A file's content at a commit, or null when it does not exist there. */
  file(repo: string, sha: string, path: string): Promise<string | null>;
}

export interface HeadFile {
  path: string;
  content: string;
  /** New-side line numbers the PR added. */
  added: number[];
}

/** Scans the head's added lines with the release's sink_added rule pack; the content is data. */
export type SinkScanner = (files: readonly HeadFile[]) => Promise<Sink[]>;

export interface PolicyCheckInput {
  repo: string;
  pr: number;
  reads: PolicyReads;
  /** The release's risk policy, before the target's own paths are added. */
  risk: RiskPolicy;
  /** The release's approvals ladder for its current phase: which tiers merge on the verdict alone. */
  ladder: Readonly<Record<Tier, MergeAction>>;
  validator: Validator;
  scanSinks: SinkScanner;
}

export interface PolicyCheckResult {
  conclusion: "success" | "failure";
  title: string;
  /** Why, one line each; the first is the headline. */
  reasons: string[];
  computedTier: Tier | null;
  verdictTier: Tier | null;
}

const rank = (t: Tier): number => TIERS.indexOf(t);
const maxTier = (a: Tier, b: Tier): Tier => (rank(a) >= rank(b) ? a : b);

/** New-side line numbers each `+` line of a unified diff adds. */
export function addedLinesOf(patch: string): number[] {
  const out: number[] = [];
  let line = 0;
  for (const l of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk !== null) {
      line = Number(hunk[1]);
      continue;
    }
    if (l.startsWith("+")) out.push(line++);
    else if (l.startsWith(" ")) line++;
    // "-" lines and "\ No newline" markers do not advance the new side.
  }
  return out;
}

const fail = (title: string, reasons: string[], tiers: { computed?: Tier | null; verdict?: Tier | null } = {}): PolicyCheckResult => ({ conclusion: "failure", title, reasons, computedTier: tiers.computed ?? null, verdictTier: tiers.verdict ?? null });

export async function policyCheck(i: PolicyCheckInput): Promise<PolicyCheckResult> {
  const pull = await i.reads.pull(i.repo, i.pr);
  if (!pull.headRef.startsWith(FACTORY_BRANCH_PREFIX) || pull.headRepo !== i.repo) {
    return { conclusion: "success", title: "not a factory PR", reasons: [`${pull.headRepo}:${pull.headRef} is not a factory branch of ${i.repo}; human review decides`], computedTier: null, verdictTier: null };
  }

  // The base branch's policy: what the PR itself changes in .factory/ has no say over its own check.
  const raw = await i.reads.file(i.repo, pull.baseSha, POLICY_FILE);
  if (raw === null) return fail("no target policy", [`the base commit ${pull.baseSha.slice(0, 12)} has no ${POLICY_FILE}`]);
  const policyData: unknown = parse(raw);
  const valid = i.validator.validate("target-policy.schema.json", policyData);
  if (!valid.valid) return fail("invalid target policy", [`${POLICY_FILE} on the base: ${valid.errors.join("; ")}`]);
  const target = policyData as TargetPolicy;
  const risk = withProfile(i.risk, target);

  // The tier, computed again from GitHub's diff and the head's added lines.
  const files = await i.reads.files(i.repo, i.pr);
  const scanned: HeadFile[] = [];
  for (const f of files) {
    if (f.status === "removed") continue;
    // GitHub sends no patch for a very large diff: every line of the head's file counts as added, so a sink cannot hide there.
    const fromPatch = f.patch === undefined ? null : addedLinesOf(f.patch);
    if (fromPatch !== null && fromPatch.length === 0) continue;
    const content = await i.reads.file(i.repo, pull.headSha, f.path);
    if (content === null) continue;
    scanned.push({ path: f.path, content, added: fromPatch ?? content.split("\n").map((_, k) => k + 1) });
  }
  const sinks = await i.scanSinks(scanned);
  const decision = evaluate({ files, sinksAdded: sinks, secretMaterial: false, classificationUncertain: false, operationRequested: false, graphHopsToProtected: null }, risk);
  const computed = decision.tier;
  const why = decision.trace.filter((t) => t.matched && !t.shadow).map((t) => t.note).filter((n) => n !== undefined);
  const computedLine = `computed tier ${computed}${why.length > 0 ? ` (${why.join("; ")})` : ""}${sinks.length > 0 ? `; sinks added: ${sinks.join(", ")}` : ""}`;

  // The verdict: only the configured App's, on this head.
  const runs = await i.reads.verdictRuns(i.repo, pull.headSha);
  const ours = runs.filter((r) => r.appId === target.app_id);
  const others = runs.length - ours.length;
  const forged = others > 0 ? [`${String(others)} ${VERDICT_CHECK} run(s) on this head from another app or a workflow were ignored`] : [];
  if (ours.length === 0) return fail("no factory verdict", [`no ${VERDICT_CHECK} from app ${String(target.app_id)} on ${pull.headSha.slice(0, 12)}`, ...forged, computedLine], { computed });
  if (ours.length > 1) return fail("conflicting verdicts", [`${String(ours.length)} ${VERDICT_CHECK} runs from the factory App on one head`, computedLine], { computed });
  const [run] = ours as [VerdictRun];
  let verdict: Verdict;
  try {
    const parsed = parseVerdict(run.text);
    verdict = parsed.verdict;
    const recomputed = verdictDigest(verdict);
    if (recomputed !== parsed.stated) return fail("verdict digest mismatch", [`the verdict states ${parsed.stated}, its content digests to ${recomputed}`, computedLine], { computed });
  } catch (e) {
    if (e instanceof VerdictParseError) return fail("unreadable verdict", [e.message, computedLine], { computed });
    throw e;
  }
  const problems: string[] = [];
  if (run.headSha !== pull.headSha || verdict.head_sha !== pull.headSha) problems.push(`the verdict judged ${verdict.head_sha.slice(0, 12)}, the PR's head is ${pull.headSha.slice(0, 12)}`);
  if (verdict.repo !== i.repo) problems.push(`the verdict is for ${verdict.repo}, not ${i.repo}`);
  if (run.conclusion !== "success") problems.push(`the verdict's conclusion is ${run.conclusion ?? "pending"}`);
  if (!TIERS.includes(verdict.tier)) problems.push(`the verdict's tier ${JSON.stringify(verdict.tier)} is not a tier`);
  else if (rank(verdict.tier) < rank(computed)) problems.push(`the verdict's tier ${verdict.tier} is below the computed ${computed}`);
  if (problems.length > 0) return fail("verdict rejected", [...problems, computedLine, ...forged], { computed, verdict: verdict.tier });

  const tier = maxTier(verdict.tier, computed);
  const action = i.ladder[tier];
  if (action === "prepare_only") return fail(`${tier}: prepare only`, [`${tier} changes are prepared for a human and never merged through the factory`, computedLine], { computed, verdict: verdict.tier });
  const needsHuman = action !== "auto_merge" || verdict.decision !== "approve";
  if (needsHuman) {
    // Each approver's latest review counts, and only if it approved this very head.
    const latest = new Map<string, Review>();
    for (const r of await i.reads.reviews(i.repo, i.pr)) if (target.approvers.includes(r.login) && r.state !== "COMMENTED") latest.set(r.login, r);
    const approvedBy = [...latest.values()].filter((r) => r.state === "APPROVED" && r.commitId === pull.headSha).map((r) => r.login);
    const reason = verdict.decision !== "approve" ? "the approver passed it to a human" : `${tier} needs a human`;
    if (approvedBy.length === 0) return fail(`${tier}: waiting for an approver`, [`${reason}: an approving review on ${pull.headSha.slice(0, 12)} from ${target.approvers.join(" or ")}`, computedLine], { computed, verdict: verdict.tier });
    return { conclusion: "success", title: `${tier}: approved by ${approvedBy.join(", ")}`, reasons: [`verdict from the factory App on ${pull.headSha.slice(0, 12)}, tier ${verdict.tier}`, `${reason}; approved by ${approvedBy.join(", ")} on this head`, computedLine], computedTier: computed, verdictTier: verdict.tier };
  }
  return { conclusion: "success", title: `${tier}: verdict holds`, reasons: [`verdict from the factory App on ${pull.headSha.slice(0, 12)}, tier ${verdict.tier}, decision approve`, computedLine, ...forged], computedTier: computed, verdictTier: verdict.tier };
}
