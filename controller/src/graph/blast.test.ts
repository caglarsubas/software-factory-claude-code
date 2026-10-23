// The blast radius (P2-13): graph.json reduced to files, the reverse walk to the nearest guarded
// file, and the facts the policy step may use, which only a fresh graph gives.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRAPH_MAX_BYTES, type GraphRecord } from "../../../gates/src/run.ts";
import { blastRadius, describeBlast, graphFacts, parseGraph, readBlasts, shadowCounts, MAX_HOPS, type BlastRecord } from "./blast.ts";

const node = (id: string, file: string | null): Record<string, unknown> => ({ id, label: `${id}()`, ...(file === null ? {} : { source_file: file }) });
const link = (source: string, target: string, relation = "calls"): Record<string, unknown> => ({ source, target, relation });

// src/auth/login.ts calls src/session.ts, which imports src/util.ts; src/cli.ts uses login.
const graph = {
  nodes: [node("login", "src/auth/login.ts"), node("session", "./src/session.ts"), node("util", "src/util.ts"), node("cli", "src/cli.ts"), node("react", null), node("helper", "src/util.ts")],
  links: [
    link("login", "session"),
    link("session", "util", "imports_from"),
    link("cli", "login", "uses"),
    link("util", "react", "imports"),
    link("util", "helper", "calls"),
    link("cli", "util", "mentions"),
  ],
};
const raw = JSON.stringify(graph);
const GUARDED = ["src/auth/**", "**/secrets/**"];
const file = (path: string, previousPath?: string) => ({ path, additions: 1, deletions: 0, ...(previousPath === undefined ? {} : { previousPath }) });

describe("parseGraph", () => {
  it("keeps files and dependency edges between files, and nothing else", () => {
    const g = parseGraph(raw);
    expect([...g.files].sort()).toEqual(["src/auth/login.ts", "src/cli.ts", "src/session.ts", "src/util.ts"]);
    // An external module, an edge inside one file and an edge of another kind drop out.
    expect(Object.fromEntries([...g.dependents].map(([k, v]) => [k, [...v].sort()]))).toEqual({
      "src/session.ts": ["src/auth/login.ts"],
      "src/util.ts": ["src/session.ts"],
      "src/auth/login.ts": ["src/cli.ts"],
    });
  });

  it("reads `edges` as `links`, and refuses what is not a graph", () => {
    expect(parseGraph(JSON.stringify({ nodes: graph.nodes, edges: graph.links })).dependents.size).toBe(3);
    expect(() => parseGraph("not json")).toThrow("not JSON");
    expect(() => parseGraph(JSON.stringify({ links: [] }))).toThrow("no nodes");
    expect(() => parseGraph("null")).toThrow("no nodes");
    expect(() => parseGraph(Buffer.alloc(GRAPH_MAX_BYTES + 1, 32))).toThrow("larger than");
  });
});

describe("blastRadius", () => {
  const g = parseGraph(raw);

  it("counts the hops from the changed files to the nearest guarded file that depends on them", () => {
    expect(blastRadius(g, [file("src/util.ts")], GUARDED)).toEqual({ hops: 2, nearest: "src/auth/login.ts", reached: 2 });
    expect(blastRadius(g, [file("src/session.ts")], GUARDED)).toMatchObject({ hops: 1, nearest: "src/auth/login.ts" });
  });

  it("is 0 for a guarded file changed, reads a rename's old path, and is null out of reach", () => {
    expect(blastRadius(g, [file("src/auth/login.ts")], GUARDED)).toEqual({ hops: 0, nearest: "src/auth/login.ts", reached: 0 });
    expect(blastRadius(g, [file("src/moved.ts", "src/session.ts")], GUARDED)).toMatchObject({ hops: 1 });
    // Nothing depends on the CLI, and the walk stops at its limit.
    expect(blastRadius(g, [file("src/cli.ts")], GUARDED)).toEqual({ hops: null, nearest: null, reached: 0 });
    expect(blastRadius(g, [file("src/util.ts")], GUARDED, 1)).toEqual({ hops: null, nearest: null, reached: 1 });
    expect(blastRadius(g, [file("src/util.ts")], [])).toMatchObject({ hops: null });
  });

  it("ends on a cycle, and matches guarded paths as the policy engine does", () => {
    const cyclic = parseGraph(JSON.stringify({ nodes: [node("a", "a.ts"), node("b", "b.ts"), node("s", "x/Secrets/key.ts")], links: [link("a", "b"), link("b", "a"), link("s", "b")] }));
    expect(blastRadius(cyclic, [file("a.ts")], GUARDED)).toEqual({ hops: 2, nearest: "x/Secrets/key.ts", reached: 2 });
    expect(MAX_HOPS).toBe(4);
  });
});

describe("graphFacts", () => {
  const commit = "c".repeat(40);
  const record = (over: Partial<GraphRecord> = {}): GraphRecord => ({ status: "built", tool: "graphifyy 0.9.91", commit, nodes: 6, edges: 6, files: 4, sha256: createHash("sha256").update(raw).digest("hex"), ...over });
  const facts = (r: GraphRecord | undefined, content: Buffer | null = Buffer.from(raw)) => graphFacts({ record: r, content, commit, changed: [file("src/util.ts")], guarded: GUARDED });

  it("gives a hop count only from a fresh graph of the commit judged", () => {
    expect(facts(record())).toEqual({ status: "fresh", commit, hops: 2, nearest: "src/auth/login.ts", reached: 2 });
    expect(facts(record({ commit: "d".repeat(40) }))).toMatchObject({ status: "stale", hops: null, commit: "d".repeat(40) });
    expect(facts(undefined)).toMatchObject({ status: "missing", hops: null, commit: null });
    expect(facts(record(), null)).toMatchObject({ status: "missing", hops: null });
    expect(facts({ status: "error", tool: "graphifyy 0.9.91", commit, detail: "timed out" })).toMatchObject({ status: "error", detail: "timed out", hops: null });
    // A file that is not the one the record names never counts, whatever it holds.
    expect(facts(record(), Buffer.from("{}"))).toMatchObject({ status: "missing", detail: "graph.json is not the file the gates' record names", hops: null });
    expect(facts(record({ sha256: createHash("sha256").update("{}").digest("hex") }), Buffer.from("{}"))).toMatchObject({ status: "error", detail: "graph.json has no nodes", hops: null });
  });
});

describe("the shadow log in reports", () => {
  const commit = "c".repeat(40);
  const blast = (over: Partial<BlastRecord> = {}): BlastRecord => ({
    schema_version: 1, task_id: "T-0001", candidate_commit: commit, round: 1, drift: null, graph: { status: "fresh", commit },
    hops: 1, nearest: "src/auth/guard.ts", reached: 1, rule: { within: 2, matched: true, shadow_tier: "R2", enforced_tier: "R1" }, ...over,
  });

  it("reads a run's rounds and re-verifications in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "blast-"));
    try {
      for (const [path, b] of [["blast.json", blast()], ["rounds/2/blast.json", blast({ round: 2, hops: null, nearest: null, rule: { within: 2, matched: false, shadow_tier: "R1", enforced_tier: "R1" } })], ["drift/1/blast.json", blast({ round: null, drift: 1, graph: { status: "stale", commit: "d".repeat(40), detail: "older" }, hops: null, nearest: null, reached: null, rule: { within: 2, matched: false, shadow_tier: "R1", enforced_tier: "R1" } })]] as const) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), JSON.stringify(b));
      }
      const all = readBlasts(dir);
      expect(all.map(describeBlast)).toEqual([
        "round 1: 1 hop(s) to src/auth/guard.ts; the rule would raise R1 to R2",
        "round 2: no guarded file within 4 hops; the rule would keep R1",
        "re-verification 1: graph stale (older); no hop count",
      ]);
      expect(shadowCounts(all)).toEqual({ decisions: 3, fresh: 2, stale: 1, missing: 0, error: 0, matched: 1, raised: 1 });
      expect(readBlasts(join(dir, "absent"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says when a changed file is itself guarded", () => {
    expect(describeBlast(blast({ hops: 0, nearest: "src/auth/login.ts", rule: { within: 2, matched: true, shadow_tier: "R3", enforced_tier: "R3" } }))).toBe("round 1: changes src/auth/login.ts itself; the rule would keep R3");
  });
});
