#!/usr/bin/env node
// factoryctl v0 (ROADMAP P0-07, P0-09): task create, run, resume, status, cancel, approve,
// doctor, the kill switch, releases and gate evidence.
//
//   factoryctl task create --profile FILE | --repo OWNER/NAME --title TEXT --body-file FILE [--untrusted] [--remote URL]
//   factoryctl intake [PROFILE.yaml...]       admit the targets' labelled issues as tasks (P2-04); none: every onboarded target's
//   factoryctl onboard OWNER/NAME [--remote URL] [--confirm | --update] [--factory-ref TAG [--source DIR]]  take a target on (P2-11)
//   factoryctl offboard OWNER/NAME [--local-only | --app-unavailable] [--reason TEXT]  let a target go and purge its data (P2-11)
//   factoryctl run T-0001 [--attach] [--replay DIR] [--runner host|container]  drive a task until it needs a human or ends
//   factoryctl resume T-0001 [--attach] [--replay DIR] [--runner host|container]  the same, after a stop, a pause, a halt or a crash
//   factoryctl serve [--replay DIR] [--max-tasks N] [--port N]  schedule tasks unattended, every live session in the runner
//   factoryctl pause T-0001 [--reason TEXT]  stop the task at its next step boundary, until resume
//   factoryctl takeover T-0001               open its build session yourself; the result goes back through the gates
//   factoryctl status [T-0001]
//   factoryctl cancel T-0001
//   factoryctl approve T-0001 --gate spec --reason TEXT
//   factoryctl reject T-0001 --reason TEXT   end a task the operator will not merge (human_rejected)
//   factoryctl report [T-0001 | --week YYYY-Www]  per-stage metrics, or the weekly taxonomy row
//   factoryctl budgets                       tier budgets as calibrated, and each target's month spend
//   factoryctl eval capture T-0001           a run's judgment stages as candidate eval cases
//   factoryctl halt [--reason TEXT]          kill switch v0: stop every session and run now
//   factoryctl unhalt --reason TEXT
//   factoryctl release install TAG [--source DIR] | use TAG|SHA | status
//   factoryctl gate G0|G1|G2 --begin [--checkout DIR]... | gate G0|G1|G2 [--repo OWNER/NAME]
//   factoryctl drill kill-switch | restore | serve-kill
//   factoryctl prune [--dry-run]             expire finished tasks' evidence past retention; finish a stopped purge (ADR 0003)
//   factoryctl dashboard [--port N]          the board, the evidence drawer and a live stream, read-only, on loopback
//   factoryctl doctor
//
// FACTORY_HOME holds run state (default ~/.factory); FACTORY_RELEASE overrides the release the
// running code belongs to; FACTORY_GITHUB_TOKEN pushes and opens PRs, against
// FACTORY_GITHUB_API_URL (default https://api.github.com). --replay replays recorded transcripts
// instead of calling a model: zero tokens; its replay.json holds test-only injection
// (session/injection.ts).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { engineHost, PROXY_ENV, removeTaskContainers } from "../../../gates/src/container.ts";
import { activity, haltNow, idle, killSwitchDrill, restoreDrill, serveKillDrill, type Activity } from "../durable/drill.ts";
import { pendingJournals, PurgeError, runJournal } from "../durable/purge.ts";
import { expiredScopes } from "../durable/refs.ts";
import { planRetention, profilePolicy, prune } from "../durable/retention.ts";
import { initReplica, keepReplica, replicaStatus, restore, syncReplica } from "../durable/replica.ts";
import { startRunGateway, type Gateway } from "../gateway/gateway.ts";
import { reapRunnerContainers } from "../runner/container.ts";
import { ensureRunnerImage } from "../runner/image.ts";
import { runnerGatewayAddress, startTaskRunner, type TaskRunner } from "../runner/live.ts";
import { keepLease, leaseState, takeLease } from "../sched/lease.ts";
import { callServe } from "../serve/client.ts";
import { DEFAULT_PORT, liveServe, startServe, tokenPath } from "../serve/serve.ts";
import { reapTaskNetworks } from "../runner/network.ts";
import { runGates } from "../../../gates/src/run.ts";
import { ensureImage } from "../../../gates/src/image.ts";
import { runBypassVariants } from "../../../plugin/hooks/bypass-cases.ts";
import { appCheck, doctor, rulesetCheck, targetChecks } from "../doctor.ts";
import { fixtureNames, loadFixture } from "../fixtures/targets.ts";
import { footprintRulesets } from "../governance/footprint.ts";
import { beginGate, evaluateG0, writeEvidence } from "../gate/g0.ts";
import { evaluateG1 } from "../gate/g1.ts";
import { evaluateG2 } from "../gate/g2.ts";
import { DEFAULT_DASHBOARD_PORT, startDashboard } from "../dashboard/server.ts";
import { CANARY_ENV, plantCanary, readCanary } from "../gate/canary.ts";
import { appConfig, AppConfigError, appConfigPath, appInfo, appTokens, type AppTokens } from "../github/app.ts";
import { githubApiUrl, GitHubError, isLoopbackApi, restCommitChecks, restGateReads, restGitHub, type GitHub } from "../github/client.ts";
import type { GitAuth } from "../git/repo.ts";
import { clearHalt, describeHalt, readHalt } from "../halt.ts";
import { acquireRunLock, ensureHome, factoryHome, liveHolder, runDir, worktreeDir, type Home } from "../home.ts";
import { reap } from "../proc.ts";
import { loadRelease } from "../release.ts";
import { checkReleaseFiles, findRelease, installRelease, listReleases, pinnedSha, pinRelease, writeShim } from "../release/install.ts";
import { createValidator } from "../schemas/validate.ts";
import { holdAt, isLocalRemote, killAt, probes, readInjection, replayedGates } from "../session/injection.ts";
import { describeAlarm, telemetryConfig, TelemetryError, type ModelAlarm, type Telemetry } from "../telemetry.ts";
import { otelDir, readOtel, startCollector, type Collector } from "../otel/collector.ts";
import { measureSlos, otelPanel, windowTasks } from "../report/slo.ts";
import { replayRunner } from "../session/replay.ts";
import { sdkRunner } from "../session/runner.ts";
import { calibrate, completedRuns, monthOf, monthSpend, TIERS } from "../budget/budget.ts";
import { captureTask } from "../evals/capture.ts";
import { writeAtomic } from "../fsutil.ts";
import { isoWeek, taskReport, WEEK_HEADER, weekRange, weekRow, weekRowMarkdown, type TaskReport } from "../report/report.ts";
import { describeBlast, readBlasts, shadowCounts } from "../graph/blast.ts";
import { specDigest } from "../stages/commit.ts";
import { runTask } from "../stages/pipeline.ts";
import { REVIEWERS } from "../stages/reviewers.ts";
import { EventStore, LeaseHeldError, type FactoryEvent } from "../store/events.ts";
import { currentState, currentStatePayload, isPaused, isTerminal, transition } from "../task/lifecycle.ts";
import { createTask, loadProfile, readTask, taskRecord } from "../task/task.ts";
import { targetReads } from "../target/github.ts";
import { LayerError } from "../target/layer.ts";
import { offboard, OffboardError } from "../target/offboard.ts";
import { onboard, OnboardError } from "../target/onboard.ts";
import { activeProfile, listTargets, readTarget, RegistryError } from "../target/registry.ts";
import { FootprintError } from "../governance/footprint.ts";
import { pollIntake } from "../intake/intake.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describeMessage } from "../session/attach.ts";
import { takeoverLaunch, versionMatches } from "../session/takeover-session.ts";
import { applyTakeover, checkTakeover, resumableSession, TakeoverError } from "../stages/takeover.ts";

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
// A closed pipe (`factoryctl status | head`) is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

function fail(message: string, code = 2): never {
  process.stderr.write(`factoryctl: ${message}\n`);
  process.exit(code);
}

const TASK_ID = /^T-[0-9]{4,}$/;

function taskArg(positionals: string[], index: number, store: EventStore): string {
  const id = positionals[index];
  if (id === undefined || !TASK_ID.test(id)) fail("expected a task id like T-0001");
  if (!store.taskIds().includes(id)) fail(`no task ${id}`);
  return id;
}

const operator = (): string => process.env["USER"] ?? "operator";

/** Commands only a human at the terminal may run: never an agent session (ROADMAP §2.6). */
function operatorOnly(what: string): void {
  if (process.env["CLAUDECODE"] !== undefined) fail(`${what} refuses to run inside a Claude Code session`);
}

const describeActivity = (a: Activity): string => `${String(a.writers)} writer(s), ${String(a.sessions)} session(s), ${String(a.runners)} runner and ${String(a.gates)} gate container(s)`;

/** Every halt and unhalt, one JSON line each: the kill switch's own audit trail. */
function haltLog(home: Home, entry: Record<string, unknown>): void {
  appendFileSync(join(home.root, "halt.log"), `${JSON.stringify({ at: new Date().toISOString(), by: operator(), ...entry })}\n`, { mode: 0o600 });
}

function keyFile(home: Home): string {
  return process.env["FACTORY_API_KEY_FILE"] ?? join(home.secrets, "anthropic.key");
}

/** G2-5: a planted canary rides in this process's own environment, where a leaked secret would come from. */
function carryCanary(home: Home): void {
  const canary = readCanary(home);
  if (canary !== null) process.env[CANARY_ENV] = canary;
}

/** What gate G2 reads from GitHub: with FACTORY_GITHUB_TOKEN, else the App's installation token, else unauthenticated (public fixtures). */
async function g2Deps(home: Home): Promise<{ github: ReturnType<typeof restGateReads>; appSlug: string | null; secretFiles: string[] }> {
  const api = apiUrl();
  const app = appConfig(home);
  const token = process.env["FACTORY_GITHUB_TOKEN"];
  const tokens = token === undefined && app !== null ? appTokens({ app, api }) : null;
  const github = restGateReads(token ?? (tokens === null ? null : () => tokens.token()), api);
  let appSlug: string | null = null;
  try {
    appSlug = app === null ? null : (await appInfo({ app, api })).slug;
  } catch (e) {
    process.stderr.write(`factoryctl: the App's slug is unknown (${e instanceof Error ? e.message : String(e)}); G2-2 cannot attribute pushes\n`);
  }
  return { github, appSlug, secretFiles: [keyFile(home), app?.keyFile ?? join(home.secrets, "github-app.pem"), tokenPath(home)] };
}

/** The review artifacts' findings, for the per-task report; a run without reviews has none. */
function reviewsOf(home: Home, taskId: string): { findings: { severity: string }[] }[] {
  return REVIEWERS.map((r) => `${r.label}.json`).flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(join(runDir(home, taskId), name), "utf8")) as { findings: { severity: string }[] }];
    } catch {
      return [];
    }
  });
}

function printTaskReport(r: TaskReport): void {
  const n = (v: number | null): string => (v === null ? "—" : v.toLocaleString("en-US"));
  const min = (ms: number | null): string => (ms === null ? "—" : (ms / 60_000).toFixed(1));
  const outcome = r.category === null ? "" : `  ${r.category}${r.cause === null ? "" : ` (${r.cause})`}`;
  out(`${r.taskId}  ${r.state}${r.gate === null ? "" : ` (gate: ${r.gate})`}${r.tier === null ? "" : `  tier ${r.tier}`}${outcome}  ${r.live ? "live" : r.sessions === 0 ? "no sessions" : "replayed"}  rounds ${String(r.rounds)}`);
  const row = (cells: string[]): void => {
    out(cells.map((c, i) => (i < 2 ? c.padEnd(i === 0 ? 16 : 7) : c.padStart(i === 2 ? 5 : 10))).join(" "));
  };
  row(["stage", "runner", "round", "turns", "in tokens", "out tokens", "minutes", "cost $"]);
  for (const s of r.stages) row([`${s.label}${s.unreported ? " ✗ killed" : s.ok ? "" : " ✗"}`, s.runner, String(s.round), n(s.numTurns), n(s.inputTokens), n(s.outputTokens), min(s.durationMs), s.costUsd.toFixed(2)]);
  row(["total", "", "", "", n(r.totals.inputTokens), n(r.totals.outputTokens), min(r.totals.durationMs), r.totals.costUsd.toFixed(2)]);
  if (r.findings !== null) out(`findings: ${Object.entries(r.findings).map(([k, v]) => `${k} ${String(v)}`).join(", ")}`);
  if (r.stages.some((s) => s.unreported)) out("✗ killed: the session never reported; it is charged its cap");
  for (const a of r.alarms) out(`ALARM ${a.label}: ${describeAlarm(a.payload as unknown as ModelAlarm)}`);
}

function apiUrl(): string {
  try {
    return githubApiUrl(process.env["FACTORY_GITHUB_API_URL"]);
  } catch (e) {
    return fail(e instanceof GitHubError ? e.message : String(e));
  }
}

interface DriveOptions {
  replay: string | undefined;
  /** A `serve` worker (P2-03): no attended run lock; serve schedules it. */
  worker?: boolean;
  /** `resume` lifts a pause; `run` refuses a paused task. */
  resume: boolean;
  attach: boolean;
  /** Live sessions in the runner container (P2-01) rather than on the host; serve's workers always. */
  container?: boolean;
}

async function drive(home: Home, store: EventStore, taskId: string, o: DriveOptions): Promise<void> {
  const { replay } = o;
  carryCanary(home);
  const halt = readHalt(home);
  if (halt !== null) fail(`the factory is ${describeHalt(halt)}; lift it with: factoryctl unhalt --reason "…"`);
  if (isPaused(store.events(taskId))) {
    if (!o.resume) fail(`${taskId} is paused; continue it with: factoryctl resume ${taskId}`);
    store.append({ task_id: taskId, actor: { kind: "operator", id: operator() }, type: "command", payload: { command: "unpause" } });
  }
  const validator = createValidator();
  const release = loadRelease(validator);
  const token = process.env["FACTORY_GITHUB_TOKEN"];
  const api = apiUrl();
  let telemetry: Telemetry | null = null;
  try {
    telemetry = telemetryConfig();
  } catch (e) {
    fail(e instanceof TelemetryError ? e.message : String(e));
  }
  // The factory App (P2-05), when set, acts for the run with a token narrowed to its target; the personal token is the fallback.
  let app;
  try {
    app = appConfig(home);
  } catch (e) {
    fail(e instanceof AppConfigError ? e.message : String(e));
  }
  const injection = replay === undefined ? {} : readInjection(replay);
  if (injection.gates !== undefined) {
    const created = store.events(taskId).find((e) => e.type === "task_created");
    const remote = created?.payload["remote"];
    if (typeof remote !== "string" || !isLocalRemote(remote) || ((token !== undefined || app !== null) && !isLoopbackApi(api))) fail("replayed gates need a task with a local remote and, with a GitHub token or App, a loopback FACTORY_GITHUB_API_URL");
  }
  let appToken: AppTokens | null = null;
  if (app !== null) {
    const repo = readTask(home, taskId).target.repo;
    appToken = appTokens({ app, api, repositories: [repo.split("/")[1] ?? repo] });
    try {
      await appToken.refresh();
    } catch (e) {
      fail(`the factory App (${String(app.appId)}) could not get a token for ${repo}: ${e instanceof Error ? e.message : String(e)}; is the App installed on it?`);
    }
  }
  const tokens = appToken;
  const github: GitHub | null = tokens !== null ? restGitHub(() => tokens.token(), api) : token === undefined ? null : restGitHub(token, api);
  // git reads the token synchronously: the timer below keeps the held one well inside its hour.
  const auth: GitAuth | null = tokens !== null ? { get token() { return tokens.current(); } } : token === undefined ? null : { token };
  const keepToken = tokens === null ? null : setInterval(() => {
    tokens.token().catch((e: unknown) => {
      process.stderr.write(`factoryctl: could not renew the App's token: ${e instanceof Error ? e.message : String(e)}\n`);
    });
  }, 10 * 60_000);
  keepToken?.unref();
  const log = (line: string): void => {
    process.stderr.write(`factoryctl: ${line}\n`);
  };
  const lock = o.worker ? null : acquireRunLock(home, taskId);
  // Clean up after a run that died: its session process groups, and its gate containers.
  if (lock !== null && lock.stale !== null) log(`the run of ${lock.stale.task_id} (pid ${String(lock.stale.pid)}) ended without releasing its lock; cleaning up after it`);
  for (const c of reap(home)) log(`reaped ${c.task_id} ${c.label} (pid ${String(c.pid)}), left running by a run that died`);
  // Runner containers and egress proxies (P2-01) a dead run left: the docker client dying does not stop them.
  for (const name of reapRunnerContainers()) log(`removed runner container ${name}, left running by a run that died`);
  for (const t of reapTaskNetworks()) log(`removed the egress proxy and network of ${t}, left by a run that died`);
  if (lock !== null && lock.stale !== null && injection.gates === undefined) {
    const removed = removeTaskContainers(lock.stale.task_id);
    if (removed > 0) log(`removed ${String(removed)} gate container(s) of ${lock.stale.task_id}`);
  }
  const abort = new AbortController();
  // The task's lease (P2-03): every write this run makes carries its epoch, and a run whose lease is taken over writes nothing more.
  let lease;
  try {
    lease = await takeLease(home, store, taskId, { log });
  } catch (e) {
    lock?.release();
    if (e instanceof LeaseHeldError) fail(e.message);
    throw e;
  }
  const kept = keepLease(store, lease, (e) => {
    log(`${taskId}: lost its lease (${e.message}); stopping`);
    abort.abort();
  });
  const onSignal = (): void => {
    abort.abort();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const probe = probes(...[killAt(injection.kill_at), replay === undefined ? undefined : holdAt(injection.hold_at, replay, () => readHalt(home) !== null)].filter((p) => p !== undefined));
  // The run's writes reach the replica within a second (P2-07).
  const replica = keepReplica(home, log);
  // Live sessions call the credential gateway (P2-02), never the API with the key.
  let gateway: Gateway | null = null;
  // In the runner (P2-01), on the task's network, whose proxy has one route to the gateway.
  let taskRunner: TaskRunner | null = null;
  // Live sessions export telemetry to the run's own collector (P2-08), unless the operator named another or turned it off.
  let collector: Collector | null = null;
  try {
    if (replay === undefined) {
      if (telemetry === null && process.env["FACTORY_OTEL"] !== "off") {
        collector = await startCollector({ dir: otelDir(home.root), retentionDays: release.config.retention_days.otel, log });
        telemetry = { endpoint: collector.url, protocol: "http/json" };
      }
      const address = o.container === true ? runnerGatewayAddress() : null;
      gateway = await startRunGateway({ home, store, prices: release.config.prices, keyFile: keyFile(home), hosts: [...new Set(["127.0.0.1", ...(address === null ? [] : [address.bind])])], ...(telemetry === null ? {} : { otel: telemetry.endpoint }), log });
      if (address !== null) {
        const url = gateway.urls.find((u) => new URL(u).hostname === address.bind) ?? gateway.urls[0] ?? "";
        taskRunner = startTaskRunner({ home, releaseRoot: release.root, taskId, gateway: { host: address.reach, port: Number(new URL(url).port) } });
        log(`${taskId}: live sessions run in the runner container`);
      }
    }
    const state = await runTask({
      home, store, validator, release, taskId, abort,
      deps: {
        runner: replay === undefined ? sdkRunner : replayRunner(replay, { standIn: true, ...(probe === undefined ? {} : { probe }) }),
        runGates: injection.gates === undefined ? runGates : replayedGates(injection.gates),
        gateImage: injection.gates === undefined ? () => ensureImage() : () => "software-factory-gates:replay",
        engineEnv: () => {
          const host = engineHost();
          // Gate settings and proxy settings for the setup container; a value with credentials in it stays behind.
          const names = ["FACTORY_CONTAINER_ENGINE", "FACTORY_GATES_FETCH_NETWORK", "FACTORY_GATES_CA_FILE", ...PROXY_ENV];
          const passed = names.flatMap((k) => {
            const v = process.env[k];
            return v === undefined || v.includes("@") ? [] : [[k, v] as const];
          });
          return Object.fromEntries([...(host === null ? [] : [["DOCKER_HOST", host] as const]), ...passed]);
        },
        github,
        auth,
        appId: app?.appId ?? null,
        keyFile: keyFile(home),
        gateway,
        container: taskRunner,
        ...(process.env["FACTORY_GATES_FETCH_NETWORK"] === undefined ? {} : { gatesFetchNetwork: process.env["FACTORY_GATES_FETCH_NETWORK"] }),
        ...(process.env["FACTORY_GATES_CA_FILE"] === undefined ? {} : { gatesCaFile: process.env["FACTORY_GATES_CA_FILE"] }),
        log,
        telemetry,
        ...(o.attach ? { observe: (label: string, m: SDKMessage) => {
          for (const l of describeMessage(m)) process.stderr.write(`  ${label} │ ${l}\n`);
        } } : {}),
        ...(probe === undefined ? {} : { probe }),
      },
    });
    const payload = currentStatePayload(store.events(taskId));
    const halted = readHalt(home) === null ? "" : " (halted)";
    out(`${taskId} ${state}${typeof payload["gate"] === "string" ? ` (gate: ${payload["gate"]})` : ""}${typeof payload["pr_url"] === "string" ? ` ${payload["pr_url"]}` : ""}${halted}`);
    if (state === "FAILED") process.exitCode = 1;
  } finally {
    if (keepToken !== null) clearInterval(keepToken);
    taskRunner?.stop();
    await gateway?.close();
    await collector?.close();
    replica.stop();
    kept.stop();
    lock?.release();
  }
}

/**
 * `takeover` (P1-04): the operator's own Claude Code in the task's worktree, under the build
 * session's walls; whatever it leaves goes back through the gates and every judge on `resume`.
 */
async function takeover(home: Home, store: EventStore, taskId: string): Promise<void> {
  operatorOnly("takeover");
  const halt = readHalt(home);
  if (halt !== null) fail(`the factory is ${describeHalt(halt)}; lift it with: factoryctl unhalt --reason "…"`);
  try {
    checkTakeover(home, store, taskId);
  } catch (e) {
    fail(e instanceof TakeoverError ? e.message : String(e));
  }
  const validator = createValidator();
  const release = loadRelease(validator);
  const bin = process.env["FACTORY_CLAUDE_BIN"] ?? "claude";
  const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
  // A binary that is missing has no output at all.
  const reported = typeof version.stdout === "string" ? version.stdout.trim() : "";
  if (version.status !== 0 || !versionMatches(reported, release.config.claude_code.version)) {
    fail(`${bin} is not Claude Code ${release.config.claude_code.version} (it reports ${reported === "" ? "nothing" : reported}); install the pinned version or point FACTORY_CLAUDE_BIN at it`);
  }
  const task = readTask(home, taskId);
  const profile = loadProfile(task.target.profile, validator);
  const spec = parse(readFileSync(join(runDir(home, taskId), "spec.yaml"), "utf8")) as { scope: { include: string[]; exclude: string[] } };
  const lock = acquireRunLock(home, taskId);
  let lease;
  try {
    lease = await takeLease(home, store, taskId);
  } catch (e) {
    lock.release();
    fail(e instanceof Error ? e.message : String(e));
  }
  try {
    const sessionId = resumableSession(store.events(taskId));
    const launch = takeoverLaunch({
      home, taskId, release, validator, keyFile: keyFile(home), worktree: worktreeDir(home, taskId), taskDir: join(runDir(home, taskId), "work", "takeover"),
      protectedPaths: [...profile.protected_paths.map((p) => p.glob), ...profile.restricted.map((r) => r.glob)], scope: spec.scope, sessionId, bin,
      ...(process.env["TERM"] === undefined ? {} : { term: process.env["TERM"] }),
    });
    out(`${taskId}: ${sessionId === null ? "a new session" : `session ${sessionId}`} in ${launch.cwd}, auto mode in the sandbox; exit to hand your commits back to the gates`);
    const r = spawnSync(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "inherit" });
    const result = applyTakeover(home, store, taskId, operator(), { session_id: sessionId, exit_code: r.status });
    out(result.changed
      ? `${taskId}: candidate ${result.from.slice(0, 12)} → ${result.to.slice(0, 12)}; it goes through the gates and every review again: factoryctl resume ${taskId}`
      : `${taskId}: no change; the task is where it was`);
  } catch (e) {
    fail(e instanceof TakeoverError ? e.message : e instanceof Error ? e.message : String(e));
  } finally {
    store.releaseLease(lease);
    lock.release();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
      untrusted: { type: "boolean" },
      remote: { type: "string" },
      priority: { type: "string" },
      replay: { type: "string" },
      gate: { type: "string" },
      reason: { type: "string" },
      week: { type: "string" },
      source: { type: "string" },
      begin: { type: "boolean" },
      checkout: { type: "string", multiple: true },
      repo: { type: "string" },
      attach: { type: "boolean" },
      host: { type: "string" },
      port: { type: "string" },
      "max-tasks": { type: "string" },
      weeks: { type: "string" },
      "app-id": { type: "string" },
      "installation-id": { type: "string" },
      runner: { type: "string" },
      "dry-run": { type: "boolean" },
      confirm: { type: "boolean" },
      "local-only": { type: "boolean" },
      "app-unavailable": { type: "boolean" },
      update: { type: "boolean" },
      "factory-ref": { type: "string" },
    },
  });
  const home = factoryHome();
  const command = positionals[0];

  if (command === "halt") {
    // The switch is a file, written before anything else can fail; the rest is best effort.
    ensureHome(home);
    const reason = values.reason ?? "no reason given";
    const { lines } = haltNow(home, operator(), reason);
    haltLog(home, { command: "halt", reason });
    for (const l of lines) out(l);
    out(`lift with: factoryctl unhalt --reason "…"`);
    return;
  }

  // The dashboard (P2-10) reads only: it opens the store read-only, never through the writer below.
  if (command === "dashboard") {
    if (!existsSync(home.db)) fail(`no event store at ${home.db} yet: create a task first`);
    const port = Number(values.port ?? String(DEFAULT_DASHBOARD_PORT));
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port takes a port number");
    const release = loadRelease(createValidator());
    const reader = EventStore.openReadOnly(home.db);
    let d;
    try {
      d = await startDashboard({ home, store: reader, budgets: release.budgets, port, log: (l) => process.stderr.write(`factoryctl: ${l}\n`) });
    } catch (e) {
      reader.close();
      fail(e instanceof Error ? e.message : String(e));
    }
    out(`dashboard: ${d.url}`);
    out("open that address in your browser (the token is in it); Ctrl-C stops the dashboard");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await d.close();
    reader.close();
    return;
  }

  if (command === "drill") {
    ensureHome(home);
    const kind = positionals[1];
    if (kind === "kill-switch") {
      operatorOnly("drill kill-switch");
      const d = await killSwitchDrill(home, operator());
      haltLog(home, { command: "halt", reason: "kill-switch drill" });
      for (const l of d.lines) out(l);
      out(`${d.passed ? "PASS" : "FAIL"}  all agent activity stopped in ${(d.stopped_ms / 1000).toFixed(1)} s (limit 300 s); before: ${describeActivity(d.before)}; after: ${describeActivity(d.after)}`);
      out(`record: ${d.record}`);
      out(`the factory stays halted; lift with: factoryctl unhalt --reason "…"`);
      process.exitCode = d.passed ? 0 : 1;
      return;
    }
    if (kind === "restore") {
      const d = await restoreDrill(home);
      out(`${d.passed ? "PASS" : "FAIL"}  restored ${String(d.tasks)} task(s), ${String(d.events)} events and ${String(d.files)} files in ${(d.rto_ms / 1000).toFixed(1)} s (RTO limit 3600 s)`);
      out(`replica behind by ${String(d.lag_events)} event(s), ${(d.rpo_ms / 1000).toFixed(1)} s (RPO limit 60 s)`);
      for (const x of d.damaged) out(`  not restored intact: ${x}`);
      out(`record: ${d.record}`);
      process.exitCode = d.passed ? 0 : 1;
      return;
    }
    if (kind === "serve-kill") {
      operatorOnly("drill serve-kill");
      let d;
      try {
        d = await serveKillDrill(home);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      out(`${d.killed ? "killed" : "FAILED to kill"} serve (pid ${String(d.serve_pid)}) while it ran ${d.tasks.map((t) => t.task).join(", ")}`);
      out(`record: ${d.record}`);
      out("start serve again (factoryctl serve); G2-3 passes once those tasks reach their merge gates with no side effect made twice: factoryctl gate G2");
      process.exitCode = d.killed ? 0 : 1;
      return;
    }
    fail("usage: factoryctl drill kill-switch | restore | serve-kill");
  }

  if (command === "replica") {
    ensureHome(home);
    const sub = positionals[1];
    if (sub === "init") {
      operatorOnly("replica init");
      const dir = positionals[2];
      if (dir === undefined) fail("usage: factoryctl replica init DIR (an absolute path, ideally on another volume)");
      let r;
      try {
        r = initReplica(home, dir, operator());
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      const synced = syncReplica(home);
      out(`replica at ${r.config.path}: ${String(synced?.events ?? 0)} events and ${String(synced?.objects ?? 0)} objects copied`);
      if (r.sameVolume) out(`warning: ${r.config.path} is on the same volume as ${home.root}; it survives no disk failure`);
      return;
    }
    if (sub === "sync" || sub === "status") {
      if (sub === "sync") syncReplica(home);
      const st = replicaStatus(home);
      if (st === null) fail("no replica is set: factoryctl replica init DIR");
      out(`replica at ${st.config.path}: ${st.state === null ? "never synced" : `${String(st.state.events)} events and ${String(st.state.objects)} objects, synced ${st.state.synced_at}`}; ${String(st.lag_events)} event(s) behind`);
      if (st.sameVolume) out(`warning: the replica is on the same volume as ${home.root}`);
      return;
    }
    fail("usage: factoryctl replica init DIR | sync | status");
  }

  if (command === "restore") {
    operatorOnly("restore");
    const from = values.source;
    if (from === undefined) fail("usage: factoryctl restore --source REPLICA_DIR (into an empty $FACTORY_HOME)");
    let r;
    try {
      r = await restore(resolve(from), home);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    out(`restored ${String(r.tasks)} task(s), ${String(r.events)} events, ${String(r.objects)} objects and ${String(r.files)} files from ${from} (synced ${r.synced_at ?? "?"})`);
    for (const x of r.missing) out(`  missing from the replica: ${x}`);
    out("each task rebuilds its clone on its next run: factoryctl resume T-…; set the replica again with: factoryctl replica init DIR");
    if (r.missing.length > 0) process.exitCode = 1;
    return;
  }

  if (command === "unhalt") {
    operatorOnly("unhalt");
    if (values.reason === undefined || values.reason.trim() === "") fail("--reason is required");
    const was = readHalt(home);
    if (was === null) fail("the factory is not halted");
    clearHalt(home);
    haltLog(home, { command: "unhalt", reason: values.reason });
    out(`factory running again (was ${describeHalt(was)}); continue a stopped task with: factoryctl resume T-…`);
    return;
  }

  if (command === "release") {
    ensureHome(home);
    const validator = createValidator();
    const sub = positionals[1];
    if (sub === "install") {
      operatorOnly("release install");
      const tag = positionals[2];
      if (tag === undefined) fail("usage: factoryctl release install TAG [--source DIR]");
      const r = await installRelease({ home, source: resolve(values.source ?? "."), tag, by: operator(), validator });
      const previous = pinRelease(home, r.info.sha);
      const shim = writeShim(home);
      out(`${r.installed ? "installed" : "already installed"} ${r.info.tag} (${r.info.sha}) at ${r.dir}`);
      out(`pinned ${r.info.tag}${previous !== null && previous !== r.info.sha ? ` (was ${previous.slice(0, 12)})` : ""}; run factoryctl from the release as ${shim}`);
      return;
    }
    if (sub === "use") {
      operatorOnly("release use");
      const ref = positionals[2];
      if (ref === undefined) fail("usage: factoryctl release use TAG|SHA");
      const info = findRelease(home, validator, ref);
      const previous = pinRelease(home, info.sha);
      out(`pinned ${info.tag} (${info.sha.slice(0, 12)})${previous !== null && previous !== info.sha ? `, was ${previous.slice(0, 12)}` : ""}`);
      return;
    }
    if (sub === "status") {
      const pinned = pinnedSha(home);
      const releases = listReleases(home, validator);
      if (releases.length === 0) out("no release installed");
      for (const info of releases) {
        const v = checkReleaseFiles(join(home.releases, info.sha), info);
        out(`${info.sha === pinned ? "*" : " "} ${info.tag.padEnd(8)} ${info.sha.slice(0, 12)}  installed ${info.installed_at} by ${info.installed_by}  ${v.ok ? v.detail : `MODIFIED: ${v.detail}`}`);
        if (!v.ok) process.exitCode = 1;
      }
      return;
    }
    fail("usage: factoryctl release install TAG [--source DIR] | use TAG|SHA | status");
  }

  if (command === "doctor") {
    const validator = createValidator();
    const release = loadRelease(validator);
    const checks = doctor(home, release, keyFile(home));
    // This repository's ruleset on GitHub against the release's copy (P2-08), when a token may read it.
    const token = process.env["FACTORY_GITHUB_TOKEN"];
    if (token !== undefined) {
      const self = parse(readFileSync(join(release.root, "profiles/self/profile.yaml"), "utf8")) as { target: { repo: string } };
      const expected = JSON.parse(readFileSync(join(release.root, ".github/rulesets/main.json"), "utf8")) as Parameters<typeof rulesetCheck>[0]["expected"];
      checks.push(await rulesetCheck({ repo: self.target.repo, expected, token, api: apiUrl() }));
      // Each governed fixture's footprint rulesets (P2-05b), against the release's.
      for (const name of fixtureNames()) {
        const fixture = parse(readFileSync(loadFixture(name, validator).profilePath, "utf8")) as { target: { repo: string }; governance?: unknown };
        if (fixture.governance === undefined) continue;
        for (const r of footprintRulesets()) checks.push(await rulesetCheck({ repo: fixture.target.repo, expected: r, token, api: apiUrl(), hint: `node scripts/mirror-fixture.ts ${name} --rulesets` }));
      }
    }
    checks.push(...(await appCheck({ home, api: apiUrl() })));
    // Each onboarded target (P2-11): its state, its profile, its rulesets and the App's access.
    checks.push(...(await targetChecks({ home, validator, token: token ?? null, api: apiUrl() })));
    for (const c of checks) out(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
    process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
    return;
  }

  // `app init` (P2-05): the App's two IDs, which are not secrets, next to its key in the home.
  if (command === "app") {
    const sub = positionals[1];
    if (sub !== "init") fail("usage: factoryctl app init --app-id N --installation-id N");
    const appId = Number(values["app-id"]);
    const installationId = Number(values["installation-id"]);
    if (!Number.isSafeInteger(appId) || appId <= 0 || !Number.isSafeInteger(installationId) || installationId <= 0) fail("usage: factoryctl app init --app-id N --installation-id N");
    ensureHome(home);
    writeAtomic(appConfigPath(home), `${JSON.stringify({ app_id: appId, installation_id: installationId }, null, 2)}\n`, 0o600);
    out(`wrote ${appConfigPath(home)}; the key stays in ${join(home.secrets, "github-app.pem")}`);
    for (const c of await appCheck({ home, api: apiUrl() })) out(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
    return;
  }

  ensureHome(home);
  const store = EventStore.open(home.db);
  // While serve runs it is the single writer (P2-03): task commands go through its API, and
  // nothing else drives a task.
  const served = liveServe(home);
  const viaServe = async (path: string, body: Record<string, unknown> = {}): Promise<void> => {
    if (served === null) fail("serve is not running");
    const r = await callServe(home, served, "POST", path, body);
    if (r.status !== 200) fail(r.body.message ?? r.body.error ?? `serve answered ${String(r.status)}`);
    out(r.body.message ?? "done");
  };
  const exclusive = ["run", "takeover", "reject", "prune", "offboard"];
  if (served !== null && command !== undefined && exclusive.includes(command)) {
    fail(`serve is running (pid ${String(served.pid)}) and schedules every task; pause or cancel the task through it, or stop it with: factoryctl drain`);
  }
  try {
    switch (command) {
      case "serve": {
        const replay = values.replay;
        const validator = createValidator();
        const release = loadRelease(validator);
        // Live serve: every session in the runner, so its image is built now rather than by the first worker.
        if (replay === undefined) {
          try {
            ensureRunnerImage(release.root);
          } catch (e) {
            fail(`serve runs live sessions in the runner, whose image could not be built: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const max = Number(values["max-tasks"] ?? String(release.config.concurrency.max_tasks));
        const port = Number(values.port ?? String(DEFAULT_PORT));
        if (!Number.isInteger(max) || max < 1) fail("--max-tasks takes a positive integer");
        if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port takes a port number");
        const log = (line: string): void => {
          process.stderr.write(`factoryctl serve: ${line}\n`);
        };
        carryCanary(home);
        let s;
        try {
          s = await startServe({ home, store, cli: fileURLToPath(import.meta.url), maxTasks: max, host: values.host ?? "127.0.0.1", port, ...(replay === undefined ? {} : { replay: resolve(replay) }), log });
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
        out(`serve listening on ${values.host ?? "127.0.0.1"}:${String(port)} (pid ${String(process.pid)}), up to ${String(max)} task(s) at once`);
        const stop = s.stop;
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        // Commands through the API write too: serve keeps the replica up to date as well as its workers (P2-07).
        const replica = keepReplica(home, log);
        await s.done;
        replica.stop();
        return;
      }
      case "intake": {
        const validator = createValidator();
        // With no profiles named, every onboarded target that takes issues (P2-11).
        const named = positionals.slice(1).map((p) => resolve(p));
        const profiles = named.length > 0 ? named : listTargets(home, validator).filter((t) => t.state === "active").flatMap((t) => {
          try {
            return [activeProfile(home, t.repo, validator).path];
          } catch (e) {
            process.stderr.write(`factoryctl: skipping ${t.repo}: ${e instanceof Error ? e.message : String(e)}\n`);
            return [];
          }
        });
        if (profiles.length === 0) fail("usage: factoryctl intake [PROFILE.yaml...]: name profiles, or onboard a target (factoryctl onboard OWNER/NAME)");
        const targets = profiles.flatMap((p) => {
          const profile = loadProfile(p, validator);
          if (profile.intake === undefined) {
            if (named.length > 0) fail(`${p} has no intake: block (label and maintainers)`);
            return [];
          }
          return [{ profilePath: p, profile }];
        });
        const app = appConfig(home);
        const token = process.env["FACTORY_GITHUB_TOKEN"];
        const api = apiUrl();
        if (app === null && token === undefined) fail("intake reads issues as the factory App (factoryctl app init) or with FACTORY_GITHUB_TOKEN");
        // As the App, a token narrowed to each target in turn.
        const github = async (repo: string): Promise<GitHub> => {
          if (app === null) return restGitHub(token ?? "", api);
          const tokens = appTokens({ app, api, repositories: [repo.split("/")[1] ?? repo] });
          await tokens.refresh();
          return restGitHub(() => tokens.token(), api);
        };
        const log = (line: string): void => {
          process.stderr.write(`factoryctl: ${line}\n`);
        };
        for (const r of await pollIntake({ home, store, validator, github, targets, log })) {
          const what = `${r.repo}#${String(r.number)}`;
          if (r.outcome === "admitted") out(`admitted ${what} as ${r.task ?? ""}`);
          else if (r.outcome === "known") out(`${what} is ${r.task ?? ""}`);
          else out(`${r.outcome} ${what}: ${r.reason ?? ""}`);
        }
        return;
      }
      case "worker":
        // A worker runs unattended: its live sessions only ever in the runner.
        if (values.replay === undefined && values.runner !== "container") fail("a worker's live sessions run in the runner: --runner container");
        await drive(home, store, taskArg(positionals, 1, store), { replay: values.replay, resume: true, attach: false, worker: true, container: values.runner === "container" });
        return;
      case "drain":
        await viaServe("/v1/drain");
        return;
      case "task": {
        if (positionals[1] !== "create") fail("usage: factoryctl task create --profile FILE | --repo OWNER/NAME --title TEXT --body-file FILE");
        if ((values.profile === undefined) === (values.repo === undefined) || values.title === undefined || values["body-file"] === undefined) fail("task create needs --profile or --repo (an onboarded target), --title and --body-file");
        const priority = values.priority ?? "normal";
        if (priority !== "low" && priority !== "normal" && priority !== "high") fail("--priority is low, normal or high");
        const validator = createValidator();
        // An onboarded target's profile as confirmed, and its remote (P2-11).
        const onboarded = values.repo === undefined ? null : (() => {
          try {
            return activeProfile(home, values.repo, validator);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        })();
        const remote = values.remote ?? onboarded?.record.remote;
        const task = createTask(home, store, validator, {
          profilePath: onboarded?.path ?? values.profile ?? "",
          title: values.title,
          body: readFileSync(values["body-file"], "utf8"),
          trust: values.untrusted === true ? "untrusted" : "operator",
          admittedBy: process.env["USER"] ?? "operator",
          priority,
          ...(remote === undefined ? {} : { remote }),
        });
        out(task.id);
        return;
      }
      case "offboard": {
        operatorOnly("offboard");
        const repo = positionals[1];
        if (repo === undefined) fail("usage: factoryctl offboard OWNER/NAME [--local-only | --app-unavailable] [--reason TEXT]");
        const validator = createValidator();
        const release = loadRelease(validator);
        const token = process.env["FACTORY_GITHUB_TOKEN"] ?? null;
        const api = apiUrl();
        let app;
        try {
          app = appConfig(home);
        } catch (e) {
          fail(e instanceof AppConfigError ? e.message : String(e));
        }
        // Kill points, for tests only, with nothing leaving the machine.
        const injection = values.replay === undefined ? {} : readInjection(values.replay);
        if (values.replay !== undefined && token !== null && !isLoopbackApi(api)) fail("--replay needs a loopback FACTORY_GITHUB_API_URL");
        const probe = killAt(injection.kill_at);
        const engine = process.env["FACTORY_CONTAINER_ENGINE"] ?? "docker";
        try {
          process.exitCode = await offboard(repo, {
            localOnly: values["local-only"] === true,
            appUnavailable: values["app-unavailable"] === true,
            ...(values.reason === undefined ? {} : { reason: values.reason }),
          }, {
            home, store, validator, release, token, api, app,
            github: token === null ? null : restGitHub(token, api),
            operator: operator(),
            now: () => new Date(),
            busy: () => {
              const a = activity(home);
              return idle(a) ? null : describeActivity(a);
            },
            engine: (args) => {
              const r = spawnSync(engine, args, { encoding: "utf8" });
              return { status: r.status, stderr: r.stderr || (r.error?.message ?? "") };
            },
            out,
            log: (l) => process.stderr.write(`factoryctl: ${l}\n`),
            ...(probe === undefined ? {} : { probe }),
          });
        } catch (e) {
          if (e instanceof OffboardError || e instanceof RegistryError || e instanceof PurgeError) fail(e.message);
          throw e;
        }
        return;
      }
      case "onboard": {
        operatorOnly("onboard");
        const repo = positionals[1];
        if (repo === undefined || (values.confirm === true && values.update === true)) fail("usage: factoryctl onboard OWNER/NAME [--remote URL] [--confirm | --update] [--factory-ref TAG [--source DIR]]");
        const validator = createValidator();
        const release = loadRelease(validator);
        const token = process.env["FACTORY_GITHUB_TOKEN"] ?? null;
        const api = apiUrl();
        let app;
        try {
          app = appConfig(home);
        } catch (e) {
          fail(e instanceof AppConfigError ? e.message : String(e));
        }
        // Replayed gates, for tests only: a local remote and a loopback API, as for a task.
        const injection = values.replay === undefined ? {} : readInjection(values.replay);
        const remote = values.remote ?? readTarget(home, repo, validator)?.remote;
        if (injection.gates !== undefined && (remote === undefined || !isLocalRemote(remote) || !isLoopbackApi(api))) fail("replayed gates need a local --remote and a loopback FACTORY_GITHUB_API_URL");
        const probe = killAt(injection.kill_at);
        try {
          process.exitCode = await onboard(repo, {
            ...(values.remote === undefined ? {} : { remote: values.remote }),
            confirm: values.confirm === true,
            update: values.update === true,
            ...(values["factory-ref"] === undefined ? {} : { factoryRef: values["factory-ref"] }),
            ...(values.source === undefined ? {} : { source: values.source }),
          }, {
            home, validator, release, token, api, app,
            github: token === null ? null : restGitHub(token, api),
            reads: token === null ? null : targetReads(token, api),
            runGates: injection.gates === undefined ? runGates : replayedGates(injection.gates),
            gateImage: injection.gates === undefined ? () => ensureImage() : () => "software-factory-gates:replay",
            operator: operator(),
            now: () => new Date(),
            out,
            log: (l) => process.stderr.write(`factoryctl: ${l}\n`),
            ...(probe === undefined ? {} : { probe }),
          });
        } catch (e) {
          if (e instanceof OnboardError || e instanceof RegistryError || e instanceof LayerError || e instanceof FootprintError) fail(e.message);
          throw e;
        }
        return;
      }
      case "run":
      case "resume":
        if (command === "resume" && positionals[1] === undefined) {
          await viaServe("/v1/resume");
          return;
        }
        if (served !== null) {
          await viaServe(`/v1/tasks/${taskArg(positionals, 1, store)}/resume`);
          return;
        }
        if (values.runner !== undefined && values.runner !== "host" && values.runner !== "container") fail("--runner is host or container");
        await drive(home, store, taskArg(positionals, 1, store), { replay: values.replay, resume: command === "resume", attach: values.attach === true, container: values.runner === "container" });
        return;
      case "pause": {
        if (positionals[1] === undefined) {
          await viaServe("/v1/pause", values.reason === undefined ? {} : { reason: values.reason });
          return;
        }
        if (served !== null) {
          await viaServe(`/v1/tasks/${taskArg(positionals, 1, store)}/pause`, values.reason === undefined ? {} : { reason: values.reason });
          return;
        }
        const id = taskArg(positionals, 1, store);
        const events = store.events(id);
        if (isTerminal(currentState(events))) fail(`${id} has already ended`);
        if (isPaused(events)) {
          out(`${id} is already paused; continue it with: factoryctl resume ${id}`);
          return;
        }
        store.append({ task_id: id, actor: { kind: "operator", id: operator() }, type: "command", payload: { command: "pause", reason: values.reason ?? "no reason given" } });
        out(liveHolder(home)?.task_id === id ? `${id} pauses at its next step boundary; continue it with: factoryctl resume ${id}` : `${id} paused; continue it with: factoryctl resume ${id}`);
        return;
      }
      case "takeover":
        await takeover(home, store, taskArg(positionals, 1, store));
        return;
      case "status": {
        const ids = positionals[1] === undefined ? store.taskIds() : [taskArg(positionals, 1, store)];
        const halt = readHalt(home);
        if (halt !== null) out(`HALTED  ${describeHalt(halt)}`);
        if (served !== null) out(`serve running (pid ${String(served.pid)}, ${served.host}:${String(served.port)})`);
        for (const id of ids) {
          const events = store.events(id);
          const payload = currentStatePayload(events);
          const gate = typeof payload["gate"] === "string" ? ` gate=${payload["gate"]}` : "";
          // A task runs while its lease is held: by an attended run or a serve worker (P2-03).
          const running = leaseState(store.lease(id), Date.now()) === "held" ? " (running)" : isPaused(events) ? " (paused)" : "";
          const expired = expiredScopes(events).has("bundle") ? " (evidence expired)" : "";
          out(`${id}  ${currentState(events).padEnd(12)}${gate}${running}${expired}  ${taskRecord(home, store, id)?.title ?? "(no task record)"}`);
        }
        return;
      }
      case "prune": {
        operatorOnly("prune");
        const now = activity(home);
        if (!idle(now)) fail(`prune runs only while the factory is idle; now: ${describeActivity(now)}`);
        const validator = createValidator();
        const release = loadRelease(validator);
        const dryRun = values["dry-run"] === true;
        // A purge that stopped part-way finishes first (ADR 0003).
        for (const j of pendingJournals(home)) {
          if (dryRun) {
            out(`purge ${j.id} (${j.reason}) stopped part-way: prune finishes it`);
            continue;
          }
          const r = runJournal(home, store, j);
          out(`purge ${j.id} (${j.reason}) finished: ${String(r.tasks)} task(s), ${String(r.objects)} object(s), ${String(r.paths)} path(s)`);
        }
        const plan = planRetention({ store, config: release.config.retention_days, policyFor: profilePolicy(home, store, validator), now: new Date() });
        for (const x of plan.expire) out(`${x.task_id}  ${x.scope}: ${String(x.age_days)} day(s) since its last activity; kept ${String(x.days)}`);
        for (const u of plan.unfinished) out(`${u.task_id}  not finished after ${String(u.age_days)} day(s): cancel or resume it; prune leaves it`);
        if (plan.fallback.length > 0) out(`no readable profile for ${plan.fallback.join(", ")}: the config's retention applies`);
        if (dryRun) {
          out(`dry run: ${String(plan.expire.length)} expiry(ies) and ${String(plan.otel.length)} task(s)' telemetry due; nothing changed`);
          return;
        }
        const r = prune({ home, store, plan, by: operator() });
        out(`pruned: ${String(r.expired.length)} expiry(ies) recorded; ${String(r.objects)} object(s), ${String(r.paths)} path(s) and ${String(r.otel)} telemetry export(s) deleted${r.replica === null ? "" : `; the replica deleted ${String(r.replica)} object(s)`}`);
        return;
      }
      case "cancel": {
        if (served !== null) {
          await viaServe(`/v1/tasks/${taskArg(positionals, 1, store)}/cancel`);
          return;
        }
        const id = taskArg(positionals, 1, store);
        if (isTerminal(currentState(store.events(id)))) fail(`${id} has already ended`);
        // The command first, so a run still holding the lease stops without failing the task; then
        // the lease, which stops that run (P2-03), and the transition under it.
        store.append({ task_id: id, actor: { kind: "operator", id: process.env["USER"] ?? "operator" }, type: "command", payload: { command: "cancel" } });
        const lease = await takeLease(home, store, id, { force: true, log: (l) => process.stderr.write(`factoryctl: ${l}\n`) });
        try {
          transition(store, id, "CANCELLED", { by: "operator" });
        } finally {
          store.releaseLease(lease);
        }
        out(`${id} CANCELLED`);
        return;
      }
      case "approve": {
        // An agent must never approve its own work (ROADMAP §2.6).
        operatorOnly("approve");
        const id = taskArg(positionals, 1, store);
        if (values.gate !== "spec") fail("only --gate spec is approved here; a merge is approved by your GitHub review on the PR");
        if (values.reason === undefined || values.reason.trim() === "") fail("--reason is required");
        const events = store.events(id);
        if (currentState(events) !== "NEEDS_HUMAN" || currentStatePayload(events)["gate"] !== "spec") fail(`${id} is not waiting at the spec gate`);
        // The approval is bound to the spec read now: a spec that runs again needs a new one.
        const digest = specDigest(runDir(home, id));
        store.append({ task_id: id, actor: { kind: "operator", id: process.env["USER"] ?? "operator" }, type: "command", payload: { command: "approve", gate: "spec", reason: values.reason, spec_digest: digest } });
        out(`${id} spec approved (${digest.slice(0, 19)}); continue with: factoryctl resume ${id}`);
        return;
      }
      case "reject": {
        // The operator's "no" to a task's result: P1-07's human_rejected (a PR closed unmerged maps to it with P1-02).
        operatorOnly("reject");
        const id = taskArg(positionals, 1, store);
        if (values.reason === undefined || values.reason.trim() === "") fail("--reason is required");
        const events = store.events(id);
        const at = currentState(events);
        if (isTerminal(at)) fail(`${id} has already ended`);
        const by = { kind: "operator" as const, id: operator() };
        const stage = typeof currentStatePayload(events)["gate"] === "string" ? `${String(currentStatePayload(events)["gate"])}-gate` : at.toLowerCase();
        store.append({ task_id: id, actor: by, type: "command", payload: { command: "reject", reason: values.reason } });
        const lease = await takeLease(home, store, id, { force: true, log: (l) => process.stderr.write(`factoryctl: ${l}\n`) });
        try {
          store.append({ task_id: id, actor: { kind: "factoryctl", id: "factoryctl" }, type: "stage_failed", payload: { stage, category: "human_rejected", reason: values.reason } });
          transition(store, id, "FAILED", { stage, category: "human_rejected", reason: values.reason, by: by.id });
        } finally {
          store.releaseLease(lease);
        }
        out(`${id} FAILED (human_rejected)${currentStatePayload(events)["gate"] === "merge" ? "; close its PR on GitHub" : ""}`);
        return;
      }
      case "report": {
        if (positionals[1] !== undefined) {
          const id = taskArg(positionals, 1, store);
          printTaskReport(taskReport(store.events(id), reviewsOf(home, id)));
          // The code graph's blast radius (P2-13): logged, never enforced, until P3-05 measures it.
          const blasts = readBlasts(runDir(home, id));
          out(`code graph (shadow): ${blasts.length === 0 ? "no decision logged" : blasts.map(describeBlast).join("; ")}`);
          return;
        }
        const all = store.allEvents();
        const row = weekRow(all, values.week ?? isoWeek(new Date()));
        out(`week ${row.week} (UTC, tasks created that week; live sessions only)`);
        out(WEEK_HEADER);
        out(weekRowMarkdown(row));
        const { start, end } = weekRange(row.week);
        const created = all.filter((e) => e.type === "task_created" && Date.parse(e.ts) >= start.getTime() && Date.parse(e.ts) < end.getTime()).map((e) => e.task_id);
        const c = shadowCounts(created.flatMap((t) => readBlasts(runDir(home, t))));
        out(`code graph (shadow): ${String(c.decisions)} decision(s), ${String(c.fresh)} fresh, ${String(c.stale)} stale, ${String(c.missing)} missing, ${String(c.error)} error; the rule matched ${String(c.matched)} and would have raised the tier ${String(c.raised)} time(s)`);
        return;
      }
      case "slo": {
        // The SLOs over a rolling window (P2-08), then what the sessions' telemetry recorded.
        const weeks = Number(values.weeks ?? "4");
        if (!Number.isInteger(weeks) || weeks < 1) fail("--weeks takes a positive integer");
        const release = loadRelease(createValidator());
        const end = new Date();
        const start = new Date(end.getTime() - weeks * 7 * 86_400_000);
        const byTask = new Map<string, FactoryEvent[]>();
        for (const e of store.allEvents()) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
        const read = (task: string, path: string): string | null => {
          try {
            return readFileSync(join(runDir(home, task), path), "utf8");
          } catch {
            return null;
          }
        };
        out(`SLOs over the ${String(weeks)} week(s) to ${end.toISOString().slice(0, 10)}: ${String(windowTasks(byTask, start, end))} live task(s) (docs/factory/slo.md)`);
        for (const r of measureSlos({ byTask, read, budgets: release.budgets, start, end })) {
          out(`${r.status.padEnd(12)}  ${r.name.padEnd(24)}  target ${r.target.padEnd(22)}  ${r.value}  (${r.basis})`);
        }
        const panel = otelPanel(readOtel(otelDir(home.root)).filter((x) => Date.parse(x.received_at) >= start.getTime()));
        out(panel.length === 0 ? "telemetry: no exports in the window" : "telemetry (task: exports, API requests, API errors, tool decisions accepted/rejected):");
        for (const p of panel) out(`  ${p.task}: ${String(p.exports)} exports, ${String(p.api_requests)} requests, ${String(p.api_errors)} errors, ${String(p.tool_decisions.accept)}/${String(p.tool_decisions.reject)} tool decisions`);
        return;
      }
      case "eval": {
        if (positionals[1] !== "capture") fail("usage: factoryctl eval capture T-0001");
        const id = taskArg(positionals, 2, store);
        const release = loadRelease(createValidator());
        const captured = captureTask(home, id, release.info?.repository ?? "caglarsubas/software-factory-claude-code");
        if (captured.length === 0) fail(`${id} has no judgment stage to capture yet`);
        for (const c of captured) out(`captured ${c.label} (${c.role}) at ${c.dir}`);
        if (captured.some((c) => c.target === "private")) out("target:private: these cases hold a private target's code and must never be committed to the factory repository");
        out("each case's expect tag is TODO: decide whether the observed answer was right, then move a fixture or self case into plugin/evals");
        return;
      }
      case "budgets": {
        // G1-5: the tier budgets the P1-01 rule sets, recorded with their evidence.
        const validator = createValidator();
        const release = loadRelease(validator);
        const byTask = new Map<string, ReturnType<typeof store.events>>();
        for (const e of store.allEvents()) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
        const runs = completedRuns(byTask);
        const tiers = calibrate(release.budgets, runs);
        const month = monthOf(new Date());
        const targets = new Map<string, { ids: Set<string>; cap: number | null }>();
        for (const id of store.taskIds()) {
          try {
            const t = readTask(home, id);
            const entry = targets.get(t.target.repo) ?? { ids: new Set<string>(), cap: null };
            entry.ids.add(id);
            try {
              entry.cap = loadProfile(t.target.profile, validator).budgets.monthly_usd;
            } catch {
              // A profile that moved or no longer validates leaves the cap unknown.
            }
            targets.set(t.target.repo, entry);
          } catch {
            // A task without its run directory has no target to report.
          }
        }
        out(`tier        budget  source       runs  observed max  (×${String(release.budgets.calibration.multiplier)} until ${String(release.budgets.calibration.min_runs_per_tier)} runs, then frozen)`);
        for (const t of TIERS) {
          const b = tiers[t];
          out(`${t.padEnd(10)} ${`$${b.budget.toFixed(2)}`.padStart(8)}  ${b.source.padEnd(11)} ${String(b.runs).padStart(5)}  ${b.observedMaxUsd === null ? "—" : `$${b.observedMaxUsd.toFixed(2)}`}`);
        }
        const months = [...targets].map(([target, e]) => ({ target, month, spent_usd: Math.round(monthSpend(byTask, e.ids, month) * 100) / 100, cap_usd: e.cap }));
        for (const m of months) out(`${m.month}  ${m.target}: $${m.spent_usd.toFixed(2)} of ${m.cap_usd === null ? "an unknown cap" : `$${m.cap_usd.toFixed(2)}`}`);
        const dir = join(home.root, "budgets");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, "calibration.json");
        writeAtomic(path, `${JSON.stringify({ schema_version: 1, computed_at: new Date().toISOString(), policy: { task_usd: release.budgets.task_usd, calibration: release.budgets.calibration }, tiers, runs: runs.length, months }, null, 2)}\n`);
        out(`recorded: ${path}`);
        return;
      }
      case "gate": {
        const gate = positionals[1];
        if (gate !== "G0" && gate !== "G1" && gate !== "G2") fail("usage: factoryctl gate G0|G1|G2 --begin [--checkout DIR]... | gate G0|G1|G2 [--repo OWNER/NAME]");
        const validator = createValidator();
        const release = loadRelease(validator);
        if (values.begin === true) {
          const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
          const checkouts = values.checkout ?? (top.status === 0 ? [top.stdout.trim()] : []);
          if (checkouts.length === 0 && gate !== "G2") fail("not inside a git checkout: name the operator checkout(s) with --checkout DIR");
          // G2-5's canary: planted now, so every run and serve in the window carries it (canary.ts).
          const begin = beginGate(home, gate, release, checkouts.map((c) => resolve(c)), new Date(), gate === "G2" ? { canary: plantCanary(home) } : {});
          for (const c of begin.checkouts) out(`snapshot ${c.path}: ${String(c.files)} files, ${c.digest}`);
          out(`${gate} evidence window open since ${begin.started_at}${begin.release === null ? " (development checkout, not an installed release)" : ` on ${begin.release.tag}`}`);
          if (begin.canary !== undefined) out(`canary planted (${begin.canary}); runs and serve started from now on carry it`);
          out(
            gate === "G0" ? "now run one task per fixture to its PR, then: factoryctl gate G0"
            : gate === "G1" ? "now run at least one counted task to its merge, then: factoryctl budgets && factoryctl gate G1"
            : "now run the sample, the seeded suite and the drills on this release, then: factoryctl gate G2",
          );
          return;
        }
        const checks = restCommitChecks(process.env["FACTORY_GITHUB_TOKEN"] ?? null, apiUrl());
        const evidence =
          gate === "G0" ? await evaluateG0({ home, store, validator, release, deps: { bypass: runBypassVariants, checks, doctor: doctor(home, release, keyFile(home)), repository: values.repo ?? null } })
          : gate === "G1" ? await evaluateG1({ home, store, validator, release, deps: { checks, repository: values.repo ?? null } })
          : await evaluateG2({ home, store, validator, release, deps: await g2Deps(home) });
        const files = writeEvidence(home, evidence);
        for (const c of evidence.criteria) out(`${c.status.padEnd(5)}  ${c.id}  ${c.detail}`);
        out(`evidence: ${files.json}`);
        out(`evidence PR body: ${files.markdown}`);
        process.exitCode = evidence.passed ? 0 : 1;
        return;
      }
      default:
        fail("usage: factoryctl task create | run | resume | pause | takeover | status | cancel | approve | reject | report | budgets | eval | halt | unhalt | release | gate | doctor | serve | drain | replica | restore | drill | slo | prune | onboard | offboard | intake");
    }
  } finally {
    store.close();
    // Every command's writes reach the replica before it exits (P2-07); a failed sync is the replica's problem, never the command's.
    try {
      syncReplica(home);
    } catch (e) {
      process.stderr.write(`factoryctl: replica not synced: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e), 1);
});
