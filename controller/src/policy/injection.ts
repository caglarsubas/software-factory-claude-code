// Instructions addressed to an agent in untrusted input (ROADMAP §8, G2-2): a deterministic scan
// of the task's text and of the target files its sessions read or its candidate changed. A line
// that addresses an AI and, within a few lines, asks for something no task needs (a push to the
// default branch, secrets or tokens, CI workflows, ignoring instructions, sending data out) is
// injection-suspect. The policy engine raises such a task to R2, so a person approves it.
//
// It reports line numbers only: the matched text stays in the files it came from.

const ADDRESSEE = /\b(?:ai|a\.i\.|assistants?|agents?|llms?|language models?|claude|copilot|chatgpt|gpt|bots?)\b/i;
const ASK = new RegExp(
  [
    String.raw`\bignore\b.{0,40}\b(?:previous|prior|above|earlier|all)\b`,
    String.raw`\bdisregard\b`,
    String.raw`\b(?:force[- ]?)?push\b.{0,40}\b(?:main|master|default branch|production)\b`,
    String.raw`\bsecrets?\b`,
    String.raw`\b(?:api[_ -]?keys?|access tokens?|credentials?|passwords?)\b`,
    String.raw`\.github/workflows|\bworkflows?\b`,
    String.raw`\bexfiltrat\w*`,
    String.raw`\b(?:curl|wget)\b`,
    String.raw`\benv(?:ironment)? variables?\b`,
    String.raw`\bsend\b.{0,40}\bhttps?://`,
  ].join("|"),
  "i",
);
/** How many lines apart the addressee and the ask may be. */
const WINDOW = 3;

/** The 1-based lines where an addressee and an ask meet within the window; empty when none. */
export function agentDirectedLines(text: string): number[] {
  const lines = text.split("\n");
  const hits = new Set<number>();
  lines.forEach((line, i) => {
    if (!ADDRESSEE.test(line)) return;
    for (let j = Math.max(0, i - WINDOW); j <= Math.min(lines.length - 1, i + WINDOW); j++) {
      if (ASK.test(lines[j] ?? "")) {
        hits.add(i + 1);
        return;
      }
    }
  });
  return [...hits].sort((a, b) => a - b);
}

export interface InjectionScan {
  schema_version: 1;
  /** Lines of the task's own text. */
  task: number[];
  /** Target files, by path, at the candidate. */
  files: { path: string; lines: number[] }[];
}

export const suspect = (s: InjectionScan): boolean => s.task.length > 0 || s.files.length > 0;

/** Scans the task's text and each target file given by `read` (null when it does not exist at the candidate). */
export function scanInjection(taskText: string, paths: readonly string[], read: (path: string) => string | null): InjectionScan {
  const files = [...new Set(paths)].sort().flatMap((path) => {
    const content = read(path);
    const lines = content === null ? [] : agentDirectedLines(content);
    return lines.length === 0 ? [] : [{ path, lines }];
  });
  return { schema_version: 1, task: agentDirectedLines(taskText), files };
}
