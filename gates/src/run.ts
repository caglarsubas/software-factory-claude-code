// The gate runner (ROADMAP P0-06): deterministic gates for one candidate commit, each in a
// disposable container. It loads the committed tree into a fresh volume; scans it while it is
// pristine (SAST, secrets, dependency audit), with no network; runs the profile's setup, the
// one step with a network, with lifecycle scripts and source builds off; then runs each command
// gate with no network and the shared caches read-only. The host reads every exit code, so code
// under test cannot forge a result.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { createVolume, PROXY_ENV, removeVolume, runContainer, type ContainerSpec, type ExecResult } from "./container.ts";
import { parseAddedLines } from "./diff.ts";
import { judgeDependencies, judgeSast, judgeSecrets, type Outcome, type Sink } from "./findings.ts";
import { ADAPTERS, isLockfile, phaseEnv, planGates, RULE_PACKS, type GateProfile } from "./plan.ts";
import { commitTime, listTree, writeTar, type TreeEntry } from "./tree.ts";

export interface GateEntry {
  name: string;
  status: "pass" | "fail" | "skipped" | "error";
  duration_ms: number;
  summary: string;
}

/** gates.json (schemas/gates.schema.json). */
export interface GatesResult {
  schema_version: 1;
  task_id: string;
  candidate_commit: string;
  passed: boolean;
  gates: GateEntry[];
  signals: { sink_added: Sink[]; secret_material: boolean };
}

export interface Timeouts {
  load: number;
  refresh: number;
  scan: number;
  setup: number;
  command: number;
}

export interface RunOptions {
  /** Worktree whose HEAD is the candidate; it must have no uncommitted changes. */
  worktree: string;
  /** The commit the change is measured against (the reviewed base). */
  base: string;
  taskId: string;
  profile: GateProfile;
  image: string;
  /** Per-target package-manager caches, reused across runs and read-only to command gates. */
  cacheVolume: string;
  /** Offline vulnerability databases, shared by every target. */
  osvVolume: string;
  /** Network for setup and the database refresh (default "bridge"). */
  fetchNetwork?: string;
  /** Extra CA bundle for those two steps, for hosts behind a TLS-inspecting proxy. */
  caFile?: string;
  timeoutsMs?: Partial<Timeouts>;
  log?: (line: string) => void;
}

export class GateRunError extends Error {}

/** One refresh per database volume at a time: concurrent runs await the same one. */
const refreshes = new Map<string, Promise<void>>();

/** One cache volume per target repository: package caches never cross targets. */
export function cacheVolumeFor(repo: string): string {
  return `sf-gates-cache-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

const DEFAULT_TIMEOUTS: Timeouts = { load: 300_000, refresh: 900_000, scan: 900_000, setup: 1_200_000, command: 1_800_000 };
const CANDIDATE = "/data/candidate";
const BASE = "/data/base";
const OSV_MAX_AGE_SECONDS = 12 * 60 * 60;
const TAIL_LINES = 20;

// eslint-disable-next-line no-control-regex -- terminal colour codes in tool output
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function tail(r: ExecResult): string {
  const lines = `${r.stdout}\n${r.stderr}`.replace(ANSI, "").split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  return lines.slice(-TAIL_LINES).join("\n").slice(-2000);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function commandEntry(name: string, r: ExecResult, limitMs: number): GateEntry {
  if (r.timedOut) return { name, status: "error", duration_ms: r.durationMs, summary: `timed out after ${seconds(limitMs)}` };
  if (r.status === 0) return { name, status: "pass", duration_ms: r.durationMs, summary: `exit 0 in ${seconds(r.durationMs)}` };
  const output = tail(r);
  return { name, status: "fail", duration_ms: r.durationMs, summary: `exit ${String(r.status)}${output === "" ? "" : `:\n${output}`}` };
}

function scanEntry(name: string, r: ExecResult, limitMs: number, outcome: Outcome): GateEntry {
  if (r.timedOut) return { name, status: "error", duration_ms: r.durationMs, summary: `timed out after ${seconds(limitMs)}` };
  return { name, status: outcome.status, duration_ms: r.durationMs, summary: outcome.summary };
}

export async function runGates(o: RunOptions): Promise<GatesResult> {
  const plan = planGates(o.profile);
  const t: Timeouts = { ...DEFAULT_TIMEOUTS, ...o.timeoutsMs };
  const log = o.log ?? (() => undefined);
  const fetchNetwork = o.fetchNetwork ?? "bridge";
  const fetchExtras: Partial<ContainerSpec> = { passEnv: PROXY_ENV, ...(o.caFile === undefined ? {} : { caFile: o.caFile }) };

  const git = (args: string[]): string => {
    const r = spawnSync("git", ["-C", o.worktree, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    if (r.status !== 0) throw new GateRunError(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };

  // The candidate is a commit: what the gates judge is exactly what gets reviewed and pushed.
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "") {
    throw new GateRunError("the worktree has uncommitted changes; commit them before running the gates");
  }
  const candidate = git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).trim();
  const base = git(["rev-parse", "--verify", "--end-of-options", `${o.base}^{commit}`]).trim();
  const added = parseAddedLines(
    git(["-c", "core.quotePath=false", "diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", base, candidate]),
  );
  const candidateTree = listTree(o.worktree, candidate);
  const baseLockfiles = listTree(o.worktree, base).filter((e) => isLockfile(plan, e.path));

  const run = `sf-gates-${o.taskId.toLowerCase()}-${randomBytes(4).toString("hex")}`;
  const data = `${run}-data`;
  const container = (step: string, spec: Omit<ContainerSpec, "name" | "image">, timeoutMs: number, stdin?: PassThrough): Promise<ExecResult> =>
    runContainer({ ...spec, name: `${run}-${step}`, image: o.image }, timeoutMs, stdin);
  const dataMount = (readOnly: boolean) => ({ volume: data, target: "/data", readOnly });
  const cacheMount = (readOnly: boolean) => ({ volume: o.cacheVolume, target: "/cache", readOnly });
  const osvMount = (readOnly: boolean) => ({ volume: o.osvVolume, target: "/osv", readOnly });

  const load = async (commit: string, entries: TreeEntry[], target: string): Promise<void> => {
    const tar = new PassThrough();
    const writing = writeTar(o.worktree, entries, commitTime(o.worktree, commit), tar).catch((e: unknown) => {
      tar.end();
      throw e;
    });
    const [extracted, written] = await Promise.allSettled([
      container(`load-${target.slice(6)}`, { network: "none", volumes: [dataMount(false)], stdin: true, argv: ["tar", "-x", "-C", target] }, t.load, tar),
      writing,
    ]);
    if (written.status === "rejected") throw new GateRunError(`reading ${commit} failed: ${String(written.reason)}`);
    if (extracted.status === "rejected") throw new GateRunError(`loading ${commit} failed: ${String(extracted.reason)}`);
    if (extracted.value.status !== 0) throw new GateRunError(`loading ${commit} failed: ${extracted.value.stderr.trim()}`);
  };

  const refreshOsvOnce = async (): Promise<void> => {
    // Every ecosystem the seed covers: a run waiting on another run's refresh may need any of them.
    const files = [...new Set(Object.values(ADAPTERS).map((a) => `/osv/osv-scalibr/${a.osvEcosystem}/all.zip`))];
    const fresh = await container(
      "osv-age",
      {
        network: "none",
        volumes: [osvMount(true)],
        argv: ["sh", "-c", `now=$(date +%s); for f in ${files.join(" ")}; do [ -f "$f" ] && [ $((now - $(stat -c %Y "$f"))) -lt ${String(OSV_MAX_AGE_SECONDS)} ] || exit 1; done`],
      },
      60_000,
    );
    if (fresh.status === 0) return;
    // The refresh container sees the image's seed lockfiles and the database volume, nothing else.
    const r = await container(
      "osv-refresh",
      {
        network: fetchNetwork,
        volumes: [osvMount(false)],
        ...fetchExtras,
        argv: ["osv-scanner", "scan", "source", "-r", "--offline-vulnerabilities", "--download-offline-databases", "--no-resolve", "--format", "json", "/opt/gates/osv-seed"],
      },
      t.refresh,
    );
    if (r.status !== 0 && r.status !== 1) log(`OSV database refresh failed (exit ${String(r.status)}); auditing against the cached copy`);
  };
  const refreshOsv = (): Promise<void> => {
    let pending = refreshes.get(o.osvVolume);
    if (pending === undefined) {
      pending = refreshOsvOnce().finally(() => refreshes.delete(o.osvVolume));
      refreshes.set(o.osvVolume, pending);
    }
    return pending;
  };

  createVolume(data);
  try {
    log(`loading ${candidate.slice(0, 12)} (${String(candidateTree.length)} files)`);
    await load(candidate, candidateTree, CANDIDATE);
    if (baseLockfiles.length > 0) await load(base, baseLockfiles, BASE);
    await refreshOsv();

    log("scanning: sast, secret-scan, dependency-audit");
    const scanVolumes = [dataMount(true), osvMount(true)];
    const packs = plan.rulePacks.flatMap((p) => ["--config", `/opt/gates/rules/${RULE_PACKS[p]}`]);
    const [sast, secrets, deps] = await Promise.all([
      container(
        "sast",
        {
          network: "none",
          volumes: scanVolumes,
          // Suppression comments, ignore files and size limits are the change's to set, so none apply.
          argv: ["opengrep", "scan", ...packs, "--json", "--quiet", "--disable-version-check", "--no-git-ignore", "--disable-nosem", "--x-ignore-semgrepignore-files", "--max-target-bytes=0", CANDIDATE],
        },
        t.scan,
      ),
      container(
        "secret-scan",
        { network: "none", volumes: scanVolumes, argv: ["trufflehog", "filesystem", CANDIDATE, "--json", "--no-verification", "--no-update", "--no-ignore-tag"] },
        t.scan,
      ),
      container(
        "dependency-audit",
        { network: "none", volumes: scanVolumes, argv: ["osv-scanner", "scan", "source", "-r", "--no-ignore", "--offline", "--format", "json", CANDIDATE, BASE] },
        t.scan,
      ),
    ]);
    const sastJudgement = judgeSast(sast.stdout, sast.status, added, CANDIDATE);
    const secretsJudgement = judgeSecrets(secrets.stdout, secrets.status, added, CANDIDATE);
    const gates: GateEntry[] = [
      scanEntry("sast", sast, t.scan, sastJudgement.outcome),
      scanEntry("secret-scan", secrets, t.scan, secretsJudgement.outcome),
      scanEntry("dependency-audit", deps, t.scan, judgeDependencies(deps.stdout, deps.status, CANDIDATE, BASE)),
    ];

    let setupFailed = false;
    if (plan.setup !== null) {
      log("setup");
      const r = await container(
        "setup",
        { network: fetchNetwork, volumes: [dataMount(false), cacheMount(false)], env: phaseEnv(plan, "setupEnv"), ...fetchExtras, workdir: CANDIDATE, argv: ["sh", "-c", plan.setup] },
        t.setup,
      );
      const entry = commandEntry("setup", r, t.setup);
      gates.push(entry);
      setupFailed = entry.status !== "pass";
    }
    for (const c of plan.commands) {
      if (setupFailed) {
        gates.push({ name: c.name, status: "skipped", duration_ms: 0, summary: "not run: setup failed" });
        continue;
      }
      log(c.name);
      const r = await container(
        c.name,
        { network: "none", volumes: [dataMount(false), cacheMount(true)], env: { ...phaseEnv(plan, "offlineEnv"), CI: "true" }, workdir: CANDIDATE, argv: ["sh", "-c", c.command] },
        t.command,
      );
      gates.push(commandEntry(c.name, r, t.command));
    }

    return {
      schema_version: 1,
      task_id: o.taskId,
      candidate_commit: candidate,
      passed: gates.every((g) => g.status === "pass"),
      gates,
      signals: { sink_added: sastJudgement.sinks, secret_material: secretsJudgement.secretMaterial },
    };
  } finally {
    removeVolume(data);
  }
}
