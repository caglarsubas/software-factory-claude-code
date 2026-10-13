// Crash-safe file writes (ROADMAP P1-02). A file is written to a temporary name, flushed and
// renamed, so a reader sees the old content or the new, never a torn mix. Stage artifacts go
// one step further: they are written as `<name>.pending`, committed by an `artifact_committed`
// event, and only then renamed into place. A crash before the event leaves a stray `.pending`
// that recovery deletes; a crash after it leaves one that recovery rolls forward.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const PENDING = ".pending";
/** Temporary files writeAtomic leaves behind when the process dies mid-write. */
export const TMP = /\.tmp-[0-9]+$/;

export const sha256 = (data: Buffer | string): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

export const fileDigest = (path: string): string => sha256(readFileSync(path));

/** Flushes a directory entry, so a rename in it survives a power loss. Some platforms refuse; the rename itself is still atomic. */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Not supported for directories here (e.g. some network file systems).
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function writeAtomic(path: string, data: Buffer | string, mode = 0o600): void {
  const tmp = `${path}.tmp-${String(process.pid)}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

/** Moves a committed `.pending` file into place. */
export function finalize(path: string): void {
  renameSync(`${path}${PENDING}`, path);
  fsyncDir(dirname(path));
}
