// Consistency checks for the factory's own Markdown: roadmap/status ID parity,
// link and anchor integrity, and where full Claude model IDs may appear.

export interface Finding {
  file: string;
  line?: number;
  message: string;
}

const DEFINED_ID = /^\| (P\d-\d\d|G\d-\d) \|/gm;
const ANY_ID = /\b(P\d-\d\d|G\d-\d)\b/g;
const MODEL_ID = /claude-(?:opus|sonnet|haiku|fable)-\d/g;
const LINK = /\]\(([^)\s]+)\)/g;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** IDs defined as the first cell of a table row, in document order. */
export function definedIds(markdown: string): string[] {
  return [...markdown.matchAll(DEFINED_ID)].map((m) => m[1] ?? "");
}

export function checkIdConsistency(roadmap: string, status: string): Finding[] {
  const findings: Finding[] = [];
  const roadmapIds = definedIds(roadmap);
  const statusIds = definedIds(status);

  for (const [file, ids] of [["ROADMAP.md", roadmapIds], ["STATUS.md", statusIds]] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) findings.push({ file, message: `${id} is defined more than once` });
      seen.add(id);
    }
  }

  const inRoadmap = new Set(roadmapIds);
  const inStatus = new Set(statusIds);
  for (const id of inRoadmap) {
    if (!inStatus.has(id)) findings.push({ file: "STATUS.md", message: `${id} is missing (defined in ROADMAP.md)` });
  }
  for (const id of inStatus) {
    if (!inRoadmap.has(id)) findings.push({ file: "STATUS.md", message: `${id} is not defined in ROADMAP.md` });
  }

  const byPrefix = new Map<string, number[]>();
  for (const id of inRoadmap) {
    const [prefix = "", num = "0"] = id.split("-");
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), Number(num)]);
  }
  for (const [prefix, nums] of byPrefix) {
    nums.sort((a, b) => a - b);
    if (nums.some((n, i) => n !== i + 1)) {
      findings.push({ file: "ROADMAP.md", message: `${prefix} IDs are not numbered 1..${String(nums.length)}` });
    }
  }

  for (const [file, text] of [["ROADMAP.md", roadmap], ["STATUS.md", status]] as const) {
    for (const m of text.matchAll(ANY_ID)) {
      const id = m[1] ?? "";
      if (!inRoadmap.has(id)) {
        findings.push({ file, line: lineOf(text, m.index), message: `${id} is referenced but never defined` });
      }
    }
  }
  return findings;
}

/** GitHub-style heading anchors, skipping headings inside fenced code. */
export function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    const heading = inFence ? undefined : /^#{1,6} (.*)$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = heading
      .replace(/[`*_]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\- ]/gu, "")
      .replace(/ /g, "-");
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${String(n)}`);
  }
  return slugs;
}

export interface DocSet {
  /** Repository-relative path → Markdown content, for every document checked. */
  docs: ReadonlyMap<string, string>;
  /** Whether a repository-relative path exists. */
  exists: (path: string) => boolean;
}

function resolve(fromFile: string, target: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export function checkLinks({ docs, exists }: DocSet): Finding[] {
  const findings: Finding[] = [];
  for (const [file, text] of docs) {
    for (const m of text.matchAll(LINK)) {
      const target = m[1] ?? "";
      if (/^[a-z]+:/i.test(target)) continue;
      const [path = "", anchor] = target.split("#", 2);
      const targetFile = path === "" ? file : resolve(file, path);
      const line = lineOf(text, m.index);
      if (path !== "" && !exists(targetFile)) {
        findings.push({ file, line, message: `broken link: ${target}` });
        continue;
      }
      if (anchor === undefined) continue;
      const targetText = docs.get(targetFile);
      if (targetText !== undefined && !headingSlugs(targetText).has(anchor)) {
        findings.push({ file, line, message: `broken anchor: ${target}` });
      }
    }
  }
  return findings;
}

/** Full Claude model IDs may appear only in §11 (platform facts) and Appendix B (snippets). */
export function checkModelIds(roadmap: string): Finding[] {
  const allowed: [number, number][] = [];
  const facts = roadmap.indexOf("## 11. Platform facts");
  const appendixA = roadmap.indexOf("## Appendix A");
  const appendixB = roadmap.indexOf("## Appendix B");
  const appendixC = roadmap.indexOf("## Appendix C");
  if (facts >= 0 && appendixA > facts) allowed.push([facts, appendixA]);
  if (appendixB >= 0 && appendixC > appendixB) allowed.push([appendixB, appendixC]);

  return [...roadmap.matchAll(MODEL_ID)]
    .filter((m) => !allowed.some(([start, end]) => m.index >= start && m.index < end))
    .map((m) => ({
      file: "ROADMAP.md",
      line: lineOf(roadmap, m.index),
      message: `full model ID ${m[0]}… outside §11 and Appendix B; use an alias`,
    }));
}
