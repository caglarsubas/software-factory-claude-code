// The code graph's record (P2-13): what the gates report of the graph scan, and the graph kept
// for the round only when the scan produced one.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecResult } from "./container.ts";
import { graphifyTool } from "./image.ts";
import { GRAPH_MAX_BYTES, graphRecord } from "./run.ts";

const dir = mkdtempSync(join(tmpdir(), "graph-record-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const COMMIT = "a".repeat(40);
const TOOL = "graphifyy 0.9.91";
const ran = (r: Partial<ExecResult>): ExecResult => ({ status: 0, stdout: "", stderr: "", timedOut: false, durationMs: 10, ...r });
const graph = JSON.stringify({
  nodes: [
    { id: "a", source_file: "src/a.ts" },
    { id: "a_f", source_file: "src/a.ts" },
    { id: "b", source_file: "src/b.ts" },
    { id: "ext", source_file: "" },
  ],
  links: [{ source: "a", target: "b", relation: "imports_from" }, { source: "a", target: "ext", relation: "imports_from" }],
});

describe("the code graph's record", () => {
  it("counts a built graph, stamps the candidate commit, and keeps it where asked", () => {
    const out = join(dir, "graph.json");
    const r = graphRecord(ran({ stdout: graph }), COMMIT, TOOL, 1000, out);
    expect(r).toMatchObject({ status: "built", tool: TOOL, commit: COMMIT, nodes: 4, edges: 2, files: 2 });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(out, "utf8")).toBe(graph);
    // graphify's own older key for the edges.
    expect(graphRecord(ran({ stdout: JSON.stringify({ nodes: [], edges: [{}] }) }), COMMIT, TOOL, 1000)).toMatchObject({ status: "built", edges: 1 });
  });

  it("records why there is no graph, keeps nothing, and never throws", () => {
    const out = join(dir, "none.json");
    expect(graphRecord(ran({ timedOut: true, status: null }), COMMIT, TOOL, 900_000, out)).toEqual({ status: "error", tool: TOOL, commit: COMMIT, detail: "timed out after 900.0s" });
    expect(graphRecord(ran({ status: 1, stderr: "Traceback\nValueError: bad tree" }), COMMIT, TOOL, 1000, out)).toMatchObject({ status: "error", detail: "exit 1: Traceback | ValueError: bad tree" });
    expect(graphRecord(ran({ stdout: "not json" }), COMMIT, TOOL, 1000, out)).toMatchObject({ status: "error", detail: "the output is not JSON" });
    expect(graphRecord(ran({ stdout: "{}" }), COMMIT, TOOL, 1000, out)).toMatchObject({ status: "error", detail: "the output has no nodes" });
    expect(graphRecord(ran({ stdout: "x".repeat(GRAPH_MAX_BYTES + 1) }), COMMIT, TOOL, 1000, out)).toMatchObject({ status: "error", detail: "graph.json is larger than 64 MiB" });
    expect(existsSync(out)).toBe(false);
  });

  it("names the graphifyy release the image pins", () => {
    expect(graphifyTool()).toMatch(/^graphifyy [0-9]+\.[0-9]+\.[0-9]+$/);
  });
});
