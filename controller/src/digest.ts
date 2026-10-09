// A content digest of a directory tree: names, file contents, the executable bit and symlink
// targets, read without following links. Used to show an installed release was never modified
// and that a run left an operator checkout byte-identical (gate G0-3).
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export interface TreeDigest {
  digest: string;
  files: number;
}

/** `skip` takes a path relative to `root`, with `/` separators. */
export function treeDigest(root: string, skip: (rel: string) => boolean = () => false): TreeDigest {
  const h = createHash("sha256");
  let files = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (skip(rel)) continue;
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isDirectory()) {
        h.update(`d ${rel}\n`);
        walk(full, rel);
      } else if (st.isSymbolicLink()) {
        h.update(`l ${rel} ${readlinkSync(full)}\n`);
        files++;
      } else if (st.isFile()) {
        const content = createHash("sha256").update(readFileSync(full)).digest("hex");
        h.update(`f ${rel} ${(st.mode & 0o111) === 0 ? "-" : "x"} ${content}\n`);
        files++;
      } else {
        h.update(`o ${rel}\n`);
      }
    }
  };
  walk(root, "");
  return { digest: `sha256:${h.digest("hex")}`, files };
}
