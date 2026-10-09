import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkIdConsistency, checkLinks, checkModelIds, definedIds, headingSlugs } from "./docs-checks.ts";

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

describe("repository docs", () => {
  it("ROADMAP and STATUS are consistent", () => {
    const real = (path: string) => readFileSync(path, "utf8");
    const roadmapText = real("docs/factory/ROADMAP.md");
    expect(checkIdConsistency(roadmapText, real("docs/factory/STATUS.md"))).toEqual([]);
    expect(checkModelIds(roadmapText)).toEqual([]);
  });
});
