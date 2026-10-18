// policy-check's sink scan: the release's sink_added rule pack, run by the gate image's opengrep
// with no network, over the PR head's changed files passed in as data on stdin. Only matches on
// added lines count, as in the SAST gate; a scan that fails fails the check.
import { Readable } from "node:stream";
import { ENGINE, exec, HARDENING } from "../../../gates/src/container.ts";
import { judgeSast } from "../../../gates/src/findings.ts";
import type { HeadFile, SinkScanner } from "./policy-check.ts";

const ROOT = "/tmp/scan";

// Writes each file under ROOT, refusing a path that leaves it, then becomes opengrep.
const LOADER = `
import json, os, sys
root = ${JSON.stringify(ROOT)}
for f in json.load(sys.stdin):
    p = os.path.normpath(os.path.join(root, f["path"]))
    if not p.startswith(root + "/"):
        sys.exit("unsafe path: " + f["path"])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as out:
        out.write(f["content"])
os.execvp("opengrep", ["opengrep", "scan", "--config", "/opt/gates/rules/sink-added.yaml", "--json", "--quiet", "--disable-version-check", "--no-git-ignore", "--disable-nosem", "--x-ignore-semgrepignore-files", "--max-target-bytes=0", root])
`;

export class SinkScanError extends Error {}

export function containerSinkScanner(image: string, timeoutMs = 600_000): SinkScanner {
  return async (files: readonly HeadFile[]) => {
    if (files.length === 0) return [];
    const args = ["run", "--rm", "-i", ...HARDENING, "--network", "none", image, "python3", "-c", LOADER];
    const r = await exec(ENGINE, args, { timeoutMs, stdin: Readable.from([JSON.stringify(files.map((f) => ({ path: f.path, content: f.content })))]) });
    if (r.timedOut) throw new SinkScanError(`the sink scan timed out after ${String(timeoutMs / 1000)} s`);
    const added = new Map(files.map((f) => [f.path, new Set(f.added)]));
    const j = judgeSast(r.stdout, r.status, added, ROOT);
    if (j.outcome.status === "error") throw new SinkScanError(`${j.outcome.summary}${r.stderr.trim() === "" ? "" : `: ${r.stderr.trim().slice(-500)}`}`);
    return j.sinks;
  };
}
