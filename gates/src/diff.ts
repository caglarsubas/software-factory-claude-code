// Which lines a change added, from `git diff --unified=0`. Scanner findings count only on
// added lines, so pre-existing issues in a target never fail a task that did not touch them.

/** Repository-relative path → new-side line numbers the change added. */
export type AddedLines = ReadonlyMap<string, ReadonlySet<number>>;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  // `+++` is a header only between `diff --git` and the first hunk; inside a hunk it is an
  // added line whose content starts with "++".
  let inHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = null;
      continue;
    }
    if (inHeader && line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target === "/dev/null") {
        current = null;
      } else {
        const path = unquote(target).replace(/^b\//, "");
        current = added.get(path) ?? new Set<number>();
        added.set(path, current);
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      inHeader = false;
      if (current === null) continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) current.add(start + i);
    }
  }
  return added;
}

/** True when any line in [from, to] was added to `path`. */
export function touchesAdded(added: AddedLines, path: string, from: number, to: number = from): boolean {
  const lines = added.get(path);
  if (lines === undefined) return false;
  for (let l = from; l <= to; l++) if (lines.has(l)) return true;
  return false;
}

const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Git's C-style path quoting: `"b/a\"b\303\251"` → `b/a"bé`. */
export function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = body.charAt(i + 1);
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
