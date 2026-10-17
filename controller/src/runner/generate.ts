// Writes the runner's generated files from their one source each: the managed settings from the
// release's policies, config and hooks.json (managed.ts), and the seccomp profile from Docker's
// default (seccomp.ts). A test fails when a committed file differs from what this writes.
//
//   node controller/src/runner/generate.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../policy/load.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { managedSettingsJson } from "./managed.ts";
import { runnerSeccomp } from "./seccomp.ts";

export const GENERATED = {
  managed: "runner/managed-settings.json",
  seccomp: "runner/seccomp/runner.json",
} as const;

export function generated(root: string = REPO_ROOT): Record<keyof typeof GENERATED, string> {
  return { managed: managedSettingsJson(loadRelease(createValidator(), root)), seccomp: runnerSeccomp() };
}

if (import.meta.main) {
  const files = generated();
  for (const [k, rel] of Object.entries(GENERATED)) writeFileSync(join(REPO_ROOT, rel), files[k as keyof typeof GENERATED]);
  process.stdout.write(`wrote ${Object.values(GENERATED).join(", ")}\n`);
}
