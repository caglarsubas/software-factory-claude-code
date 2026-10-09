// A commit's tree as a tar stream, read straight from the object database. Not `git archive`:
// it applies export-ignore and export-subst from the tree's own .gitattributes, so a change
// could hide a file from every gate, and --attr-source does not override that.
import { spawn, spawnSync } from "node:child_process";
import type { Writable } from "node:stream";

export interface TreeEntry {
  mode: string;
  oid: string;
  path: string;
}

const MAX_BUFFER = 256 * 1024 * 1024;

function git(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (r.status !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Every file and symlink in the commit; submodules have no content here and are skipped. */
export function listTree(repo: string, commit: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode = "", type = "", oid = ""] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (type !== "blob") continue;
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new Error(`refusing tree path ${JSON.stringify(path)}`);
    }
    entries.push({ mode, oid, path });
  }
  return entries;
}

export function commitTime(repo: string, commit: string): number {
  return Number(git(repo, ["show", "-s", "--format=%ct", commit]).trim());
}

/** Stream blob contents for `oids`, in order, through one `git cat-file --batch`. */
async function* blobs(repo: string, oids: readonly string[]): AsyncGenerator<Buffer> {
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  child.stdin.end(oids.map((o) => `${o}\n`).join(""));
  let pending: Buffer = Buffer.alloc(0);
  let want: number | null = null;
  const parts: Buffer[] = [];
  let have = 0;
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (want === null) {
        const nl = pending.indexOf(10);
        if (nl < 0) break;
        const header = pending.subarray(0, nl).toString("utf8").split(" ");
        if (header[1] !== "blob") throw new Error(`git cat-file: unexpected object ${header.join(" ")}`);
        want = Number(header[2]);
        pending = pending.subarray(nl + 1);
      }
      const take = Math.min(want - have, pending.length);
      parts.push(pending.subarray(0, take));
      have += take;
      pending = pending.subarray(take);
      if (have < want || pending.length === 0) break; // the trailing newline has not arrived yet
      yield Buffer.concat(parts, want);
      pending = pending.subarray(1);
      parts.length = 0;
      have = 0;
      want = null;
    }
  }
  if ((await exited) !== 0) throw new Error("git cat-file --batch failed");
  if (want !== null) throw new Error("git cat-file --batch ended early");
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(fields: { name: string; mode: number; size: number; mtime: number; type: string; linkname?: string }): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(fields.name, 0, 100, "utf8");
  h.write(octal(fields.mode, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(fields.size, 12), 124, "ascii");
  h.write(octal(fields.mtime, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(fields.type, 156, "ascii");
  h.write(fields.linkname ?? "", 157, 100, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** A PAX record set for names a ustar header cannot hold (long or non-ASCII). */
function pax(name: string, linkname: string | undefined, mtime: number): Buffer[] {
  const fits = (s: string): boolean => Buffer.byteLength(s) <= 100 && /^[\x20-\x7e]*$/.test(s);
  if (fits(name) && (linkname === undefined || fits(linkname))) return [];
  const record = (key: string, value: string): string => {
    const body = ` ${key}=${value}\n`;
    let len = Buffer.byteLength(body) + 1;
    while (Buffer.byteLength(`${String(len)}${body}`) !== len) len++;
    return `${String(len)}${body}`;
  };
  const data = Buffer.from(record("path", name) + (linkname === undefined ? "" : record("linkpath", linkname)), "utf8");
  return [header({ name: "././@PaxHeader", mode: 0o644, size: data.length, mtime, type: "x" }), data, padding(data.length)];
}

function write(out: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.write(chunk)) resolve();
    else {
      out.once("drain", resolve);
      out.once("error", reject);
    }
  });
}

/** Write the entries as a tar archive to `out` and end it. */
export async function writeTar(repo: string, entries: readonly TreeEntry[], mtime: number, out: Writable): Promise<void> {
  let i = 0;
  for await (const content of blobs(repo, entries.map((e) => e.oid))) {
    const entry = entries[i++];
    if (entry === undefined) throw new Error("git cat-file returned more objects than requested");
    const symlink = entry.mode === "120000";
    const linkname = symlink ? content.toString("utf8") : undefined;
    const size = symlink ? 0 : content.length;
    for (const part of pax(entry.path, linkname, mtime)) await write(out, part);
    await write(out, header({ name: entry.path, mode: entry.mode === "100755" ? 0o755 : 0o644, size, mtime, type: symlink ? "2" : "0", ...(linkname === undefined ? {} : { linkname }) }));
    if (!symlink) {
      await write(out, content);
      await write(out, padding(size));
    }
  }
  if (i !== entries.length) throw new Error("git cat-file returned fewer objects than requested");
  await write(out, Buffer.alloc(BLOCK * 2));
  out.end();
}
