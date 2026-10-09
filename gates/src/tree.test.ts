import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { commitTime, listTree, writeTar } from "./tree.ts";

const root = mkdtempSync(join(tmpdir(), "tree-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const repo = join(root, "repo");
const sh = (cmd: string, args: string[], cwd = repo) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
mkdirSync(join(repo, "src/deep/" + "d".repeat(60)), { recursive: true });
sh("git", ["init", "-q"]);
writeFileSync(join(repo, ".gitattributes"), "hidden.py export-ignore\nsubst.txt export-subst\n");
writeFileSync(join(repo, "hidden.py"), "import os\nos.system('x')\n");
writeFileSync(join(repo, "subst.txt"), "$Format:%H$\n");
writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
writeFileSync(join(repo, "src/é ü.txt"), "unicode name\n");
const longPath = `src/deep/${"d".repeat(60)}/${"f".repeat(80)}.ts`;
writeFileSync(join(repo, longPath), "export {};\n");
writeFileSync(join(repo, "big.bin"), Buffer.alloc(300_000, 7));
writeFileSync(join(repo, "empty"), "");
symlinkSync("src/é ü.txt", join(repo, "link"));
sh("git", ["add", "-A"]);
sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);

async function extract(): Promise<string> {
  const entries = listTree(repo, "HEAD");
  const out = join(root, `out-${String(Math.random()).slice(2)}`);
  mkdirSync(out);
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  await writeTar(repo, entries, commitTime(repo, "HEAD"), stream);
  const r = spawnSync("tar", ["-x", "-C", out], { input: Buffer.concat(chunks) });
  expect(r.status, r.stderr.toString()).toBe(0);
  return out;
}

describe("writeTar", () => {
  it("includes files that export-ignore would hide, byte for byte, with no substitution", async () => {
    const out = await extract();
    expect(readFileSync(join(out, "hidden.py"), "utf8")).toContain("os.system");
    expect(readFileSync(join(out, "subst.txt"), "utf8")).toBe("$Format:%H$\n");
    expect(readFileSync(join(out, "big.bin")).equals(Buffer.alloc(300_000, 7))).toBe(true);
    expect(readFileSync(join(out, "empty"), "utf8")).toBe("");
  });
  it("keeps long and non-ASCII names, the executable bit and symlinks", async () => {
    const out = await extract();
    expect(readFileSync(join(out, longPath), "utf8")).toBe("export {};\n");
    expect(readFileSync(join(out, "src/é ü.txt"), "utf8")).toBe("unicode name\n");
    expect(lstatSync(join(out, "run.sh")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(out, "link"))).toBe("src/é ü.txt");
  });
  it("lists exactly the committed paths", () => {
    expect(listTree(repo, "HEAD").map((e) => e.path).sort()).toEqual(
      [".gitattributes", "big.bin", "empty", "hidden.py", "link", "run.sh", "src/é ü.txt", longPath, "subst.txt"].sort(),
    );
  });
});
