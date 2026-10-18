// The factory/verdict check run (P2-05). After the approver, factoryctl posts it on the
// candidate commit as the GitHub App, through the outbox. Its text carries the verdict as
// canonical JSON and the sha256 of exactly that text:
//
//   - the commit judged, the base it was reviewed on, the tier and the decision;
//   - the spec's digest and the digest of every artifact the decision rests on;
//   - the factory release and policy that made it.
//
// policy-check (policy-check.ts) trusts a verdict only from the App, on the PR's head, whose
// digest it recomputes and whose tier is at least the one it computes itself. A copy is committed
// with the run, so the PR's verdict is part of the evidence bundle.
import { createHash } from "node:crypto";
import type { ReviewKind, Tier } from "../policy/engine.ts";

export const VERDICT_CHECK = "factory/verdict";

export interface Verdict {
  schema_version: 1;
  task_id: string;
  repo: string;
  /** The candidate commit: the PR's head when it was judged. */
  head_sha: string;
  /** The base commit the candidate was reviewed against (manifest.json's reviewed_base_commit). */
  base_commit: string;
  tier: Tier;
  /** The approver's decision; a rejected candidate is never published. */
  decision: "approve" | "needs_human";
  reviews: ReviewKind[];
  spec_digest: string;
  /** The latest committed version of every artifact, by path. */
  artifacts: { path: string; digest: string }[];
  factory: { version: string; commit?: string; policy: string };
}

/** JSON with sorted keys and no whitespace: one text per value, so its digest is stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const verdictDigest = (v: Verdict): string => `sha256:${createHash("sha256").update(canonicalJson(v)).digest("hex")}`;

const OPEN = "```json factory-verdict";
const CLOSE = "```";

/** The check run's output: a title and summary for people, the canonical verdict and its digest for policy-check. */
export function renderVerdict(v: Verdict): { title: string; summary: string; text: string } {
  const digest = verdictDigest(v);
  return {
    title: `${v.tier} · ${v.decision === "approve" ? "approved" : "needs a human"} · ${v.head_sha.slice(0, 12)}`,
    summary: [
      `Task ${v.task_id}, judged on ${v.head_sha} against ${v.base_commit}.`,
      `Tier ${v.tier} (the policy engine's), decision ${v.decision} (the approver's), reviewed by ${["code", "security", ...v.reviews.filter((r) => r !== "security")].join(", ")}.`,
      `Factory ${v.factory.version}; verdict digest ${digest}.`,
    ].join("\n\n"),
    text: `${OPEN}\n${canonicalJson(v)}\n${CLOSE}\n\ndigest: ${digest}\n`,
  };
}

export class VerdictParseError extends Error {}

/** The verdict and the digest a check run's text states; the caller recomputes and compares. */
export function parseVerdict(text: string | null): { verdict: Verdict; stated: string; canonical: string } {
  if (text === null) throw new VerdictParseError("the check run has no text");
  const start = text.indexOf(`${OPEN}\n`);
  const end = start === -1 ? -1 : text.indexOf(`\n${CLOSE}`, start + OPEN.length + 1);
  if (start === -1 || end === -1) throw new VerdictParseError("the check run carries no verdict block");
  const canonical = text.slice(start + OPEN.length + 1, end);
  const stated = /^digest: (sha256:[0-9a-f]{64})$/m.exec(text.slice(end))?.[1];
  if (stated === undefined) throw new VerdictParseError("the check run states no digest");
  let verdict: Verdict;
  try {
    verdict = JSON.parse(canonical) as Verdict;
  } catch {
    throw new VerdictParseError("the verdict block is not JSON");
  }
  if ((verdict.schema_version as unknown) !== 1) throw new VerdictParseError(`unknown verdict schema_version ${JSON.stringify(verdict.schema_version)}`);
  return { verdict, stated, canonical };
}
