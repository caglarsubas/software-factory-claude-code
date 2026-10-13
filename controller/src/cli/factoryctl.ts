#!/usr/bin/env node
// factoryctl v0 (ROADMAP P0-07, P0-09): task create, run, resume, status, cancel, approve,
// doctor, the kill switch, releases and gate evidence.
//
//   factoryctl task create --profile FILE --title TEXT --body-file FILE [--untrusted] [--remote URL]
//   factoryctl run T-0001 [--replay DIR]     drive a task until it needs a human or ends
//   factoryctl resume T-0001 [--replay DIR]  the same, after a stop, a halt or a crash
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
//   factoryctl gate G0 --begin [--checkout DIR]... | gate G0 [--repo OWNER/NAME]
//   factoryctl doctor
//
// FACTORY_HOME holds run state (default ~/.factory); FACTORY_RELEASE overrides the release the
// running code belongs to; FACTORY_GITHUB_TOKEN pushes and opens PRs. --replay replays
// recorded transcripts instead of calling a model: zero tokens.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { engineHost, killGateContainers, PROXY_ENV } from "../../../gates/src/container.ts";
import { runGates } from "../../../gates/src/run.ts";
import { ensureImage } from "../../../gates/src/image.ts";
import { runBypassVariants } from "../../../plugin/hooks/bypass-cases.ts";
import { doctor } from "../doctor.ts";
import { beginG0, evaluateG0, writeEvidence } from "../gate/g0.ts";
import { restCommitChecks, restGitHub } from "../github/client.ts";
import { clearHalt, describeHalt, readHalt, setHalt } from "../halt.ts";
import { acquireRunLock, ensureHome, factoryHome, readLock, runDir, type Home } from "../home.ts";
import { loadRelease } from "../release.ts";
import { checkReleaseFiles, findRelease, installRelease, listReleases, pinnedSha, pinRelease, writeShim } from "../release/install.ts";
import { createValidator } from "../schemas/validate.ts";
import { replayRunner } from "../session/replay.ts";
import { sdkRunner } from "../session/runner.ts";
import { calibrate, completedRuns, monthOf, monthSpend, TIERS } from "../budget/budget.ts";
import { captureTask } from "../evals/capture.ts";
import { writeAtomic } from "../fsutil.ts";
import { isoWeek, taskReport, WEEK_HEADER, weekRow, weekRowMarkdown, type TaskReport } from "../report/report.ts";
import { specDigest } from "../stages/commit.ts";
import { runTask } from "../stages/pipeline.ts";
import { EventStore } from "../store/events.ts";
import { currentState, currentStatePayload, isTerminal, transition } from "../task/lifecycle.ts";
import { createTask, loadProfile, readTask } from "../task/task.ts";

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

/** Every halt and unhalt, one JSON line each: the kill switch's own audit trail. */
function haltLog(home: Home, entry: Record<string, unknown>): void {
  appendFileSync(join(home.root, "halt.log"), `${JSON.stringify({ at: new Date().toISOString(), by: operator(), ...entry })}\n`, { mode: 0o600 });
}

function keyFile(home: Home): string {
  return process.env["FACTORY_API_KEY_FILE"] ?? join(home.secrets, "anthropic.key");
}

/** The review artifacts' findings, for the per-task report; a run without reviews has none. */
function reviewsOf(home: Home, taskId: string): { findings: { severity: string }[] }[] {
  return ["review-code.json", "review-security.json"].flatMap((name) => {
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
  for (const s of r.stages) row([`${s.label}${s.ok ? "" : " ✗"}`, s.runner, String(s.round), n(s.numTurns), n(s.inputTokens), n(s.outputTokens), min(s.durationMs), s.costUsd.toFixed(2)]);
  row(["total", "", "", "", n(r.totals.inputTokens), n(r.totals.outputTokens), min(r.totals.durationMs), r.totals.costUsd.toFixed(2)]);
  if (r.findings !== null) out(`findings: ${Object.entries(r.findings).map(([k, v]) => `${k} ${String(v)}`).join(", ")}`);
}

async function drive(home: Home, store: EventStore, taskId: string, replay: string | undefined): Promise<void> {
  const halt = readHalt(home);
  if (halt !== null) fail(`the factory is ${describeHalt(halt)}; lift it with: factoryctl unhalt --reason "…"`);
  const validator = createValidator();
  const release = loadRelease(validator);
  const token = process.env["FACTORY_GITHUB_TOKEN"];
  const release_lock = acquireRunLock(home, taskId);
  const abort = new AbortController();
  const onSignal = (): void => {
    abort.abort();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    const state = await runTask({
      home, store, validator, release, taskId, abort,
      deps: {
        runner: replay === undefined ? sdkRunner : replayRunner(replay),
        runGates,
        gateImage: () => ensureImage(),
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
        github: token === undefined ? null : restGitHub(token),
        auth: token === undefined ? null : { token },
        keyFile: keyFile(home),
        ...(process.env["FACTORY_GATES_FETCH_NETWORK"] === undefined ? {} : { gatesFetchNetwork: process.env["FACTORY_GATES_FETCH_NETWORK"] }),
        ...(process.env["FACTORY_GATES_CA_FILE"] === undefined ? {} : { gatesCaFile: process.env["FACTORY_GATES_CA_FILE"] }),
        log: (line) => process.stderr.write(`factoryctl: ${line}\n`),
      },
    });
    const payload = currentStatePayload(store.events(taskId));
    const halted = readHalt(home) === null ? "" : " (halted)";
    out(`${taskId} ${state}${typeof payload["gate"] === "string" ? ` (gate: ${payload["gate"]})` : ""}${typeof payload["pr_url"] === "string" ? ` ${payload["pr_url"]}` : ""}${halted}`);
    if (state === "FAILED") process.exitCode = 1;
  } finally {
    release_lock();
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
    },
  });
  const home = factoryHome();
  const command = positionals[0];

  if (command === "halt") {
    // The switch is a file, written before anything else can fail; the rest is best effort.
    ensureHome(home);
    const reason = values.reason ?? "no reason given";
    const halt = setHalt(home, operator(), reason);
    haltLog(home, { command: "halt", reason });
    const lock = readLock(home);
    if (lock !== null) {
      try {
        process.kill(lock.pid, "SIGTERM");
      } catch {
        // The runner already exited.
      }
      try {
        const store = EventStore.open(home.db);
        store.append({ task_id: lock.task_id, actor: { kind: "operator", id: operator() }, type: "command", payload: { command: "halt", reason } });
        store.close();
      } catch {
        // The audit event is secondary to the halt itself.
      }
    }
    const containers = killGateContainers();
    out(`factory ${describeHalt(halt)}`);
    out(lock === null ? "no task was running" : `signalled ${lock.task_id} (pid ${String(lock.pid)}); it stops without failing and resumes later`);
    out(`${String(containers)} gate container(s) stopped`);
    out(`lift with: factoryctl unhalt --reason "…"`);
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
    const release = loadRelease(createValidator());
    const checks = doctor(home, release, keyFile(home));
    for (const c of checks) out(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
    process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
    return;
  }

  ensureHome(home);
  const store = EventStore.open(home.db);
  try {
    switch (command) {
      case "task": {
        if (positionals[1] !== "create") fail("usage: factoryctl task create --profile FILE --title TEXT --body-file FILE");
        if (values.profile === undefined || values.title === undefined || values["body-file"] === undefined) fail("task create needs --profile, --title and --body-file");
        const priority = values.priority ?? "normal";
        if (priority !== "low" && priority !== "normal" && priority !== "high") fail("--priority is low, normal or high");
        const task = createTask(home, store, createValidator(), {
          profilePath: values.profile,
          title: values.title,
          body: readFileSync(values["body-file"], "utf8"),
          trust: values.untrusted === true ? "untrusted" : "operator",
          admittedBy: process.env["USER"] ?? "operator",
          priority,
          ...(values.remote === undefined ? {} : { remote: values.remote }),
        });
        out(task.id);
        return;
      }
      case "run":
      case "resume":
        await drive(home, store, taskArg(positionals, 1, store), values.replay);
        return;
      case "status": {
        const ids = positionals[1] === undefined ? store.taskIds() : [taskArg(positionals, 1, store)];
        const lock = readLock(home);
        const halt = readHalt(home);
        if (halt !== null) out(`HALTED  ${describeHalt(halt)}`);
        for (const id of ids) {
          const events = store.events(id);
          const payload = currentStatePayload(events);
          const gate = typeof payload["gate"] === "string" ? ` gate=${payload["gate"]}` : "";
          const running = lock?.task_id === id ? " (running)" : "";
          out(`${id}  ${currentState(events).padEnd(12)}${gate}${running}  ${readTask(home, id).title}`);
        }
        return;
      }
      case "cancel": {
        const id = taskArg(positionals, 1, store);
        if (isTerminal(currentState(store.events(id)))) fail(`${id} has already ended`);
        store.append({ task_id: id, actor: { kind: "operator", id: process.env["USER"] ?? "operator" }, type: "command", payload: { command: "cancel" } });
        transition(store, id, "CANCELLED", { by: "operator" });
        const lock = readLock(home);
        // The running stage stops at its next boundary; signal the runner to abort its session now.
        if (lock?.task_id === id) process.kill(lock.pid, "SIGTERM");
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
        store.append({ task_id: id, actor: { kind: "factoryctl", id: "factoryctl" }, type: "stage_failed", payload: { stage, category: "human_rejected", reason: values.reason } });
        transition(store, id, "FAILED", { stage, category: "human_rejected", reason: values.reason, by: by.id });
        const lock = readLock(home);
        if (lock?.task_id === id) process.kill(lock.pid, "SIGTERM");
        out(`${id} FAILED (human_rejected)${currentStatePayload(events)["gate"] === "merge" ? "; close its PR on GitHub" : ""}`);
        return;
      }
      case "report": {
        if (positionals[1] !== undefined) {
          const id = taskArg(positionals, 1, store);
          printTaskReport(taskReport(store.events(id), reviewsOf(home, id)));
          return;
        }
        const row = weekRow(store.allEvents(), values.week ?? isoWeek(new Date()));
        out(`week ${row.week} (UTC, tasks created that week; live sessions only)`);
        out(WEEK_HEADER);
        out(weekRowMarkdown(row));
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
        if (positionals[1] !== "G0") fail("usage: factoryctl gate G0 --begin [--checkout DIR]... | gate G0 [--repo OWNER/NAME]");
        const validator = createValidator();
        const release = loadRelease(validator);
        if (values.begin === true) {
          const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
          const checkouts = values.checkout ?? (top.status === 0 ? [top.stdout.trim()] : []);
          if (checkouts.length === 0) fail("not inside a git checkout: name the operator checkout(s) with --checkout DIR");
          const begin = beginG0(home, release, checkouts.map((c) => resolve(c)));
          for (const c of begin.checkouts) out(`snapshot ${c.path}: ${String(c.files)} files, ${c.digest}`);
          out(`G0 evidence window open since ${begin.started_at}${begin.release === null ? " (development checkout, not an installed release)" : ` on ${begin.release.tag}`}`);
          out("now run one task per fixture to its PR, then: factoryctl gate G0");
          return;
        }
        const evidence = await evaluateG0({
          home, store, validator, release,
          deps: { bypass: runBypassVariants, checks: restCommitChecks(process.env["FACTORY_GITHUB_TOKEN"] ?? null), doctor: doctor(home, release, keyFile(home)), repository: values.repo ?? null },
        });
        const files = writeEvidence(home, evidence);
        for (const c of evidence.criteria) out(`${c.status.padEnd(5)}  ${c.id}  ${c.detail}`);
        out(`evidence: ${files.json}`);
        out(`evidence PR body: ${files.markdown}`);
        process.exitCode = evidence.passed ? 0 : 1;
        return;
      }
      default:
        fail("usage: factoryctl task create | run | resume | status | cancel | approve | reject | report | budgets | eval | halt | unhalt | release | gate | doctor");
    }
  } finally {
    store.close();
  }
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e), 1);
});
