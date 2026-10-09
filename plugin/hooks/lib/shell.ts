// A conservative shell analyzer for the guard hook. It finds every simple command a Bash
// string can run, including inside $(...), backticks, `sh -c` and `eval`, and marks
// anything it cannot resolve statically as dynamic so the policy can refuse it.
// It is defense in depth: the OS sandbox is the enforcement boundary for Bash.
import { resolve } from "node:path";

export class ShellParseError extends Error {}

export interface Word {
  text: string;
  /** Contains an expansion ($VAR, $(...), backticks) whose value is unknown statically. */
  dynamic: boolean;
  /** Contains an unquoted glob character. */
  glob: boolean;
}

export interface Redirect {
  op: string;
  target: Word | null;
}

export interface SimpleCommand {
  /** Program name with wrappers, assignments and keywords stripped; null when dynamic. */
  program: string | null;
  args: Word[];
  redirects: Redirect[];
  /** Directory the command runs in; null when a preceding `cd` was dynamic. */
  cwd: string | null;
}

type Token =
  | { kind: "word"; word: Word; subs: string[] }
  | { kind: "op"; op: string }
  | { kind: "redir"; op: string };

const SEPARATORS = ["&&", "||", "|&", ";;", ";", "&", "|", "\n", "(", ")"];
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "in", "case", "esac", "select", "function", "!", "{", "}", "time", "coproc"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "busybox"]);
const MAX_DEPTH = 8;

/** Read a balanced region starting after `open` (e.g. after "$("), honouring quotes. */
function readBalanced(s: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) throw new ShellParseError("unterminated single quote");
      i = end;
    } else if (c === '"') {
      i = readDoubleQuoted(s, i + 1).end;
    } else if (s.startsWith(open, i)) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new ShellParseError(`unterminated ${open}`);
}

interface Piece {
  text: string;
  dynamic: boolean;
  subs: string[];
  end: number;
}

/** Scan a double-quoted string starting after the opening quote. */
function readDoubleQuoted(s: string, start: number): Piece {
  let text = "";
  let dynamic = false;
  const subs: string[] = [];
  for (let i = start; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '"') return { text, dynamic, subs, end: i };
    if (c === "\\") {
      text += s.charAt(i + 1);
      i++;
    } else if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end === -1) throw new ShellParseError("unterminated backtick");
      subs.push(s.slice(i + 1, end));
      dynamic = true;
      i = end;
    } else if (c === "$") {
      const exp = readDollar(s, i);
      subs.push(...exp.subs);
      dynamic = dynamic || exp.dynamic;
      text += exp.text;
      i = exp.end;
    } else {
      text += c;
    }
  }
  throw new ShellParseError("unterminated double quote");
}

/** Scan an expansion starting at `$`. */
function readDollar(s: string, i: number): Piece {
  if (s.startsWith("$((", i)) {
    const end = readBalanced(s, i + 3, "((", ")");
    return { text: "", dynamic: true, subs: [], end: s.charAt(end + 1) === ")" ? end + 1 : end };
  }
  if (s.startsWith("$(", i)) {
    const end = readBalanced(s, i + 2, "(", ")");
    return { text: "", dynamic: true, subs: [s.slice(i + 2, end)], end };
  }
  if (s.startsWith("${", i)) {
    const end = s.indexOf("}", i + 2);
    if (end === -1) throw new ShellParseError("unterminated ${");
    return { text: "", dynamic: true, subs: [], end };
  }
  const name = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(i));
  if (name === null) return { text: "$", dynamic: false, subs: [], end: i };
  return { text: "", dynamic: true, subs: [], end: i + name[0].length - 1 };
}

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: string[] = [];
  let i = 0;

  const skipHeredocBodies = (): void => {
    // Called at a newline: drop the bodies of heredocs opened on the previous line.
    while (pendingHeredocs.length > 0) {
      const delim = pendingHeredocs.shift() ?? "";
      for (;;) {
        const nl = s.indexOf("\n", i);
        const line = s.slice(i, nl === -1 ? s.length : nl);
        i = nl === -1 ? s.length : nl + 1;
        if (line.replace(/^\t+/, "") === delim) break;
        if (nl === -1) throw new ShellParseError(`unterminated heredoc ${delim}`);
      }
    }
  };

  while (i < s.length) {
    const c = s.charAt(i);
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\\" && s.charAt(i + 1) === "\n") {
      i += 2;
      continue;
    }
    if (c === "#") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (c === "\n") {
      tokens.push({ kind: "op", op: "\n" });
      i++;
      skipHeredocBodies();
      continue;
    }
    const redir = /^(?:\d*|&)(?:<<<|<<-|<<|>>|>\||<>|>&|<&|>|<)/.exec(s.slice(i));
    if (redir !== null) {
      const op = redir[0];
      i += op.length;
      tokens.push({ kind: "redir", op });
      if (op.endsWith("<<") || op.endsWith("<<-")) {
        while (s.charAt(i) === " ") i++;
        const delim = /^(['"]?)([^\s'"]+)\1/.exec(s.slice(i));
        if (delim === null) throw new ShellParseError("heredoc without delimiter");
        pendingHeredocs.push(delim[2] ?? "");
        tokens.push({ kind: "word", word: { text: delim[2] ?? "", dynamic: false, glob: false }, subs: [] });
        i += delim[0].length;
      }
      continue;
    }
    const sep = SEPARATORS.find((op) => s.startsWith(op, i));
    if (sep !== undefined && !(sep === "(" && s.startsWith("$(", i - 1))) {
      tokens.push({ kind: "op", op: sep });
      i += sep.length;
      continue;
    }
    // A word: concatenate quoted and unquoted pieces until whitespace or an operator.
    let text = "";
    let dynamic = false;
    let glob = false;
    const subs: string[] = [];
    while (i < s.length) {
      const d = s.charAt(i);
      if (" \t\n;&|()<>".includes(d)) {
        if ((d === "<" || d === ">") && s.charAt(i + 1) === "(") {
          const end = readBalanced(s, i + 2, "(", ")");
          subs.push(s.slice(i + 2, end));
          dynamic = true;
          i = end + 1;
          continue;
        }
        break;
      }
      if (d === "\\") {
        text += s.charAt(i + 1);
        i += 2;
      } else if (d === "'") {
        const end = s.indexOf("'", i + 1);
        if (end === -1) throw new ShellParseError("unterminated single quote");
        text += s.slice(i + 1, end);
        i = end + 1;
      } else if (d === '"') {
        const piece = readDoubleQuoted(s, i + 1);
        text += piece.text;
        dynamic = dynamic || piece.dynamic;
        subs.push(...piece.subs);
        i = piece.end + 1;
      } else if (d === "`") {
        const end = s.indexOf("`", i + 1);
        if (end === -1) throw new ShellParseError("unterminated backtick");
        subs.push(s.slice(i + 1, end));
        dynamic = true;
        i = end + 1;
      } else if (d === "$") {
        const exp = readDollar(s, i);
        text += exp.text;
        dynamic = dynamic || exp.dynamic;
        subs.push(...exp.subs);
        i = exp.end + 1;
      } else {
        if ("*?[".includes(d)) glob = true;
        text += d;
        i++;
      }
    }
    tokens.push({ kind: "word", word: { text, dynamic, glob }, subs });
  }
  if (pendingHeredocs.length > 0) throw new ShellParseError("unterminated heredoc");
  return tokens;
}

const isAssignment = (w: Word): boolean => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w.text);

/** Strip wrappers such as `env`, `command`, `nohup`, `timeout 5`, `xargs -0`. */
function stripWrappers(words: Word[]): Word[] {
  let rest = words;
  for (;;) {
    while (rest[0] !== undefined && (KEYWORDS.has(rest[0].text) || isAssignment(rest[0]))) rest = rest.slice(1);
    const head = rest[0];
    if (head === undefined || head.dynamic) return rest;
    const name = head.text.replace(/^.*\//, "");
    const skipOptions = (from: number, withValue = /^$/): number => {
      let j = from;
      while (rest[j] !== undefined && (rest[j]?.text.startsWith("-") ?? false)) {
        j += withValue.test(rest[j]?.text ?? "") ? 2 : 1;
      }
      return j;
    };
    if (["command", "builtin", "exec", "nohup", "noglob"].includes(name)) rest = rest.slice(skipOptions(1));
    else if (name === "env") {
      let j = skipOptions(1, /^-(u|S|C|-unset|-chdir)$/);
      for (let w = rest[j]; w !== undefined && isAssignment(w); w = rest[j]) j++;
      rest = rest.slice(j);
    } else if (name === "nice" || name === "ionice" || name === "stdbuf" || name === "chrt") rest = rest.slice(skipOptions(1, /^-[nco]$/));
    else if (name === "timeout") rest = rest.slice(skipOptions(1, /^-[sk]$/) + 1);
    else if (name === "xargs") rest = rest.slice(skipOptions(1, /^-[aEeIiLlnPsd]$/));
    else return rest;
  }
}

/** Analyze a shell string into the simple commands it can run. */
export function analyze(script: string, cwd: string, depth = 0): SimpleCommand[] {
  if (depth > MAX_DEPTH) throw new ShellParseError("nesting too deep");
  const tokens = tokenize(script);
  const commands: SimpleCommand[] = [];
  let current: Token[] = [];
  let currentCwd: string | null = cwd;

  const flush = (): void => {
    const words: Word[] = [];
    const redirects: Redirect[] = [];
    const subs: string[] = [];
    for (let k = 0; k < current.length; k++) {
      const t = current[k];
      if (t === undefined) continue;
      if (t.kind === "redir") {
        const next = current[k + 1];
        if (next?.kind === "word") {
          redirects.push({ op: t.op, target: next.word });
          subs.push(...next.subs);
          k++;
        } else if (/&\d*$/.test(t.op) && next === undefined) {
          redirects.push({ op: t.op, target: null });
        } else {
          redirects.push({ op: t.op, target: null });
        }
      } else if (t.kind === "word") {
        words.push(t.word);
        subs.push(...t.subs);
      }
    }
    current = [];
    for (const sub of subs) commands.push(...analyze(sub, currentCwd ?? cwd, depth + 1));
    if (words.length === 0 && redirects.length === 0) return;

    const rest = stripWrappers(words);
    const head = rest[0];
    const program = head === undefined ? null : head.dynamic || head.glob ? null : head.text.replace(/^.*\//, "");
    const args = rest.slice(1);
    commands.push({ program: head === undefined ? "" : program, args, redirects, cwd: currentCwd });

    if (program === "cd" || program === "pushd") {
      const target = args.find((a) => !a.text.startsWith("-"));
      currentCwd = target === undefined || target.dynamic || currentCwd === null ? null : resolve(currentCwd, target.text);
    } else if (program === "popd") {
      currentCwd = null;
    }
    if (program !== null && SHELLS.has(program)) {
      const flagAt = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text));
      const inner = flagAt === -1 ? undefined : args[flagAt + 1];
      if (inner !== undefined) {
        if (inner.dynamic) throw new ShellParseError("dynamic script for a nested shell");
        commands.push(...analyze(inner.text, currentCwd ?? cwd, depth + 1));
      }
    }
    if (program === "eval") {
      if (args.some((a) => a.dynamic)) throw new ShellParseError("dynamic eval");
      commands.push(...analyze(args.map((a) => a.text).join(" "), currentCwd ?? cwd, depth + 1));
    }
  };

  for (const t of tokens) {
    if (t.kind === "op") flush();
    else current.push(t);
  }
  flush();
  return commands;
}
