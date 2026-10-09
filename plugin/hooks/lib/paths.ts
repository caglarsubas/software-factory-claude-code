// Path resolution and glob matching for the guard. No dependencies: hooks ship inside
// the plugin and must run with nothing but Node installed.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Glob to RegExp: `**` spans directories, `*` and `?` stay within one segment. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        const slashAfter = glob.charAt(i + 2) === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += /[\\^$.|+()[\]{}]/.test(c) ? `\\${c}` : c;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Resolve `target` from `cwd`, following symlinks for the part that exists, so a link
 * named `notes.txt` that points at `.env` is judged as `.env`.
 */
export function realResolve(cwd: string, target: string): string {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(existing);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

/** Repository-relative path with forward slashes, or null when `absolute` is outside `root`. */
export function inside(root: string, absolute: string): string | null {
  const realRoot = realResolve("/", root);
  if (absolute === realRoot) return "";
  const rel = relative(realRoot, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}
