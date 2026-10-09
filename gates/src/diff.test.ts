import { describe, expect, it } from "vitest";
import { parseAddedLines, touchesAdded, unquote } from "./diff.ts";

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3,0 +4,2 @@ export function f() {",
  "+  const x = 1;",
  "+++ starts with plus signs",
  "@@ -10 +12 @@",
  "-old",
  "+new",
  "diff --git a/src/new.py b/src/new.py",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.py",
  "@@ -0,0 +1,3 @@",
  "+a",
  "+b",
  "+c",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "-y",
  "diff --git a/src/removed-lines.ts b/src/removed-lines.ts",
  "--- a/src/removed-lines.ts",
  "+++ b/src/removed-lines.ts",
  "@@ -5,2 +4,0 @@",
  "-p",
  "-q",
  'diff --git "a/sp ace/\\303\\251.ts" "b/sp ace/\\303\\251.ts"',
  '--- "a/sp ace/\\303\\251.ts"',
  '+++ "b/sp ace/\\303\\251.ts"',
  "@@ -0,0 +1 @@",
  "+z",
  "",
].join("\n");

describe("parseAddedLines", () => {
  const added = parseAddedLines(diff);

  it("records new-side line numbers per hunk", () => {
    expect([...(added.get("src/a.ts") ?? [])].sort((a, b) => a - b)).toEqual([4, 5, 12]);
  });
  it("does not mistake an added line starting with ++ for a file header", () => {
    expect([...added.keys()]).not.toContain("starts with plus signs");
  });
  it("covers new files and ignores deleted ones", () => {
    expect([...(added.get("src/new.py") ?? [])]).toEqual([1, 2, 3]);
    expect(added.has("src/gone.ts")).toBe(false);
  });
  it("adds nothing for pure deletions", () => {
    expect(added.get("src/removed-lines.ts")?.size).toBe(0);
  });
  it("decodes quoted paths", () => {
    expect(added.get("sp ace/é.ts")).toEqual(new Set([1]));
  });
});

describe("touchesAdded", () => {
  const added = parseAddedLines(diff);
  it("matches a range that overlaps an added line", () => {
    expect(touchesAdded(added, "src/a.ts", 1, 4)).toBe(true);
    expect(touchesAdded(added, "src/a.ts", 6, 11)).toBe(false);
    expect(touchesAdded(added, "src/other.ts", 1, 100)).toBe(false);
  });
});

describe("unquote", () => {
  it("leaves plain paths alone and decodes escapes", () => {
    expect(unquote("b/plain.ts")).toBe("b/plain.ts");
    expect(unquote('"b/a\\"b\\\\c\\tz"')).toBe('b/a"b\\c\tz');
  });
});
