// The canary-secret audit (ROADMAP G2-5). `factoryctl gate G2 --begin` plants a canary: a random
// value in the factory's secret store, which every run and serve also carry in their own
// environment, where a leaked secret would come from. The audit then looks for the canary, and
// for the factory's real secrets, in everything a run leaves: transcripts, run directories and
// their git bundles, the object store, the session config dirs, OTel files, proxy logs and the
// event store. It reports where a secret was found by name and path, never the secret itself.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inflateSync } from "node:zlib";
import { sha256, writeAtomic } from "../fsutil.ts";
import type { Home } from "../home.ts";

/** The environment name each run and serve give the canary (never a session: the env allowlist leaves it out). */
export const CANARY_ENV = "FACTORY_CANARY";

export const canaryPath = (home: Home): string => join(home.secrets, "canary");

/** Plants a fresh canary; returns its digest, which is all the evidence ever records of it. */
export function plantCanary(home: Home): string {
  const value = `sf-canary-${randomBytes(24).toString("hex")}`;
  writeAtomic(canaryPath(home), `${value}\n`, 0o600);
  return sha256(value);
}

export function readCanary(home: Home): string | null {
  const path = canaryPath(home);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value === "" ? null : value;
}

/** A value the audit looks for, under a name the evidence may print. */
export interface Needle {
  name: string;
  value: Buffer;
}

/** Shorter lines are too likely to occur by chance (and PEM armour lines are public). */
const MIN_SECRET = 20;

/** The needles a secret file holds: each line long enough to be secret material, PEM armour aside. */
export function secretNeedles(name: string, content: string): Needle[] {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= MIN_SECRET && !l.startsWith("-----"));
  return lines.map((l, i) => ({ name: lines.length === 1 ? name : `${name} line ${String(i + 1)}`, value: Buffer.from(l) }));
}

// --- git bundles -------------------------------------------------------------------------
// A bundle's objects are zlib-compressed in a pack, and a delta holds its new text in insert
// instructions of at most 127 bytes; a scan of the raw file would miss a secret in either. So
// the audit inflates every object, and of a delta keeps its inserted bytes, run together.

const varint = (buf: Buffer, at: number): [number, number] => {
  let value = 0;
  let shift = 0;
  let c: number;
  do {
    c = buf[at++] ?? 0;
    value += (c & 0x7f) * 2 ** shift;
    shift += 7;
  } while ((c & 0x80) !== 0);
  return [value, at];
};

/** A delta's inserted bytes: consecutive inserts run together, a copy between them leaves a break. */
function deltaInserts(delta: Buffer): Buffer {
  let at = varint(delta, varint(delta, 0)[1])[1];
  const parts: Buffer[] = [];
  let run: Buffer[] = [];
  while (at < delta.length) {
    const op = delta[at++] ?? 0;
    if ((op & 0x80) !== 0) {
      for (let bit = 0; bit < 7; bit++) if ((op & (1 << bit)) !== 0) at++;
      if (run.length > 0) parts.push(Buffer.concat(run), Buffer.from("\n"));
      run = [];
    } else if (op !== 0) {
      run.push(delta.subarray(at, at + op));
      at += op;
    }
  }
  if (run.length > 0) parts.push(Buffer.concat(run));
  return Buffer.concat(parts);
}

/** Every object of a pack, inflated; a delta as its inserted bytes. A damaged pack yields what came before the damage. */
export function packContents(pack: Buffer): Buffer[] {
  if (pack.subarray(0, 4).toString("latin1") !== "PACK") return [];
  const count = pack.readUInt32BE(8);
  const out: Buffer[] = [];
  let at = 12;
  for (let n = 0; n < count && at < pack.length; n++) {
    let c = pack[at++] ?? 0;
    const type = (c >> 4) & 7;
    while ((c & 0x80) !== 0) c = pack[at++] ?? 0;
    if (type === 6) {
      do c = pack[at++] ?? 0;
      while ((c & 0x80) !== 0);
    } else if (type === 7) at += 20;
    try {
      const r = inflateSync(pack.subarray(at), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      out.push(type === 6 || type === 7 ? deltaInserts(r.buffer) : r.buffer);
      at += r.engine.bytesWritten;
    } catch {
      break;
    }
  }
  return out;
}

/** A git bundle's objects (v2 or v3), or null for any other file. */
export function bundleContents(file: Buffer): Buffer[] | null {
  if (!/^# v[23] git bundle\n/.test(file.subarray(0, 20).toString("latin1"))) return null;
  const start = file.indexOf("\n\nPACK");
  return start === -1 ? [] : packContents(file.subarray(start + 2));
}

// --- the scan ----------------------------------------------------------------------------

export interface Hit {
  needle: string;
  /** Where, relative to the scanned tree and named by it: e.g. `runs/T-0004/transcripts/build.ndjson`. */
  where: string;
}

export interface Scanned {
  files: number;
  bytes: number;
  bundles: number;
  hits: Hit[];
}

const hitsIn = (contents: readonly Buffer[], needles: readonly Needle[], where: string): Hit[] =>
  needles.filter((n) => contents.some((c) => c.includes(n.value))).map((n) => ({ needle: n.name, where }));

/** Scans every regular file under `root` (symlinks are not followed), named `label/<relative path>`. */
export function scanTree(root: string, label: string, needles: readonly Needle[]): Scanned {
  const s: Scanned = { files: 0, bytes: 0, bundles: 0, hits: [] };
  if (!existsSync(root)) return s;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        const raw = readFileSync(path);
        const objects = bundleContents(raw);
        s.files++;
        s.bytes += raw.length;
        if (objects !== null) s.bundles++;
        s.hits.push(...hitsIn([raw, ...(objects ?? [])], needles, `${label}/${relative(root, path)}`));
      }
    }
  };
  walk(root);
  return s;
}

/** Scans text records (the event store's events), each named by `where`. */
export function scanRecords(records: readonly { where: string; text: string }[], needles: readonly Needle[]): Hit[] {
  return records.flatMap((r) => hitsIn([Buffer.from(r.text)], needles, r.where));
}
