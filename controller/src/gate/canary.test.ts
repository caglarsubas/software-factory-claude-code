// G2-5's audit: a secret is found in a git bundle, where it is compressed and often only a
// delta's insert; the needles a secret file yields leave its PEM armour and short lines out.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bundleContents, scanRecords, scanTree, secretNeedles, type Needle } from "./canary.ts";

const scratch = mkdtempSync(join(tmpdir(), "canary-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

const secret = "sf-canary-0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccdd";
const needles: Needle[] = [{ name: "canary", value: Buffer.from(secret) }];

/** A long file committed, then shortened with a change in its middle: git packs the shorter version as a delta against the longer. */
function bundle(name: string, change: (text: string) => string): string {
  const repo = join(scratch, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  const text = Array.from({ length: 400 }, (_, n) => `line ${String(n)}: the quick brown fox jumps over the lazy dog`).join("\n");
  writeFileSync(join(repo, "notes.txt"), `${text}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  writeFileSync(join(repo, "notes.txt"), `${change(text.split("\n").slice(0, 300).join("\n"))}\n`);
  git(repo, "commit", "-qam", "candidate");
  mkdirSync(join(scratch, "bundles"), { recursive: true });
  const file = join(scratch, "bundles", `${name}.bundle`);
  git(repo, "bundle", "create", "-q", file, "--all");
  return file;
}

describe("the canary audit", () => {
  it("finds a secret a bundle holds as a delta's insert, which the raw file hides", () => {
    const file = bundle("delta", (t) => t.replace("line 200:", `line 200: ${secret}`));
    const raw = readFileSync(file);
    expect(raw.includes(secret)).toBe(false);
    expect(bundleContents(raw)?.some((o) => o.includes(secret))).toBe(true);
    const s = scanTree(join(scratch, "bundles"), "runs", needles);
    expect(s.bundles).toBe(1);
    expect(s.hits).toEqual([{ needle: "canary", where: "runs/delta.bundle" }]);
  });

  it("finds a secret split across a delta's 127-byte inserts", () => {
    const filler = "x".repeat(120);
    const file = bundle("split", (t) => t.replace("line 250:", `line 250: ${filler}${secret}${filler}`));
    expect(bundleContents(readFileSync(file))?.some((o) => o.includes(secret))).toBe(true);
  });

  it("finds nothing in a clean bundle, and treats any other file as plain bytes", () => {
    const file = bundle("clean", (t) => t.replace("line 10:", "line 10: nothing to see"));
    expect(bundleContents(readFileSync(file))?.some((o) => o.includes(secret))).toBe(false);
    expect(bundleContents(Buffer.from("not a bundle"))).toBeNull();
    expect(scanRecords([{ where: "event store: T-0001 seq 3", text: JSON.stringify({ env: secret }) }], needles)).toEqual([{ needle: "canary", where: "event store: T-0001 seq 3" }]);
  });

  it("takes a secret file's long lines as needles, leaving PEM armour out", () => {
    const pem = ["-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "short", "-----END PRIVATE KEY-----"].join("\n");
    expect(secretNeedles("github-app.pem", pem).map((n) => n.name)).toEqual(["github-app.pem"]);
    expect(secretNeedles("anthropic.key", "sk-ant-0123456789abcdefghij\n").map((n) => n.value.toString())).toEqual(["sk-ant-0123456789abcdefghij"]);
    expect(secretNeedles("serve.token", "a\nb\n")).toEqual([]);
  });
});
