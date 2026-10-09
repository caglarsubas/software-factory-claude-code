// `factoryctl gate G0` (ROADMAP §5, Gate G0): runs the gate's automated criteria and drafts the
// evidence PR the operator signs. Two steps around the fixture dry runs:
//
//   gate G0 --begin   snapshots each operator checkout and opens the evidence window;
//   gate G0           checks G0-1 to G0-4 against everything recorded since, and writes
//                     $FACTORY_HOME/gates/G0/evidence.json and evidence.md (the PR body).
//
// The evidence reads only the event store, the run directories and the release, never what an
// agent wrote about its own work. evidence.md holds IDs, links and aggregates only: it goes into
// the public repository.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { treeDigest, type TreeDigest } from "../digest.ts";
import type { Check } from "../doctor.ts";
import { fixtureNames, loadFixture, mirrorRepo } from "../fixtures/targets.ts";
import type { CommitChecks } from "../github/client.ts";
import { runDir, type Home } from "../home.ts";
import type { Release } from "../release.ts";
import { verifyRelease } from "../release/install.ts";
import type { Validator } from "../schemas/validate.ts";
import { ENV_ALLOWLIST } from "../session/env.ts";
import type { EventStore, FactoryEvent } from "../store/events.ts";
import { currentState, currentStatePayload } from "../task/lifecycle.ts";
import { readTask } from "../task/task.ts";

export interface Snapshot extends TreeDigest {
  path: string;
}

export interface Begin {
  schema_version: 1;
  gate: "G0";
  started_at: string;
  release: { sha: string; tag: string } | null;
  checkouts: Snapshot[];
}

export interface Criterion {
  id: "G0-1" | "G0-2" | "G0-3" | "G0-4" | "G0-5";
  criterion: string;
  status: "pass" | "fail" | "human";
  detail: string;
  evidence: string[];
}

export interface Evidence {
  schema_version: 1;
  gate: "G0";
  generated_at: string;
  release: { sha: string; tag: string; files_digest: string } | null;
  /** The automated criteria (G0-1 to G0-4) all pass; G0-5 is the operator's signature. */
  passed: boolean;
  criteria: Criterion[];
}

export interface G0Deps {
  /** The bypass variants through the guard hook (plugin/hooks/bypass-cases.ts). */
  bypass: () => { variants: number; denied: number; failures: string[] };
  checks: CommitChecks;
  doctor: Check[];
  /** The factory repository on GitHub; defaults to the release's own. */
  repository: string | null;
}

export interface G0Inputs {
  home: Home;
  store: EventStore;
  validator: Validator;
  release: Release;
  deps: G0Deps;
  now?: Date;
}

const gateDir = (home: Home): string => join(home.gates, "G0");
const beginPath = (home: Home): string => join(gateDir(home), "begin.json");
/** The sessions a full run has: G0-1 needs each, live. */
const SESSIONS = ["triage", "spec", "build", "review-code", "review-security", "approve", "summarize"];
const ARTIFACTS = ["task.json", "spec.md", "spec.yaml", "gates.json", "review-code.json", "review-security.json", "verdict.json", "summary.json", "publish.json", "manifest.json"];
const sha256 = (data: Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
/** Git rewrites its index, a stat cache, on read-only commands such as a shell prompt's `git status`. */
const checkoutDigest = (path: string): TreeDigest => treeDigest(path, (rel) => rel === ".git/index");

/** Snapshot the operator checkouts before the dry runs (G0-3 compares them afterwards). */
export function beginG0(home: Home, release: Release, checkouts: string[], now: Date = new Date()): Begin {
  if (checkouts.length === 0) throw new Error("name at least one operator checkout (--checkout DIR)");
  const begin: Begin = {
    schema_version: 1,
    gate: "G0",
    started_at: now.toISOString(),
    release: release.info === null ? null : { sha: release.info.sha, tag: release.info.tag },
    checkouts: checkouts.map((path) => ({ path, ...checkoutDigest(path) })),
  };
  mkdirSync(gateDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(beginPath(home), `${JSON.stringify(begin, null, 2)}\n`, { mode: 0o600 });
  return begin;
}

export function readBegin(home: Home): Begin | null {
  return existsSync(beginPath(home)) ? (JSON.parse(readFileSync(beginPath(home), "utf8")) as Begin) : null;
}

const sessionsOf = (events: FactoryEvent[]): FactoryEvent[] => events.filter((e) => e.type === "stage_started" && typeof e.payload["runner"] === "string");

/** Why a task is not a complete live dry run on `repo` with the installed release; empty when it is. */
function dryRunProblems(i: G0Inputs, id: string, repo: string): { problems: string[]; pr: string; sessions: number; usd: number } {
  const problems: string[] = [];
  const events = i.store.events(id);
  const payload = currentStatePayload(events);
  const pr = typeof payload["pr_url"] === "string" ? payload["pr_url"] : "";
  if (currentState(events) !== "NEEDS_HUMAN" || payload["gate"] !== "merge") problems.push(`state ${currentState(events)}, not at the merge gate`);
  if (!pr.startsWith(`https://github.com/${repo}/pull/`) || !/\/pull\/[0-9]+$/.test(pr)) problems.push(`no PR on ${repo}`);
  const dir = runDir(i.home, id);
  const missing = ARTIFACTS.filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) problems.push(`missing ${missing.join(", ")}`);
  const sessions = sessionsOf(events);
  const labels = new Set(sessions.map((e) => String(e.payload["label"])));
  const absent = SESSIONS.filter((s) => !labels.has(s));
  if (absent.length > 0) problems.push(`no ${absent.join(", ")} session`);
  if (sessions.some((e) => e.payload["runner"] !== "sdk")) problems.push("replayed sessions");
  let usd = 0;
  if (!missing.includes("manifest.json")) {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      artifacts: { path: string; digest: string }[];
      candidate_commit: string;
      versions: { factory_commit?: string };
      costs: { usd: number }[];
    };
    const check = i.validator.validate("manifest.schema.json", manifest);
    if (!check.valid) problems.push(`manifest invalid: ${check.errors.slice(0, 3).join("; ")}`);
    else {
      const tampered = manifest.artifacts.filter((a) => !existsSync(join(dir, a.path)) || sha256(readFileSync(join(dir, a.path))) !== a.digest);
      if (tampered.length > 0) problems.push(`artifacts differ from the manifest: ${tampered.map((a) => a.path).join(", ")}`);
      if (manifest.versions.factory_commit === undefined || manifest.versions.factory_commit !== i.release.info?.sha) problems.push("not run on the installed release");
      usd = manifest.costs.reduce((sum, c) => sum + c.usd, 0);
    }
    if (!missing.includes("publish.json")) {
      const publish = JSON.parse(readFileSync(join(dir, "publish.json"), "utf8")) as { head_commit: string };
      if (publish.head_commit !== manifest.candidate_commit) problems.push("the pushed commit is not the reviewed candidate");
    }
  }
  if (!missing.includes("gates.json") && !(JSON.parse(readFileSync(join(dir, "gates.json"), "utf8")) as { passed: boolean }).passed) problems.push("gates did not pass");
  if (!missing.includes("verdict.json") && (JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")) as { decision: string }).decision !== "approve") problems.push("verdict is not approve");
  return { problems, pr, sessions: sessions.length, usd };
}

/** Tasks created inside the evidence window. */
function windowTasks(i: G0Inputs, begin: Begin | null): string[] {
  return i.store.taskIds().filter((id) => begin === null || readTask(i.home, id).created_at >= begin.started_at);
}

function g01(i: G0Inputs, tasks: string[]): Criterion {
  const evidence: string[] = [];
  const failures: string[] = [];
  for (const name of fixtureNames()) {
    const repo = mirrorRepo(loadFixture(name, i.validator));
    const candidates = tasks.filter((id) => readTask(i.home, id).target.repo === repo);
    const results = candidates.map((id) => ({ id, ...dryRunProblems(i, id, repo) }));
    const ok = results.findLast((r) => r.problems.length === 0);
    if (ok !== undefined) {
      evidence.push(`${name}: ${ok.id} → ${ok.pr}; ${String(ok.sessions)} live sessions; manifest valid; $${ok.usd.toFixed(2)}`);
    } else {
      const last = results.at(-1);
      failures.push(last === undefined ? `${name}: no dry run in the evidence window` : `${name}: ${last.id}: ${last.problems.join("; ")}`);
    }
  }
  return {
    id: "G0-1",
    criterion: "Fixture dry runs produce the full artifact chain and a PR",
    status: failures.length === 0 && evidence.length > 0 ? "pass" : "fail",
    detail: failures.length === 0 ? `${String(evidence.length)} fixture dry runs reached the merge gate with a PR and a valid manifest` : failures.join(" | "),
    evidence,
  };
}

function g02(i: G0Inputs): Criterion {
  const run = i.deps.bypass();
  const ok = run.variants >= 20 && run.failures.length === 0;
  return {
    id: "G0-2",
    criterion: "At least 20 bypass variants all exit 2",
    status: ok ? "pass" : "fail",
    detail: `${String(run.denied)} of ${String(run.variants)} variants exit 2 through the released guard hook${run.failures.length > 0 ? `; not denied: ${run.failures.join(", ")}` : ""}`,
    evidence: [`plugin/hooks/bypass-cases.ts from the release, run as hooks.json runs the guard`],
  };
}

function g03(i: G0Inputs, begin: Begin | null, tasks: string[]): Criterion {
  const failures: string[] = [];
  const evidence: string[] = [];
  if (begin === null) failures.push("no snapshot: run `factoryctl gate G0 --begin` before the dry runs");
  else {
    const changed = begin.checkouts.filter((c) => !existsSync(c.path) || checkoutDigest(c.path).digest !== c.digest);
    if (changed.length > 0) failures.push(`${String(changed.length)} of ${String(begin.checkouts.length)} operator checkouts changed`);
    else evidence.push(`${String(begin.checkouts.length)} operator checkout(s), ${String(begin.checkouts.reduce((n, c) => n + c.files, 0))} files, byte-identical since ${begin.started_at}`);
  }
  if (i.release.info === null) failures.push("factoryctl is not running from an installed release");
  else {
    const v = verifyRelease(i.release.root, i.validator);
    if (v.ok) evidence.push(`release ${v.info.tag} unchanged since install (${v.detail})`);
    else failures.push(`the installed release was modified: ${v.detail}`);
  }
  const allowlist = JSON.stringify([...ENV_ALLOWLIST].sort());
  const sessions = tasks.flatMap((id) => sessionsOf(i.store.events(id)));
  const leaky = sessions.filter((e) => JSON.stringify(e.payload["env_keys"]) !== allowlist);
  if (sessions.length === 0) failures.push("no sessions recorded in the evidence window");
  else if (leaky.length > 0) failures.push(`${String(leaky.length)} of ${String(sessions.length)} sessions had an env other than the allowlist`);
  else evidence.push(`${String(sessions.length)} sessions, each env exactly the ${String(ENV_ALLOWLIST.length)}-name allowlist`);
  return {
    id: "G0-3",
    criterion: "Operator checkout unchanged; session env equals the allowlist",
    status: failures.length === 0 ? "pass" : "fail",
    detail: failures.length === 0 ? "checkouts and release unchanged; every session env equals the allowlist" : failures.join(" | "),
    evidence,
  };
}

async function g04(i: G0Inputs): Promise<Criterion> {
  const failures: string[] = [];
  const evidence: string[] = [];
  for (const name of ["node", "agent sdk pin", "claude code pin"]) {
    const c = i.deps.doctor.find((d) => d.name === name);
    if (c?.status === "ok") evidence.push(`doctor: ${name}: ${c.detail}`);
    else failures.push(`doctor: ${name}: ${c?.detail ?? "not checked"}`);
  }
  const info = i.release.info;
  const repo = i.deps.repository ?? info?.repository ?? null;
  if (info === null) failures.push("no installed release to check CI on");
  else if (repo === null) failures.push("the release records no GitHub repository; pass --repo OWNER/NAME");
  else {
    try {
      const runs = await i.deps.checks.checkRuns(repo, info.sha);
      const ci = runs.find((r) => r.name === "ci");
      if (ci?.status === "completed" && ci.conclusion === "success") evidence.push(`factory CI: \`ci\` passed on ${info.tag} (${info.sha.slice(0, 12)})`);
      else failures.push(`factory CI: \`ci\` on ${info.sha.slice(0, 12)} is ${ci === undefined ? "missing" : `${ci.status}/${ci.conclusion ?? "pending"}`}`);
    } catch (e) {
      failures.push(`factory CI: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    id: "G0-4",
    criterion: "Factory CI green; doctor confirms pins",
    status: failures.length === 0 ? "pass" : "fail",
    detail: failures.length === 0 ? "factory CI green on the release commit; Node, Claude Code and Agent SDK pins confirmed" : failures.join(" | "),
    evidence,
  };
}

function g05(i: G0Inputs): Criterion {
  const risk = parse(readFileSync(join(i.release.root, "policies/risk.yaml"), "utf8")) as { rules: { when: { any_path?: string[] }; minimum_risk: string }[] };
  const budgets = parse(readFileSync(join(i.release.root, "policies/budgets.yaml"), "utf8")) as { task_usd: Record<string, number>; default_monthly_cap_usd: number; wall_clock_minutes: number };
  const globs = risk.rules.flatMap((r) => (r.when.any_path ?? []).map((g) => `${g} → ${r.minimum_risk}`));
  return {
    id: "G0-5",
    criterion: "Operator signs; globs and budgets confirmed",
    status: "human",
    detail: "the operator signs by approving the gates/G0 evidence PR, which confirms the default protected globs and the initial tier budgets",
    evidence: [
      `protected globs (policies/risk.yaml): ${globs.join(", ")}`,
      `task budgets USD (policies/budgets.yaml): ${Object.entries(budgets.task_usd).map(([t, usd]) => `${t} ${String(usd)}`).join(", ")}; monthly cap ${String(budgets.default_monthly_cap_usd)}; wall clock ${String(budgets.wall_clock_minutes)} min`,
    ],
  };
}

export async function evaluateG0(i: G0Inputs): Promise<Evidence> {
  const begin = readBegin(i.home);
  const tasks = windowTasks(i, begin);
  const criteria = [g01(i, tasks), g02(i), g03(i, begin, tasks), await g04(i), g05(i)];
  const info = i.release.info;
  const evidence: Evidence = {
    schema_version: 1,
    gate: "G0",
    generated_at: (i.now ?? new Date()).toISOString(),
    release: info === null ? null : { sha: info.sha, tag: info.tag, files_digest: info.files_digest },
    passed: criteria.every((c) => c.status !== "fail"),
    criteria,
  };
  const check = i.validator.validate("gate-evidence.schema.json", evidence);
  if (!check.valid) throw new Error(`gate evidence: ${check.errors.join("; ")}`);
  return evidence;
}

const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The evidence PR body: what STATUS's Gate G0 table gets, and what the operator confirms. */
export function evidenceMarkdown(e: Evidence): string {
  const date = e.generated_at.slice(0, 10);
  const lines = [
    "## Gate G0 evidence",
    "",
    `Drafted by \`factoryctl gate G0\` on ${date}${e.release === null ? " from a development checkout" : ` with release \`${e.release.tag}\` (\`${e.release.sha}\`, files ${e.release.files_digest})`}.`,
    `Automated criteria (G0-1 to G0-4): **${e.passed ? "all pass" : "not all pass"}**. G0-5 is the operator's signature: approving this PR.`,
    "",
    "| ID | Criterion | Status | Evidence | Date | Signed by |",
    "|---|---|---|---|---|---|",
    ...e.criteria.map((c) => `| ${c.id} | ${cell(c.criterion)} | ${c.status === "human" ? "review" : c.status === "pass" ? "done" : "blocked"} | ${cell(c.detail)} | ${date} | |`),
    "",
    "### Details",
    "",
    ...e.criteria.flatMap((c) => [`- **${c.id}** (${c.status}): ${c.detail}`, ...c.evidence.map((x) => `  - ${x}`)]),
    "",
  ];
  return lines.join("\n");
}

export function writeEvidence(home: Home, e: Evidence): { json: string; markdown: string } {
  mkdirSync(gateDir(home), { recursive: true, mode: 0o700 });
  const json = join(gateDir(home), "evidence.json");
  const markdown = join(gateDir(home), "evidence.md");
  writeFileSync(json, `${JSON.stringify(e, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdown, evidenceMarkdown(e), { mode: 0o600 });
  return { json, markdown };
}
