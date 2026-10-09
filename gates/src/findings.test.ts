import { describe, expect, it } from "vitest";
import { judgeDependencies, judgeSast, judgeSecrets, relativeTo } from "./findings.ts";

const ROOT = "/data/candidate";
const added = new Map([
  ["src/app.ts", new Set([10, 11])],
  ["src/job.py", new Set([3])],
]);

const og = (results: object[], errors: object[] = []) => JSON.stringify({ version: "1.30.1", results, errors, paths: { scanned: [] } });
const hit = (path: string, line: number, metadata: object, message = "msg") => ({
  check_id: "opt.gates.rules.x",
  path: `${ROOT}/${path}`,
  start: { line, col: 1 },
  end: { line, col: 9 },
  extra: { message, metadata, severity: "ERROR", lines: "SECRET SOURCE TEXT" },
});

describe("judgeSast", () => {
  it("fails on a default finding on an added line, and never quotes the matched source", () => {
    const j = judgeSast(og([hit("src/app.ts", 10, { pack: "default" }, "TLS certificate verification disabled")]), 0, added, ROOT);
    expect(j.outcome.status).toBe("fail");
    expect(j.outcome.summary).toContain("src/app.ts:10 TLS certificate verification disabled");
    expect(j.outcome.summary).not.toContain("SECRET SOURCE TEXT");
  });
  it("ignores findings on lines the change did not add", () => {
    const j = judgeSast(og([hit("src/app.ts", 3, { pack: "default" }), hit("src/untouched.ts", 1, { pack: "default" })]), 0, added, ROOT);
    expect(j.outcome.status).toBe("pass");
  });
  it("turns sink_added findings into signals without failing the gate", () => {
    const j = judgeSast(og([hit("src/job.py", 3, { pack: "sink_added", sink: "shell" }), hit("src/app.ts", 11, { pack: "sink_added", sink: "code_exec" })]), 0, added, ROOT);
    expect(j.outcome.status).toBe("pass");
    expect(j.sinks).toEqual(["code_exec", "shell"]);
  });
  it("fails a sink rule that names no known sink kind (fail upward)", () => {
    expect(judgeSast(og([hit("src/job.py", 3, { pack: "sink_added", sink: "teleport" })]), 0, added, ROOT).outcome.status).toBe("fail");
  });
  it("errors when a changed file could not be scanned", () => {
    const j = judgeSast(og([], [{ level: "error", type: "Timeout", path: `${ROOT}/src/app.ts`, message: "timeout" }]), 0, added, ROOT);
    expect(j.outcome.status).toBe("error");
  });
  it("tolerates scan errors in files the change did not touch", () => {
    expect(judgeSast(og([], [{ level: "error", path: `${ROOT}/vendor/x.ts` }]), 0, added, ROOT).outcome.status).toBe("pass");
  });
  it("errors on a crash or unparseable output", () => {
    expect(judgeSast("", 2, added, ROOT).outcome.status).toBe("error");
    expect(judgeSast("not json", 0, added, ROOT).outcome.status).toBe("error");
  });
});

const th = (file: string, line: number | undefined, detector = "AWS") =>
  JSON.stringify({ DetectorName: detector, Verified: false, Raw: "AKIA-REDACTED-RAW", SourceMetadata: { Data: { Filesystem: { file: `${ROOT}/${file}`, ...(line === undefined ? {} : { line }) } } } });

describe("judgeSecrets", () => {
  it("fails on a match on an added line, naming file, line and detector only", () => {
    const j = judgeSecrets(`${th("src/job.py", 3)}\n`, 0, added, ROOT);
    expect(j.outcome.status).toBe("fail");
    expect(j.secretMaterial).toBe(true);
    expect(j.outcome.summary).toContain("src/job.py:3 (AWS)");
    expect(j.outcome.summary).not.toContain("AKIA");
  });
  it("ignores pre-existing secrets on untouched lines", () => {
    expect(judgeSecrets(`${th("src/job.py", 1)}\n${th("old.env", 2)}\n`, 0, added, ROOT).secretMaterial).toBe(false);
  });
  it("counts a match without a line number anywhere in a changed file", () => {
    expect(judgeSecrets(th("src/app.ts", undefined), 0, added, ROOT).outcome.status).toBe("fail");
  });
  it("errors on a crash or a non-JSON line", () => {
    expect(judgeSecrets("", 1, added, ROOT).outcome.status).toBe("error");
    expect(judgeSecrets("oops\n", 0, added, ROOT).outcome.status).toBe("error");
  });
});

const osv = (results: { path: string; pkgs: [string, string, string[]][] }[]) =>
  JSON.stringify({
    results: results.map((r) => ({
      source: { path: r.path, type: "lockfile" },
      packages: r.pkgs.map(([name, version, ids]) => ({ package: { name, version, ecosystem: "npm" }, vulnerabilities: ids.map((id) => ({ id })) })),
    })),
  });

describe("judgeDependencies", () => {
  it("fails on a vulnerability the change introduced", () => {
    const out = osv([{ path: `${ROOT}/pnpm-lock.yaml`, pkgs: [["lodash", "4.17.20", ["GHSA-1"]]] }]);
    const o = judgeDependencies(out, 1, ROOT, "/data/base");
    expect(o.status).toBe("fail");
    expect(o.summary).toContain("lodash@4.17.20 GHSA-1 (pnpm-lock.yaml)");
  });
  it("passes when the same advisory was already in the base lockfile", () => {
    const out = osv([
      { path: `${ROOT}/pnpm-lock.yaml`, pkgs: [["lodash", "4.17.19", ["GHSA-1"]]] },
      { path: "/data/base/pnpm-lock.yaml", pkgs: [["lodash", "4.17.20", ["GHSA-1"]]] },
    ]);
    expect(judgeDependencies(out, 1, ROOT, "/data/base").status).toBe("pass");
  });
  it("treats the same advisory in a different lockfile as introduced", () => {
    const out = osv([
      { path: `${ROOT}/app/pnpm-lock.yaml`, pkgs: [["lodash", "4.17.20", ["GHSA-1"]]] },
      { path: "/data/base/fixtures/pnpm-lock.yaml", pkgs: [["lodash", "4.17.20", ["GHSA-1"]]] },
    ]);
    expect(judgeDependencies(out, 1, ROOT, "/data/base").status).toBe("fail");
  });
  it("passes when there is nothing to audit, and errors on a crash", () => {
    expect(judgeDependencies("", 128, ROOT, "/data/base").status).toBe("pass");
    expect(judgeDependencies(JSON.stringify({ results: [] }), 0, ROOT, "/data/base").status).toBe("pass");
    expect(judgeDependencies("", 127, ROOT, "/data/base").status).toBe("error");
  });
});

describe("relativeTo", () => {
  it("maps container paths back to repository paths", () => {
    expect(relativeTo(ROOT, `${ROOT}/a/b.ts`)).toBe("a/b.ts");
    expect(relativeTo(ROOT, "/data/candidate-other/x")).toBeNull();
  });
});
