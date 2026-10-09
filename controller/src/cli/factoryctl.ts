#!/usr/bin/env node
// factoryctl v0 (ROADMAP P0-07): task create, run, resume, status, cancel, approve, doctor.
//
//   factoryctl task create --profile FILE --title TEXT --body-file FILE [--untrusted] [--remote URL]
//   factoryctl run T-0001 [--replay DIR]     drive a task until it needs a human or ends
//   factoryctl resume T-0001 [--replay DIR]  the same, after a stop or a crash
//   factoryctl status [T-0001]
//   factoryctl cancel T-0001
//   factoryctl approve T-0001 --gate spec --reason TEXT
//   factoryctl doctor
//
// FACTORY_HOME holds run state (default ~/.factory); FACTORY_RELEASE selects the installed
// release; FACTORY_GITHUB_TOKEN pushes and opens PRs. --replay replays recorded transcripts
// instead of calling a model: zero tokens.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runGates } from "../../../gates/src/run.ts";
import { ensureImage } from "../../../gates/src/image.ts";
import { doctor } from "../doctor.ts";
import { restGitHub } from "../github/client.ts";
import { acquireRunLock, ensureHome, factoryHome, readLock, type Home } from "../home.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { replayRunner } from "../session/replay.ts";
import { sdkRunner } from "../session/runner.ts";
import { runTask } from "../stages/pipeline.ts";
import { EventStore } from "../store/events.ts";
import { currentState, currentStatePayload, isTerminal, transition } from "../task/lifecycle.ts";
import { createTask, readTask } from "../task/task.ts";

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

function keyFile(home: Home): string {
  return process.env["FACTORY_API_KEY_FILE"] ?? join(home.secrets, "anthropic.key");
}

async function drive(home: Home, store: EventStore, taskId: string, replay: string | undefined): Promise<void> {
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
        github: token === undefined ? null : restGitHub(token),
        auth: token === undefined ? null : { token },
        keyFile: keyFile(home),
        ...(process.env["FACTORY_GATES_FETCH_NETWORK"] === undefined ? {} : { gatesFetchNetwork: process.env["FACTORY_GATES_FETCH_NETWORK"] }),
        ...(process.env["FACTORY_GATES_CA_FILE"] === undefined ? {} : { gatesCaFile: process.env["FACTORY_GATES_CA_FILE"] }),
        log: (line) => process.stderr.write(`factoryctl: ${line}\n`),
      },
    });
    const payload = currentStatePayload(store.events(taskId));
    out(`${taskId} ${state}${typeof payload["gate"] === "string" ? ` (gate: ${payload["gate"]})` : ""}${typeof payload["pr_url"] === "string" ? ` ${payload["pr_url"]}` : ""}`);
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
    },
  });
  const home = factoryHome();
  const command = positionals[0];

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
        if (process.env["CLAUDECODE"] !== undefined) fail("approve refuses to run inside a Claude Code session");
        const id = taskArg(positionals, 1, store);
        if (values.gate !== "spec") fail("only --gate spec is approved here; a merge is approved by your GitHub review on the PR");
        if (values.reason === undefined || values.reason.trim() === "") fail("--reason is required");
        const events = store.events(id);
        if (currentState(events) !== "NEEDS_HUMAN" || currentStatePayload(events)["gate"] !== "spec") fail(`${id} is not waiting at the spec gate`);
        store.append({ task_id: id, actor: { kind: "operator", id: process.env["USER"] ?? "operator" }, type: "command", payload: { command: "approve", gate: "spec", reason: values.reason } });
        out(`${id} spec approved; continue with: factoryctl resume ${id}`);
        return;
      }
      default:
        fail("usage: factoryctl task create | run | resume | status | cancel | approve | doctor");
    }
  } finally {
    store.close();
  }
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e), 1);
});
