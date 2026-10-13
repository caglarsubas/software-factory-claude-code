// Fingerprints for remediation (ROADMAP P1-01, principle 9): the same finding twice stops the
// task. A review finding is identified by its file, category and title; a gate failure by its
// gate and the first line of its error. Both are normalised first, so a line number, a count
// or a hash that moved between rounds does not make an old failure look new.
import { createHash } from "node:crypto";

/** Lower case, numbers and hex runs folded to `#`, punctuation dropped, whitespace collapsed. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, "#")
    .replace(/[0-9]+/g, "#")
    .replace(/[^a-z#\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const short = (parts: string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);

export function findingFingerprint(f: { file: string; category: string; title: string }): string {
  return `finding:${short([f.file, f.category, normalise(f.title)])}`;
}

/** The first non-empty line of a gate's summary is its error. */
export function gateFingerprint(g: { name: string; summary: string }): string {
  const first = g.summary.split("\n").find((l) => l.trim() !== "") ?? "";
  return `gate:${short([g.name, normalise(first)])}`;
}
