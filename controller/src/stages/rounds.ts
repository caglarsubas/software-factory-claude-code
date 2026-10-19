// Remediation rounds (P1-01): round 1 keeps the run directory's flat layout, and each later
// round's build, gates, reviews and remediation live under rounds/<n>/, with labels (and so
// transcripts and work directories) suffixed -r<n>.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const roundPath = (name: string, round: number): string => (round === 1 ? name : `rounds/${String(round)}/${name}`);
export const roundLabel = (label: string, round: number): string => (round === 1 ? label : `${label}-r${String(round)}`);

/** The last round that committed a build: the candidate the judges, the policy and the PR see. */
export function latestRound(dir: string): number {
  let n = 1;
  while (existsSync(join(dir, roundPath("build.json", n + 1)))) n++;
  return n;
}

// Re-verification on base drift (P2-06): each time the base moved before a merge, the base is
// merged into the candidate and its gates and policy run again under drift/<k>/.
export const driftPath = (name: string, k: number): string => `drift/${String(k)}/${name}`;

/** The last re-verification that committed its drift.json; 0 when the base never moved. */
export function latestDrift(dir: string): number {
  let k = 0;
  while (existsSync(join(dir, driftPath("drift.json", k + 1)))) k++;
  return k;
}
