// The runner image, tagged with a hash of its build inputs and built on first use, from the
// release it belongs to (its root is the build context; runner/Dockerfile.dockerignore admits
// only the files the image copies).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "../../../gates/src/container.ts";

/** On the image only: containers inherit image labels, so this must not be a container's label. */
export const RUNNER_IMAGE_LABEL = "software-factory.runner-image=1";

/** Exactly what the Dockerfile copies, plus the Dockerfile and its ignore file. */
export function runnerImageInputs(root: string): string[] {
  const lib = readdirSync(join(root, "plugin/hooks/lib")).filter((f) => f.endsWith(".ts")).map((f) => `plugin/hooks/lib/${f}`);
  return [
    "runner/Dockerfile",
    "runner/Dockerfile.dockerignore",
    "runner/managed-settings.json",
    "runner/egress/proxy.ts",
    ...["guard", "require-gates", "format-typecheck", "ledger"].map((h) => `plugin/hooks/${h}.ts`),
    ...lib,
  ].sort();
}

export function runnerImageTag(root: string): string {
  const hash = createHash("sha256");
  for (const rel of runnerImageInputs(root)) hash.update(rel).update("\0").update(readFileSync(join(root, rel))).update("\0");
  return `software-factory-runner:${hash.digest("hex").slice(0, 16)}`;
}

export function ensureRunnerImage(root: string, tag: string = runnerImageTag(root)): string {
  if (spawnSync(ENGINE, ["image", "inspect", tag], { stdio: "ignore" }).status === 0) return tag;
  const r = spawnSync(ENGINE, ["build", "--file", join(root, "runner/Dockerfile"), "--label", RUNNER_IMAGE_LABEL, "--tag", tag, root], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DOCKER_BUILDKIT: "1" },
  });
  if (r.status !== 0) throw new Error(`building ${tag} failed:\n${r.stderr.slice(-4000)}`);
  return tag;
}
