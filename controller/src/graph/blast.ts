// The code graph's blast radius (ROADMAP P2-13, shadow mode). The gate image builds each
// candidate's graph (graphifyy, gates/src/run.ts) and the pipeline commits it as graph.json;
// this module reads it as untrusted data from the target. It never runs anything and never
// shows the graph to an agent: it maps nodes to their source files, walks the files that depend
// on the changed ones, and counts the hops to the nearest file the policy guards. The policy
// engine's rule on that count is a shadow rule until P3-05 measures it.
import picomatch from "picomatch";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GRAPH_MAX_BYTES, type GraphRecord } from "../../../gates/src/run.ts";
import type { ChangedFile, Decision, RiskPolicy, Tier } from "../policy/engine.ts";

/** The relations that make one file depend on another: graphifyy's DEFAULT_AFFECTED_RELATIONS. */
export const AFFECTED_RELATIONS: ReadonlySet<string> = new Set([
  "calls", "indirect_call", "references", "imports", "imports_from", "dynamic_import", "re_exports",
  "inherits", "extends", "implements", "uses", "mixes_in", "embeds", "defines", "requires",
]);

/** How far the walk goes; the shadow rule asks about 2. */
export const MAX_HOPS = 4;

export class GraphError extends Error {}

/** A graph reduced to files: each file, and the files that depend on it. */
export interface FileGraph {
  files: ReadonlySet<string>;
  /** file → the files with a dependency edge into it. */
  dependents: ReadonlyMap<string, ReadonlySet<string>>;
}

interface RawGraph {
  nodes?: unknown;
  links?: unknown;
  edges?: unknown;
}

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

/**
 * graph.json as node-link JSON (`nodes`, and `links` or `edges`), reduced to files. Nodes map to
 * their `source_file` (an external module has none and drops out); labels are never read.
 */
export function parseGraph(raw: string | Buffer): FileGraph {
  if (Buffer.byteLength(raw) > GRAPH_MAX_BYTES) throw new GraphError(`graph.json is larger than ${String(GRAPH_MAX_BYTES / 1024 / 1024)} MiB`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    throw new GraphError("graph.json is not JSON");
  }
  const g = (parsed !== null && typeof parsed === "object" ? parsed : {}) as RawGraph;
  if (!Array.isArray(g.nodes)) throw new GraphError("graph.json has no nodes");
  const edges: unknown = Array.isArray(g.links) ? g.links : Array.isArray(g.edges) ? g.edges : [];
  const fileOf = new Map<string, string>();
  for (const n of g.nodes as unknown[]) {
    if (n === null || typeof n !== "object") continue;
    const id = str((n as { id?: unknown }).id);
    const file = (n as { source_file?: unknown }).source_file;
    if (id !== null && typeof file === "string" && file !== "") fileOf.set(id, norm(file));
  }
  const dependents = new Map<string, Set<string>>();
  for (const e of edges as unknown[]) {
    if (e === null || typeof e !== "object") continue;
    const { source, target, relation } = e as { source?: unknown; target?: unknown; relation?: unknown };
    if (typeof relation !== "string" || !AFFECTED_RELATIONS.has(relation)) continue;
    const from = fileOf.get(str(source) ?? "");
    const to = fileOf.get(str(target) ?? "");
    if (from === undefined || to === undefined || from === to) continue;
    // `from` depends on `to`: a change to `to` reaches `from`.
    let set = dependents.get(to);
    if (set === undefined) dependents.set(to, (set = new Set()));
    set.add(from);
  }
  return { files: new Set(fileOf.values()), dependents };
}

export interface Blast {
  /** Hops from a changed file to the nearest guarded file: 0 when a changed file is guarded, null when none is in reach. */
  hops: number | null;
  nearest: string | null;
  /** Files the walk reached besides the changed ones, up to the hop where it stopped. */
  reached: number;
}

/** A reverse walk from the changed files (renames' old paths too), up to `maxHops`, to the nearest guarded file. */
export function blastRadius(g: FileGraph, changed: readonly ChangedFile[], guarded: readonly string[], maxHops = MAX_HOPS): Blast {
  const isGuarded = guarded.length === 0 ? (): boolean => false : picomatch([...guarded], { dot: true, nocase: true });
  const start = [...new Set(changed.flatMap((f) => (f.previousPath === undefined ? [f.path] : [f.path, f.previousPath])).map(norm))];
  const seen = new Set(start);
  let frontier = start;
  for (let hop = 0; hop <= maxHops; hop++) {
    const hit = frontier.filter((f) => isGuarded(f)).sort();
    if (hit.length > 0) return { hops: hop, nearest: hit[0] ?? null, reached: seen.size - start.length };
    if (hop === maxHops) break;
    const next: string[] = [];
    for (const f of frontier) {
      for (const d of g.dependents.get(f) ?? []) {
        if (seen.has(d)) continue;
        seen.add(d);
        next.push(d);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return { hops: null, nearest: null, reached: seen.size - start.length };
}

export type GraphStatus = "fresh" | "stale" | "missing" | "error";

/** What the policy step knows from the graph: only a fresh graph gives a hop count. */
export interface GraphFacts {
  status: GraphStatus;
  /** The commit the graph describes, when there is one. */
  commit: string | null;
  hops: number | null;
  nearest: string | null;
  reached: number | null;
  detail?: string;
}

/**
 * The graph's facts for the commit being judged. `record` is gates.json's graph record and
 * `content` the committed graph.json, or null when none was committed.
 */
export function graphFacts(o: { record: GraphRecord | undefined; content: Buffer | null; commit: string; changed: readonly ChangedFile[]; guarded: readonly string[] }): GraphFacts {
  const none = { hops: null, nearest: null, reached: null };
  if (o.record === undefined) return { status: "missing", commit: null, ...none, detail: "the gates kept no graph" };
  if (o.record.status === "error") return { status: "error", commit: o.record.commit, ...none, detail: o.record.detail ?? "the graph was not built" };
  if (o.content === null) return { status: "missing", commit: o.record.commit, ...none, detail: "no graph.json was committed" };
  // A file left by an earlier attempt is not the graph this record describes.
  if (o.record.sha256 !== undefined && createHash("sha256").update(o.content).digest("hex") !== o.record.sha256) return { status: "missing", commit: o.record.commit, ...none, detail: "graph.json is not the file the gates' record names" };
  if (o.record.commit !== o.commit) return { status: "stale", commit: o.record.commit, ...none, detail: `the graph describes ${o.record.commit.slice(0, 12)}, not ${o.commit.slice(0, 12)}` };
  try {
    return { status: "fresh", commit: o.record.commit, ...blastRadius(parseGraph(o.content), o.changed, o.guarded) };
  } catch (e) {
    return { status: "error", commit: o.record.commit, ...none, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** blast.json (schemas/blast.schema.json): one round's or one re-verification's shadow decision, logged per task. */
export interface BlastRecord {
  schema_version: 1;
  task_id: string;
  candidate_commit: string;
  round: number | null;
  drift: number | null;
  graph: { status: GraphStatus; commit: string | null; detail?: string };
  hops: number | null;
  nearest: string | null;
  reached: number | null;
  /** The graph rule (policies/risk.yaml): its threshold, whether it matched, the tier it would give, and the tier enforced. */
  rule: { within: number; matched: boolean; shadow_tier: Tier; enforced_tier: Tier } | null;
}

export function blastRecord(o: { taskId: string; commit: string; round: number | null; drift: number | null; facts: GraphFacts; decision: Decision; risk: RiskPolicy }): BlastRecord {
  const index = o.risk.rules.findIndex((r) => r.when.graph_reaches_protected_within_hops !== undefined);
  const within = o.risk.rules[index]?.when.graph_reaches_protected_within_hops;
  const entry = o.decision.trace.find((t) => t.source === "rule" && t.rule === index);
  const f = o.facts;
  return {
    schema_version: 1,
    task_id: o.taskId,
    candidate_commit: o.commit,
    round: o.round,
    drift: o.drift,
    graph: { status: f.status, commit: f.commit, ...(f.detail === undefined ? {} : { detail: f.detail }) },
    hops: f.hops,
    nearest: f.nearest,
    reached: f.reached,
    rule: within === undefined || entry === undefined ? null : { within, matched: entry.matched, shadow_tier: entry.tierAfter, enforced_tier: o.decision.tier },
  };
}

const TIER_ORDER: readonly Tier[] = ["R0", "R1", "R2", "R3", "Restricted"];

/** Every blast.json of a run directory: each round's, then each re-verification's. */
export function readBlasts(dir: string): BlastRecord[] {
  const read = (path: string): BlastRecord[] => (existsSync(path) ? [JSON.parse(readFileSync(path, "utf8")) as BlastRecord] : []);
  const numbered = (sub: string): number[] => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((n) => /^[0-9]+$/.test(n)).map(Number).sort((a, b) => a - b) : []);
  return [...read(join(dir, "blast.json")), ...numbered("rounds").flatMap((n) => read(join(dir, "rounds", String(n), "blast.json"))), ...numbered("drift").flatMap((k) => read(join(dir, "drift", String(k), "blast.json")))];
}

const raises = (b: BlastRecord): boolean => b.rule !== null && TIER_ORDER.indexOf(b.rule.shadow_tier) > TIER_ORDER.indexOf(b.rule.enforced_tier);

/** One shadow decision, for `factoryctl report T`. */
export function describeBlast(b: BlastRecord): string {
  const where = b.drift === null ? `round ${String(b.round ?? 1)}` : `re-verification ${String(b.drift)}`;
  if (b.graph.status !== "fresh") return `${where}: graph ${b.graph.status}${b.graph.detail === undefined ? "" : ` (${b.graph.detail})`}; no hop count`;
  const reach = b.hops === null ? `no guarded file within ${String(MAX_HOPS)} hops` : b.hops === 0 ? `changes ${b.nearest ?? "a guarded file"} itself` : `${String(b.hops)} hop(s) to ${b.nearest ?? "a guarded file"}`;
  const rule = b.rule === null ? "" : raises(b) ? `; the rule would raise ${b.rule.enforced_tier} to ${b.rule.shadow_tier}` : `; the rule would keep ${b.rule.enforced_tier}`;
  return `${where}: ${reach}${rule}`;
}

/** Counts over many decisions, for `factoryctl report --week`. */
export function shadowCounts(records: readonly BlastRecord[]): { decisions: number; fresh: number; stale: number; missing: number; error: number; matched: number; raised: number } {
  const by = (s: GraphStatus): number => records.filter((b) => b.graph.status === s).length;
  return { decisions: records.length, fresh: by("fresh"), stale: by("stale"), missing: by("missing"), error: by("error"), matched: records.filter((b) => b.rule?.matched === true).length, raised: records.filter(raises).length };
}
