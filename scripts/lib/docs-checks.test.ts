import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkIdConsistency, checkLinks, checkModelIds, checkThreatModel, definedIds, headingSlugs, THREAT_IDS } from "./docs-checks.ts";

const roadmap = ["| ID | Deliverable |", "|---|---|", "| P0-01 | scaffold |", "| P0-02 | schemas |", "| G0-1 | gate |"].join("\n");
const status = ["| ID | Status |", "|---|---|", "| P0-01 | todo |", "| P0-02 | todo |", "| G0-1 | todo |"].join("\n");

describe("checkIdConsistency", () => {
  it("accepts matching, contiguous IDs", () => {
    expect(definedIds(roadmap)).toEqual(["P0-01", "P0-02", "G0-1"]);
    expect(checkIdConsistency(roadmap, status)).toEqual([]);
  });

  it("reports IDs missing from STATUS and IDs STATUS invents", () => {
    const messages = checkIdConsistency(roadmap, status.replace("| P0-02 |", "| P0-03 |")).map((f) => f.message);
    expect(messages).toContain("P0-02 is missing (defined in ROADMAP.md)");
    expect(messages).toContain("P0-03 is not defined in ROADMAP.md");
  });

  it("reports duplicates, gaps and dangling references", () => {
    const broken = `${roadmap}\n| P0-02 | again |\n| P0-04 | gap |\nSee P9-99.`;
    const messages = checkIdConsistency(broken, status).map((f) => f.message);
    expect(messages).toContain("P0-02 is defined more than once");
    expect(messages).toContain("P0 IDs are not numbered 1..3");
    expect(messages).toContain("P9-99 is referenced but never defined");
  });
});

describe("headingSlugs", () => {
  it("follows GitHub's anchor rules and skips fenced code", () => {
    const slugs = headingSlugs("## 11. Platform facts, as of 2026\n## Appendix A · Kickoff\n```\n# not a heading\n```\n## Appendix A · Kickoff");
    expect([...slugs]).toEqual(["11-platform-facts-as-of-2026", "appendix-a--kickoff", "appendix-a--kickoff-1"]);
  });
});

describe("checkLinks", () => {
  const docs = new Map([
    ["README.md", "[ok](docs/a.md#title) [missing](docs/nope.md) [bad](docs/a.md#nope) [web](https://example.com)"],
    ["docs/a.md", "# Title\n[self](#title) [up](../README.md)"],
  ]);
  const exists = (path: string) => docs.has(path);

  it("reports only broken files and anchors", () => {
    expect(checkLinks({ docs, exists }).map((f) => `${f.file}: ${f.message}`)).toEqual([
      "README.md: broken link: docs/nope.md",
      "README.md: broken anchor: docs/a.md#nope",
    ]);
  });
});

describe("checkModelIds", () => {
  const doc = "## 1. Intro\nclaude-opus-5-5\n## 11. Platform facts\nclaude-opus-5-5\n## Appendix A\n## Appendix B\nclaude-haiku-5-5\n## Appendix C\n";

  it("allows full model IDs only in §11 and Appendix B", () => {
    expect(checkModelIds(doc)).toEqual([expect.objectContaining({ line: 2 })]);
  });
});

describe("checkThreatModel", () => {
  const row = (id: string, controls = "the guard") => `| ${id} | risk | ${controls} | residual |`;
  const full = THREAT_IDS.map((id) => row(id)).join("\n");

  it("accepts one row with controls for each of the 20 risks", () => {
    expect(THREAT_IDS).toHaveLength(20);
    expect(checkThreatModel(full)).toEqual([]);
  });

  it("reports a missing, duplicated, empty or unknown risk", () => {
    const doc = [full.replace(`${row("LLM07")}\n`, "").replace(row("ASI05"), row("ASI05", "")), row("ASI03"), row("ASI11")].join("\n");
    const messages = checkThreatModel(doc).map((f) => f.message);
    expect(messages).toEqual(["LLM07 has no row", "ASI03 has more than one row", "ASI05 names no controls", "ASI11 is not an OWASP LLM 2025 or Agentic 2026 risk"]);
  });
});

describe("repository docs", () => {
  it("ROADMAP and STATUS are consistent", () => {
    const real = (path: string) => readFileSync(path, "utf8");
    const roadmapText = real("docs/factory/ROADMAP.md");
    expect(checkIdConsistency(roadmapText, real("docs/factory/STATUS.md"))).toEqual([]);
    expect(checkModelIds(roadmapText)).toEqual([]);
  });

  it("the threat model maps every OWASP risk to controls", () => {
    expect(checkThreatModel(readFileSync("docs/factory/threat-model.md", "utf8"))).toEqual([]);
  });
});
