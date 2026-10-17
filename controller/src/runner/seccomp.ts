// The runner's seccomp profile: Docker's default (runner/seccomp/moby-default.json, vendored
// from github.com/moby/profiles, Apache-2.0) plus one rule. Claude Code's Bash sandbox is
// bubblewrap, which needs user, mount, pid and network namespaces; the default profile allows
// the namespace syscalls only with CAP_SYS_ADMIN, and the runner has no capabilities at all.
// The extra rule allows them without one: inside the runner they only ever create namespaces
// owned by the runner's own unprivileged user.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../policy/load.ts";

export const SECCOMP_DIR = join(REPO_ROOT, "runner/seccomp");
/** The vendored upstream profile; a change to it is a reviewed change to this pin. */
export const UPSTREAM_SHA256 = "6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6";
export const NAMESPACE_SYSCALLS = ["clone", "mount", "pivot_root", "setns", "umount2", "unshare"];

interface Rule {
  names: string[];
  action: string;
  comment?: string;
}

export function runnerSeccomp(upstream: string = readFileSync(join(SECCOMP_DIR, "moby-default.json"), "utf8")): string {
  const digest = createHash("sha256").update(upstream).digest("hex");
  if (digest !== UPSTREAM_SHA256) throw new Error(`runner/seccomp/moby-default.json is ${digest}, not the pinned ${UPSTREAM_SHA256}`);
  const profile = JSON.parse(upstream) as { syscalls: Rule[] };
  profile.syscalls.push({
    names: NAMESPACE_SYSCALLS,
    action: "SCMP_ACT_ALLOW",
    comment: "software-factory runner: bubblewrap's namespaces for an unprivileged user (no capabilities)",
  });
  return `${JSON.stringify(profile, null, 2)}\n`;
}
