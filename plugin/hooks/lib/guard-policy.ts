// Decides whether one tool call may run. Factory sessions (a guard config exists) get the
// full rule set; human sessions only get secret-read protection. Every uncertainty denies.
import { isAbsolute } from "node:path";
import { inside, matchesAny, realResolve } from "./paths.ts";
import { analyze, ShellParseError, type SimpleCommand, type Word } from "./shell.ts";

export interface GuardConfig {
  schema_version: 1;
  task_id: string;
  stage: string;
  worktree: string;
  task_dir: string;
  /** Extra protected globs from the target profile, relative to the worktree. */
  protected_paths: string[];
  /** The spec's scope; null for stages that never write code. */
  scope: { include: string[]; exclude: string[] } | null;
  /** Files in task_dir the agent may write, e.g. build-report.md. */
  writable_task_files: string[];
  /** Extra secret globs. */
  secret_paths: string[];
  /** Tools this stage may call; anything else is denied. */
  allowed_tools: string[];
  /** Directories readable besides the worktree, e.g. the evidence bundle. */
  readable_roots: string[];
}

export interface ToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
}

export type Decision = { allow: true } | { allow: false; reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

/** Always protected in factory sessions, whatever the profile says. */
export const BUILTIN_PROTECTED = [".git/**", ".claude/**", ".claude-plugin/**", ".github/**", "**/CODEOWNERS", ".mcp.json", ".gitmodules"];

/** Always secret, in every session. Matched against both repo-relative and absolute paths. */
export const BUILTIN_SECRETS = [
  "**/.env", "**/.env.*", "**/.ssh/**", "**/.aws/**", "**/.azure/**", "**/.config/gcloud/**",
  "**/.docker/config.json", "**/.netrc", "**/.npmrc", "**/.pypirc", "**/.git-credentials",
  "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ecdsa*", "**/id_ed25519*", "/proc/*/environ", "/proc/*/environ/**",
];

/** Programs a factory session may never run: remote access, publishing, privilege, clouds. */
const DENIED_PROGRAMS = new Set([
  "gh", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "curl", "wget",
  "sudo", "su", "doas", "docker", "podman", "kubectl", "aws", "gcloud", "az", "patch", "claude", "factoryctl",
]);
const PUBLISHERS = new Set(["npm", "pnpm", "yarn", "bun", "cargo", "twine", "gem", "poetry", "uv"]);
/** Commands that write every path they are given. */
const WRITE_ALL = new Set(["tee", "mv", "rm", "rmdir", "touch", "truncate", "mkdir", "unlink", "shred"]);
/** Commands that write only their destination (the last path, or the -t directory). */
const WRITE_DEST = new Set(["cp", "ln", "install"]);
const INTERPRETERS = new Set(["python", "python3", "node", "nodejs", "perl", "ruby", "php", "deno", "bun", "tsx"]);
const SAFE_WRITE_TARGETS = ["/dev/null", "/dev/stdout", "/dev/stderr", "/tmp/**"];
const PATH_TOOLS: Record<string, string> = { Read: "file_path", Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path", NotebookRead: "notebook_path" };
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function isSecret(absolute: string, config: GuardConfig | null): boolean {
  const globs = [...BUILTIN_SECRETS, ...(config?.secret_paths ?? [])];
  if (matchesAny(absolute, globs)) return true;
  const rel = config === null ? null : inside(config.worktree, absolute);
  return rel !== null && rel !== "" && matchesAny(rel, globs);
}

/** A worktree path is protected if a protected glob covers it, or it is an ancestor of one. */
function isProtected(rel: string, config: GuardConfig): boolean {
  const globs = [...BUILTIN_PROTECTED, ...config.protected_paths];
  if (rel === "" || rel === ".") return true;
  if (matchesAny(rel, globs) || matchesAny(`${rel}/x`, globs)) return true;
  return globs.some((g) => {
    const literal = g.split("/").filter((seg) => !/[*?[]/.test(seg));
    return !g.startsWith("**") && literal.join("/").toLowerCase().startsWith(`${rel.toLowerCase()}/`);
  });
}

function inScope(rel: string, config: GuardConfig): boolean {
  if (config.scope === null) return false;
  const under = (p: string): boolean => {
    const base = p.replace(/\/+$/, "");
    return /[*?[]/.test(p) ? matchesAny(rel, [p]) : rel === base || rel.startsWith(`${base}/`);
  };
  return config.scope.include.some(under) && !config.scope.exclude.some(under);
}

/** May the agent write this absolute path? */
function writeDecision(absolute: string, config: GuardConfig): Decision {
  if (isSecret(absolute, config)) return deny(`writing a secret path is not allowed: ${absolute}`);
  const taskFile = inside(config.task_dir, absolute);
  if (taskFile !== null) {
    return config.writable_task_files.includes(taskFile) ? ALLOW : deny(`only ${config.writable_task_files.join(", ")} may be written in the task directory`);
  }
  const rel = inside(config.worktree, absolute);
  if (rel === null) return deny(`writing outside the task worktree is not allowed: ${absolute}`);
  if (isProtected(rel, config)) return deny(`${rel || "the worktree root"} is a protected path; changes to it need the operator`);
  if (!inScope(rel, config)) return deny(`${rel} is outside the spec's scope`);
  return ALLOW;
}

function readDecision(absolute: string, config: GuardConfig | null): Decision {
  if (isSecret(absolute, config)) return deny(`reading a secret path is not allowed: ${absolute}`);
  if (config === null) return ALLOW;
  const roots = [config.worktree, config.task_dir, ...config.readable_roots];
  return roots.some((r) => inside(r, absolute) !== null) ? ALLOW : deny(`reading outside the task worktree and bundle is not allowed: ${absolute}`);
}

const looksLikePath = (w: Word): boolean => !w.text.startsWith("-") || w.text.includes("=");
const argPath = (w: Word): string => (w.text.includes("=") && w.text.startsWith("-") ? w.text.slice(w.text.indexOf("=") + 1) : w.text);

/** The directory part of a glob before its first wildcard, e.g. `dist/*.js` → `dist`. */
const globBase = (p: string): string => p.slice(0, Math.max(p.search(/[*?[]/), 0)).replace(/\/?[^/]*$/, "");

function checkWritePath(word: Word, cmd: SimpleCommand, config: GuardConfig): Decision {
  if (word.dynamic) return deny(`cannot verify a computed path (${word.text || "expansion"}); use a literal path`);
  if (cmd.cwd === null && !isAbsolute(word.text)) return deny("cannot verify a relative path after a dynamic cd");
  const base = cmd.cwd ?? "/";
  if (word.glob) {
    const dir = realResolve(base, globBase(argPath(word)) || ".");
    const rel = inside(config.worktree, dir);
    if (rel === null || isProtected(rel, config)) return deny(`the glob ${word.text} may reach a protected path; list the files explicitly`);
    return ALLOW;
  }
  const target = realResolve(base, argPath(word));
  // The worktree and task directory are judged first: they may themselves live under /tmp.
  const ours = inside(config.worktree, target) !== null || inside(config.task_dir, target) !== null;
  if (!ours && matchesAny(target, SAFE_WRITE_TARGETS)) return ALLOW;
  return writeDecision(target, config);
}

const SENSITIVE_KEYS = /credential|sshcommand|askpass|hookspath|^url\.|insteadof|^remote\./i;

function checkGit(cmd: SimpleCommand, config: GuardConfig): Decision {
  const args = cmd.args;
  let k = 0;
  let cwd = cmd.cwd;
  while (k < args.length && (args[k]?.text.startsWith("-") ?? false)) {
    const opt = args[k]?.text ?? "";
    if (opt === "-c" || opt === "-C") {
      const value = args[k + 1];
      if (value === undefined || value.dynamic) return deny(`git ${opt} with a computed value`);
      if (opt === "-c" && SENSITIVE_KEYS.test(value.text.split("=")[0] ?? "")) return deny(`git -c ${value.text} is not allowed`);
      if (opt === "-C") cwd = cwd === null ? null : realResolve(cwd, value.text);
      k += 2;
    } else {
      k += 1;
    }
  }
  const sub = args[k];
  if (sub === undefined) return ALLOW;
  if (sub.dynamic || sub.glob) return deny("cannot verify a computed git subcommand");
  const rest = args.slice(k + 1);
  switch (sub.text) {
    case "push":
    case "send-pack":
    case "credential":
    case "apply":
    case "am":
      return deny(`git ${sub.text} is not allowed: factoryctl performs every push and patch`);
    case "remote":
      return ["add", "set-url", "rename", "remove", "rm", "set-head", "set-branches"].includes(rest[0]?.text ?? "") ? deny(`git remote ${rest[0]?.text ?? ""} is not allowed`) : ALLOW;
    case "config":
      return rest.some((w) => ["--get", "--get-all", "--list", "-l", "--get-regexp"].includes(w.text)) ? ALLOW : deny("changing git config is not allowed");
    case "rm":
    case "mv":
    case "checkout":
    case "restore":
      for (const w of rest.filter(looksLikePath)) {
        const d = checkWritePath(w, { ...cmd, cwd }, config);
        if (!d.allow) return d;
      }
      return ALLOW;
    default:
      return ALLOW;
  }
}

/** The arguments a command writes to. */
function writeTargets(program: string, args: Word[]): Word[] {
  const positional = (from: Word[], valued = /^$/): Word[] => {
    const out: Word[] = [];
    for (let k = 0; k < from.length; k++) {
      const w = from[k];
      if (w === undefined) continue;
      if (w.text === "--") return [...out, ...from.slice(k + 1)];
      if (w.text.startsWith("-") && w.text !== "-") {
        if (valued.test(w.text)) k++;
        continue;
      }
      out.push(w);
    }
    return out;
  };
  if (WRITE_ALL.has(program)) return positional(args);
  if (program === "chmod" || program === "chown" || program === "chgrp") return positional(args).slice(1);
  if (WRITE_DEST.has(program)) {
    const t = args.findIndex((w) => w.text === "-t" || w.text === "--target-directory");
    const dir = t === -1 ? undefined : args[t + 1];
    if (dir !== undefined) return [dir];
    const paths = positional(args, /^-(S|-suffix)$/);
    return paths.slice(-1);
  }
  if (program === "dd") return args.filter((w) => w.text.startsWith("of=")).map((w) => ({ ...w, text: w.text.slice(3) }));
  const inPlace = args.some((w) => /^-[a-zA-Z]*i/.test(w.text) || w.text.startsWith("--in-place"));
  if (program === "sed" && inPlace) {
    const hasScriptFlag = args.some((w) => ["-e", "-f", "--expression", "--file"].includes(w.text));
    const files = positional(args, /^-(e|f|-expression|-file)$/);
    return hasScriptFlag ? files : files.slice(1);
  }
  if (program === "perl" && inPlace) return positional(args, /^-[eEIM]$/);
  return [];
}

/** Substrings that inline interpreter code must not mention. */
function sensitiveMention(code: string, config: GuardConfig): string | null {
  const needles = [".git/", ".github", ".claude", ".env", ".ssh", "/proc/", "environ", "CODEOWNERS", "git push", "send-pack", config.task_dir];
  return needles.find((n) => code.toLowerCase().includes(n.toLowerCase())) ?? null;
}

function checkCommand(cmd: SimpleCommand, config: GuardConfig): Decision {
  for (const r of cmd.redirects) {
    if (r.target === null || /<<|&\d*$|^\d*[<>]&$/.test(r.op)) continue;
    if (r.op.includes(">")) {
      const d = checkWritePath(r.target, cmd, config);
      if (!d.allow) return d;
    } else if (!r.target.dynamic && isSecret(realResolve(cmd.cwd ?? "/", r.target.text), config)) {
      return deny(`reading a secret path is not allowed: ${r.target.text}`);
    }
  }
  if (cmd.program === "") return ALLOW;
  if (cmd.program === null) return deny("cannot verify a computed command name; call the program by name");
  const program = cmd.program;
  if (DENIED_PROGRAMS.has(program)) return deny(`${program} is not allowed in factory sessions`);
  if (PUBLISHERS.has(program) && cmd.args.some((a) => a.text === "publish")) return deny(`${program} publish is not allowed`);

  for (const a of cmd.args) {
    const text = argPath(a);
    if (text.includes(config.task_dir)) return deny("the task directory is not accessible from Bash; use the Write tool for allowed task files");
    if (!a.dynamic && (isSecret(realResolve(cmd.cwd ?? "/", text), config) || /\/proc\/[^/]+\/environ/.test(text))) {
      return deny(`reading a secret path is not allowed: ${a.text}`);
    }
  }
  if (program === "git") return checkGit(cmd, config);
  for (const w of writeTargets(program, cmd.args)) {
    const d = checkWritePath(w, cmd, config);
    if (!d.allow) return d;
  }
  if (INTERPRETERS.has(program)) {
    const at = cmd.args.findIndex((a) => ["-c", "-e", "-p", "--eval", "--print", "-E"].includes(a.text));
    const code = at === -1 ? undefined : cmd.args[at + 1];
    if (code !== undefined) {
      if (code.dynamic) return deny(`cannot verify computed ${program} code`);
      const hit = sensitiveMention(code.text, config);
      if (hit !== null) return deny(`inline ${program} code may not touch ${hit}`);
    }
  }
  return ALLOW;
}

function decideBash(command: string, config: GuardConfig): Decision {
  let commands: SimpleCommand[];
  try {
    commands = analyze(command, config.worktree);
  } catch (e) {
    return deny(`cannot verify this command (${e instanceof ShellParseError ? e.message : "parse error"}); simplify it`);
  }
  for (const cmd of commands) {
    const d = checkCommand(cmd, config);
    if (!d.allow) return d;
  }
  return ALLOW;
}

export function decide(call: ToolCall, config: GuardConfig | null): Decision {
  const { tool_name: tool, tool_input: input } = call;
  const resolvePath = (p: unknown): string | null => (typeof p === "string" && p !== "" ? realResolve(call.cwd, p) : null);

  if (config === null) {
    // Human session: only keep secrets out of the context.
    const key = PATH_TOOLS[tool];
    const target = key === undefined ? (tool === "Grep" ? resolvePath(input["path"]) : null) : resolvePath(input[key]);
    if (target !== null && !WRITE_TOOLS.has(tool)) return readDecision(target, null);
    return ALLOW;
  }

  if (!config.allowed_tools.includes(tool)) return deny(`${tool} is not available to the ${config.stage} stage`);

  if (tool === "Bash") {
    const command = input["command"];
    return typeof command === "string" ? decideBash(command, config) : deny("Bash call without a command");
  }
  const key = PATH_TOOLS[tool];
  if (key !== undefined) {
    const target = resolvePath(input[key]);
    if (target === null) return deny(`${tool} call without a path`);
    return WRITE_TOOLS.has(tool) ? writeDecision(target, config) : readDecision(target, config);
  }
  if (tool === "Grep" || tool === "Glob") {
    const target = resolvePath(input["path"]) ?? config.worktree;
    const d = readDecision(target, config);
    if (!d.allow) return d;
    const pattern = input[tool === "Grep" ? "glob" : "pattern"];
    if (typeof pattern === "string" && tool === "Grep" && matchesAny(pattern.replace(/^\*\*\//, ""), ["*.env", ".env", ".env.*", "*.pem", "*.key", "id_*"])) {
      return deny(`searching secret files is not allowed: ${pattern}`);
    }
    return ALLOW;
  }
  return ALLOW;
}
