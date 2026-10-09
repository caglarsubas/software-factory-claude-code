// Scanner output → gate outcomes and risk signals. Pure functions over each tool's JSON, so
// every judgement is unit-tested without containers. Summaries name files, lines and rule or
// detector names only: never matched source text, and never a secret.
import { touchesAdded, type AddedLines } from "./diff.ts";

export type Sink = "code_exec" | "deserialization" | "shell";
const SINKS: readonly string[] = ["code_exec", "deserialization", "shell"];

export interface Outcome {
  status: "pass" | "fail" | "error";
  summary: string;
}

const MAX_LISTED = 10;

function list(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join("; ");
  return items.length > MAX_LISTED ? `${shown}; and ${String(items.length - MAX_LISTED)} more` : shown;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Scanner paths are absolute inside the container; map them back to repository paths. */
export function relativeTo(root: string, path: string): string | null {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

export interface SastJudgement {
  outcome: Outcome;
  sinks: Sink[];
}

/**
 * opengrep: `default` findings on added lines fail the gate; `sink_added` findings on added
 * lines become signals. A changed file the engine could not scan is an error, not a pass.
 */
export function judgeSast(stdout: string, exitCode: number | null, added: AddedLines, root: string): SastJudgement {
  const data = parseJson(stdout);
  if (exitCode !== 0 || !isRecord(data)) {
    return { outcome: { status: "error", summary: `opengrep failed (exit ${String(exitCode)})` }, sinks: [] };
  }
  const failures: string[] = [];
  const sinks = new Set<Sink>();
  for (const r of records(data["results"])) {
    const rel = relativeTo(root, str(r["path"]) ?? "");
    const start = num(isRecord(r["start"]) ? r["start"]["line"] : undefined);
    const end = num(isRecord(r["end"]) ? r["end"]["line"] : undefined) ?? start;
    if (rel === null || start === undefined || end === undefined || !touchesAdded(added, rel, start, end)) continue;
    const extra = isRecord(r["extra"]) ? r["extra"] : {};
    const metadata = isRecord(extra["metadata"]) ? extra["metadata"] : {};
    if (metadata["pack"] === "sink_added") {
      const sink = str(metadata["sink"]);
      if (sink !== undefined && SINKS.includes(sink)) sinks.add(sink as Sink);
      else failures.push(`${rel}:${String(start)} sink rule without a known sink kind`);
    } else {
      failures.push(`${rel}:${String(start)} ${str(extra["message"]) ?? str(r["check_id"]) ?? "finding"}`);
    }
  }
  const unscanned = new Set<string>();
  for (const e of records(data["errors"])) {
    const rel = relativeTo(root, str(e["path"]) ?? "");
    if (e["level"] === "error" && rel !== null && added.has(rel)) unscanned.add(rel);
  }
  const sinkList = [...sinks].sort();
  if (unscanned.size > 0) {
    return { outcome: { status: "error", summary: `changed files could not be scanned: ${list([...unscanned].sort())}` }, sinks: sinkList };
  }
  const sinkNote = sinkList.length > 0 ? `; sinks added: ${sinkList.join(", ")}` : "";
  if (failures.length > 0) {
    return { outcome: { status: "fail", summary: `${String(failures.length)} finding(s) on added lines: ${list(failures)}${sinkNote}` }, sinks: sinkList };
  }
  return { outcome: { status: "pass", summary: `no findings on added lines${sinkNote}` }, sinks: sinkList };
}

export interface SecretsJudgement {
  outcome: Outcome;
  secretMaterial: boolean;
}

/** trufflehog (NDJSON, unverified: the scan has no network): any match on an added line fails. */
export function judgeSecrets(stdout: string, exitCode: number | null, added: AddedLines, root: string): SecretsJudgement {
  if (exitCode !== 0) {
    return { outcome: { status: "error", summary: `trufflehog failed (exit ${String(exitCode)})` }, secretMaterial: false };
  }
  const hits: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const r = parseJson(line);
    if (!isRecord(r)) return { outcome: { status: "error", summary: "trufflehog printed output that is not JSON" }, secretMaterial: false };
    const meta = isRecord(r["SourceMetadata"]) && isRecord(r["SourceMetadata"]["Data"]) ? r["SourceMetadata"]["Data"]["Filesystem"] : undefined;
    const file = isRecord(meta) ? str(meta["file"]) : undefined;
    const rel = relativeTo(root, file ?? "");
    if (rel === null) continue;
    const lineNo = isRecord(meta) ? num(meta["line"]) : undefined;
    // Without a line number, a match anywhere in a changed file counts (fail upward).
    const counts = lineNo === undefined || lineNo < 1 ? added.has(rel) : touchesAdded(added, rel, lineNo);
    if (counts) hits.push(`${rel}:${lineNo === undefined ? "?" : String(lineNo)} (${str(r["DetectorName"]) ?? "unknown detector"})`);
  }
  if (hits.length > 0) {
    return { outcome: { status: "fail", summary: `${String(hits.length)} possible secret(s) on added lines: ${list(hits)}` }, secretMaterial: true };
  }
  return { outcome: { status: "pass", summary: "no secrets on added lines" }, secretMaterial: false };
}

/**
 * osv-scanner over the candidate and the base lockfiles in one run: the gate fails on a known
 * vulnerability the change introduced, keyed by lockfile, package and advisory.
 */
export function judgeDependencies(stdout: string, exitCode: number | null, candidateRoot: string, baseRoot: string): Outcome {
  if (exitCode === 128) return { status: "pass", summary: "no lockfiles to audit" };
  const data = parseJson(stdout);
  if ((exitCode !== 0 && exitCode !== 1) || !isRecord(data)) {
    return { status: "error", summary: `osv-scanner failed (exit ${String(exitCode)})` };
  }
  const base = new Set<string>();
  const candidate = new Map<string, string>();
  for (const result of records(data["results"])) {
    const path = str(isRecord(result["source"]) ? result["source"]["path"] : undefined) ?? "";
    const inBase = relativeTo(baseRoot, path);
    const inCandidate = relativeTo(candidateRoot, path);
    for (const p of records(result["packages"])) {
      const pkg = isRecord(p["package"]) ? p["package"] : {};
      const name = str(pkg["name"]) ?? "?";
      const label = `${name}@${str(pkg["version"]) ?? "?"}`;
      for (const v of records(p["vulnerabilities"])) {
        const key = `${inBase ?? inCandidate ?? path}|${str(pkg["ecosystem"]) ?? ""}|${name}|${str(v["id"]) ?? ""}`;
        if (inBase !== null) base.add(key);
        else if (inCandidate !== null) candidate.set(key, `${label} ${str(v["id"]) ?? "?"} (${inCandidate})`);
      }
    }
  }
  const introduced = [...candidate].filter(([key]) => !base.has(key)).map(([, label]) => label).sort();
  if (introduced.length > 0) {
    return { status: "fail", summary: `${String(introduced.length)} known vulnerability(ies) introduced: ${list(introduced)}` };
  }
  return { status: "pass", summary: "no known vulnerabilities introduced" };
}
