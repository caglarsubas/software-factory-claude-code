// The object store (ROADMAP P2-07, principle 8): content-addressed and write-once. Every
// committed artifact goes in before its commit event is written, keyed by the same sha256
// digest the event records, and every run's evidence (its transcripts, manifest and the files
// it committed) goes in at the run's end as a tree object, recorded by an `evidence_stored`
// event. Nothing in it is ever changed, so the event log is its index: any version of any
// artifact a task ever committed can be read back by the digest an event names, and a replica
// copies only what it lacks. An object is deleted only by record (ADR 0003): a purge deletes
// what its purged tasks referenced and no remaining task does.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PENDING, sha256, TMP, writeAtomic } from "../fsutil.ts";

const DIGEST = /^sha256:([0-9a-f]{64})$/;

/** An object's file: `<root>/sha256/<2 hex>/<62 hex>`. */
export function objectPath(root: string, digest: string): string {
  const hex = DIGEST.exec(digest)?.[1];
  if (hex === undefined) throw new Error(`not a sha256 digest: ${digest}`);
  return join(root, "sha256", hex.slice(0, 2), hex.slice(2));
}

export const hasObject = (root: string, digest: string): boolean => existsSync(objectPath(root, digest));

/** Stores content once; returns its digest. Writing what is already there changes nothing. */
export function putObject(root: string, content: Buffer | string): string {
  const digest = sha256(content);
  const path = objectPath(root, digest);
  if (existsSync(path)) return digest;
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeAtomic(path, content);
  return digest;
}

/** An object's content, checked against its digest: a damaged object is an error, never data. */
export function readObject(root: string, digest: string): Buffer {
  const content = readFileSync(objectPath(root, digest));
  if (sha256(content) !== digest) throw new Error(`object ${digest} is damaged`);
  return content;
}

/** Deletes an object; returns whether it was there. Only a purge calls this (durable/purge.ts). */
export function deleteObject(root: string, digest: string): boolean {
  const path = objectPath(root, digest);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Every object's digest. */
export function listObjects(root: string): string[] {
  const base = join(root, "sha256");
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((prefix) => readdirSync(join(base, prefix)).filter((rest) => !TMP.test(rest)).map((rest) => `sha256:${prefix}${rest}`));
}

/** A tree object: the digest of every file of a run's evidence, by path relative to the run directory. */
export interface Tree {
  schema_version: 1;
  files: Record<string, string>;
}

/** What a run directory keeps as evidence: everything but the judges' bundle (rebuilt from it) and unfinished writes. */
const isEvidence = (rel: string): boolean => !rel.startsWith("bundle/") && rel !== "bundle" && !rel.endsWith(PENDING) && !TMP.test(rel);

function files(root: string, dir: string = root): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) return files(root, full);
    return s.isFile() ? [relative(root, full)] : [];
  });
}

/** Stores a run directory's evidence and the tree that indexes it; returns the tree's digest and size. */
export function storeTree(root: string, runDir: string): { tree: string; files: number } {
  const tree: Tree = { schema_version: 1, files: {} };
  for (const rel of files(runDir).filter(isEvidence).sort()) tree.files[rel] = putObject(root, readFileSync(join(runDir, rel)));
  return { tree: putObject(root, `${JSON.stringify(tree)}\n`), files: Object.keys(tree.files).length };
}

export function readTree(root: string, digest: string): Tree {
  return JSON.parse(readObject(root, digest).toString("utf8")) as Tree;
}
