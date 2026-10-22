// Admission (ROADMAP P1-08, P2-11, ADR 0003): a repository becomes a factory target only when all
// of these hold at the commit onboarding inventoried:
//
// - every command gate of its profile is green in the gate image, the way the gates will run
//   them on every task (P1-08 found that green in the target's own CI is not enough);
// - it has CI of its own;
// - its default branch is protected.
//
// The profile itself must also be valid and name its approvers. Admission changes nothing on
// GitHub; the report is the operator's to read at the STOP.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cacheVolumeFor, type GatesResult, type RunOptions } from "../../../gates/src/run.ts";
import { createTaskClone } from "../git/repo.ts";
import type { Home } from "../home.ts";
import type { Validator } from "../schemas/validate.ts";
import type { Inventory } from "./inventory.ts";
import type { Admission, AdmissionCheck } from "./registry.ts";
import type { TargetReads } from "./github.ts";

/** The id the gates run under for admission: one `nextTaskId` never issues. */
export const ADMISSION_TASK = "T-0000";

export interface AdmissionInput {
  home: Home;
  repo: string;
  mirror: string;
  inventory: Inventory;
  profile: unknown;
  profileDigest: string;
  validator: Validator;
  reads: TargetReads;
  runGates: (o: RunOptions, label: string) => Promise<GatesResult>;
  gateImage: () => string;
  now: Date;
  log: (line: string) => void;
}

export async function admit(i: AdmissionInput): Promise<Admission> {
  const checks: AdmissionCheck[] = [];
  const valid = i.validator.validate("profile.schema.json", i.profile);
  const p = i.profile as { target?: { repo?: string }; governance?: { approvers?: string[] }; commands?: Record<string, string>; gates?: { adapters: string[]; sast_rules?: string[] } };
  const problems = [
    ...valid.errors,
    ...(p.target?.repo === i.repo ? [] : [`target.repo is ${p.target?.repo ?? "missing"}, not ${i.repo}`]),
    ...((p.governance?.approvers ?? []).length > 0 ? [] : ["governance.approvers names nobody: the footprint needs its approvers"]),
  ];
  checks.push({ name: "profile", ok: problems.length === 0, detail: problems.length === 0 ? "valid, with its approvers" : problems.join("; ") });
  checks.push({ name: "ci", ok: i.inventory.ci.length > 0, detail: i.inventory.ci.length > 0 ? `its own CI: ${i.inventory.ci.join(", ")}` : "no workflow of its own in .github/workflows: a target needs CI that runs on every PR" });
  try {
    const protectedBranch = await i.reads.protectedBranch(i.repo, i.inventory.default_branch);
    checks.push({ name: "protection", ok: protectedBranch, detail: protectedBranch ? `${i.inventory.default_branch} is protected` : `${i.inventory.default_branch} has no branch protection or ruleset: protect it first` });
  } catch (e) {
    checks.push({ name: "protection", ok: false, detail: `could not read ${i.inventory.default_branch}'s protection: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (valid.valid && p.commands !== undefined && p.gates !== undefined) {
    // The gates judge a clean checkout of the inventoried commit against itself: every command runs, nothing is a change.
    const dir = join(i.home.worktrees, `${ADMISSION_TASK}-${i.repo.replace("/", "__")}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(i.home.worktrees, { recursive: true, mode: 0o700 });
    try {
      createTaskClone(i.mirror, dir, "admission", i.inventory.head);
      const result = await i.runGates({
        worktree: dir, base: i.inventory.head, taskId: ADMISSION_TASK, profile: { commands: p.commands as RunOptions["profile"]["commands"], gates: p.gates }, image: i.gateImage(),
        cacheVolume: cacheVolumeFor(i.repo), osvVolume: "sf-gates-osv", log: i.log,
      }, "admission");
      const commandGates = result.gates.filter((g) => Object.keys(p.commands ?? {}).includes(g.name));
      const failing = result.gates.filter((g) => g.status !== "pass");
      checks.push({
        name: "gates",
        ok: result.passed && commandGates.every((g) => g.status === "pass"),
        detail: failing.length === 0 ? `green in the gate image: ${result.gates.map((g) => g.name).join(", ")}` : failing.map((g) => `${g.name} ${g.status}: ${g.summary.split("\n")[0] ?? ""}`).join("; "),
      });
    } catch (e) {
      checks.push({ name: "gates", ok: false, detail: `the gates did not run: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    checks.push({ name: "gates", ok: false, detail: "not run: the profile is not valid" });
  }
  return { at: i.now.toISOString(), head: i.inventory.head, profile_digest: i.profileDigest, passed: checks.every((c) => c.ok), checks };
}
