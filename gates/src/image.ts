// The gate image, tagged with a hash of its build inputs and built on first use.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE, LABEL } from "./container.ts";

export const GATES_DIR = fileURLToPath(new URL("../", import.meta.url));

/** Exactly what the Dockerfile copies (see image/Dockerfile.dockerignore), plus the Dockerfile. */
export function imageInputs(): string[] {
  const seed = readdirSync(join(GATES_DIR, "image/osv-seed")).map((f) => `image/osv-seed/${f}`);
  const rules = readdirSync(join(GATES_DIR, "rules")).filter((f) => f.endsWith(".yaml")).map((f) => `rules/${f}`);
  return ["image/Dockerfile", "image/Dockerfile.dockerignore", ...seed, ...rules].sort();
}

export function imageTag(): string {
  const hash = createHash("sha256");
  for (const rel of imageInputs()) hash.update(rel).update("\0").update(readFileSync(join(GATES_DIR, rel))).update("\0");
  return `software-factory-gates:${hash.digest("hex").slice(0, 16)}`;
}

export function ensureImage(tag: string = imageTag()): string {
  if (spawnSync(ENGINE, ["image", "inspect", tag], { stdio: "ignore" }).status === 0) return tag;
  const r = spawnSync(ENGINE, ["build", "--file", join(GATES_DIR, "image/Dockerfile"), "--label", LABEL, "--tag", tag, GATES_DIR], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`building ${tag} failed:\n${r.stderr.slice(-4000)}`);
  return tag;
}
