# factoryctl

The factory's control plane (ROADMAP §2). Version 0 (P0-07) runs one task at a time, attended:

```bash
pnpm factoryctl task create --profile profile.yaml --title "…" --body-file task.md [--untrusted] [--remote URL]
pnpm factoryctl run T-0001          # until the task needs a human or ends
pnpm factoryctl resume T-0001       # the same, after a stop, an approval, a halt, a crash, or a merged or closed PR
pnpm factoryctl approve T-0001 --gate spec --reason "…"
pnpm factoryctl status [T-0001]
pnpm factoryctl cancel T-0001
pnpm factoryctl reject T-0001 --reason "…"   # the operator will not take the result: human_rejected
pnpm factoryctl report [T-0001 | --week 2026-W42]
pnpm factoryctl budgets             # tier budgets as calibrated, month spend per target (G1-5)
pnpm factoryctl eval capture T-0001 # a run's judgment stages as candidate eval cases ($FACTORY_HOME/evals/captured/)
pnpm factoryctl halt [--reason "…"] # kill switch v0; lift with: unhalt --reason "…"
pnpm factoryctl release install v0.1.0 | use TAG | status
pnpm factoryctl gate G0 --begin     # then the fixture dry runs, then: gate G0
pnpm factoryctl doctor
```

In operation, factoryctl runs from an installed release through `$FACTORY_HOME/bin/factoryctl`; the [operator guide](../docs/factory/operator-guide.md) covers installation, approvals, recovery, the kill switch and gate G0.

A run goes checkout → triage → spec → rounds of build → gates → review (code and security) → policy → approve → summarize → publish, and stops at `NEEDS_HUMAN`. It stops at the spec gate when the spec or the provisional tier calls for a human. It always stops at the merge gate: in Phase 0 and Phase 1 a human merges every tier.

- **State:** `factory.db` is SQLite with append-only events, guarded by triggers and validated against `schemas/event.schema.json`. A task's state is a fold over its events, and only `factoryctl` writes `state_changed`.
- **Artifacts:** each step commits its artifacts into `runs/<id>/` through the commit protocol (`stages/commit.ts`, P1-02):
  1. The files are staged as `<name>.pending`, each written atomically.
  2. One `artifact_committed` event records their digests and the digests of the step's inputs. **The event is the commit point.**
  3. The files are moved into place.

  A step is done while its latest commit was made from the inputs it has now and its files are intact. So `resume` continues from the first step that is not done, and a changed input re-runs every step downstream of it. At the start of every run, recovery rolls a committed `.pending` forward and deletes any other. A re-run build starts from the base commit with an empty work directory.
- **Side effects (P1-02, `github/outbox.ts`):** every push and GitHub write goes through the outbox, and nothing else in the controller makes one (a conformance test checks).
  - Each effect is keyed `task/stage/round/kind[/name]`. A `side_effect_intent` event precedes it and a `side_effect_done` follows it, with the attempt number and the outcome: `done`, `found`, `absent` or `failed`.
  - An effect first looks for itself and acts only when it finds nothing. It looks for the branch at the commit, a PR from the branch at the commit, a comment carrying the key as a marker, or a check run with the key as its `external_id`.
  - At the start of every run, each intent left without an outcome is looked up and recorded `found` or `absent`.
  - At the merge gate, `resume` reads the PR: merged ends the task `MERGED`, then `DONE`; closed without a merge fails it as `human_rejected` (cause `pr_closed`).
- **Processes (P1-02, `proc.ts`):** the run lock and every session process are named by pid and start time, so a reused pid is never mistaken for them.
  - Each session runs in its own process group (the SDK's `spawnClaudeCodeProcess`) and is registered in `procs/` while it lives.
  - A run that starts after one died kills the dead run's process groups and removes its gate containers.
- **Spec approvals** are bound to the spec they were given on (`spec_digest`): a spec that runs again reopens the gate, through `BLOCKED` when the build had already started.
- **Refuter pass (P1-03):** each blocking finding of a round goes to one refuter session, which sees the bundle and the read-only candidate, like the reviewers. Its answers are committed as `refutations.json` (`refuted`, `upheld` or `unclear`). Only the findings it did not refute count as blocking: they start a remediation round, and an approval never passes them.
- **Remediation rounds (P1-01):**
  - Red gates, or a blocking finding from a reviewer, start another round. Its build gets the failures as data in its prompt and starts from the previous round's candidate.
  - Round 1 keeps the flat layout. Round `n` keeps its build, gates, reviews and remediation under `rounds/<n>/`, with labels suffixed `-r<n>`.
  - The same failure twice stops the task, and so does a round past `max_remediation_rounds` (3, so at most four builds). Failures are matched by fingerprint (`stages/fingerprint.ts`): file, category and title for a finding, gate and first error line for a gate.
  - A gate that errored, rather than failed, is not the builder's to fix: `gate_fail` at once.
- **Budgets and limits (P1-01, `budget/budget.ts`):**
  - A task's budget is its tier's, calibrated from live runs: observed max × 1.5, never below the initial value, frozen after 20 runs. The tier ratchets up: the highest tier before triage, then the higher of triage's (one up when unsure), the spec's provisional tier and the policy's.
  - Every session gets `maxTurns` and `maxBudgetUsd`: its stage's share of the budget, never more than what remains.
  - The controller checks the task budget before every step and after every session (`budget_exceeded`). A session that never reports is charged its cap.
  - It also checks the wall clock of active time (`wall_clock`, 90 minutes), counted from run start and end events and a heartbeat, so waits for a human do not count. A timer aborts a session in flight when the clock runs out.
  - It checks the target's monthly cap (`budgets.monthly_usd` in its profile): reaching it pauses the task, which resumes in a new month or under a raised cap.
- **Older tasks:** a task that a `factoryctl` without the commit protocol (v0.1.x) started is refused; finish it on that release.
- **Manifest:** `manifest.json` records:
  - every artifact's digest;
  - the base and candidate commits;
  - the release, policy, CLI and SDK versions;
  - per-stage resolved model IDs and costs, taken from the event store.
- **Failures:** every failed task carries one of the ten P1-07 categories (`task/taxonomy.ts`), and `cause` keeps what the pipeline saw when it differs. A builder that records a failure or makes no change is `gate_fail`, or `permission_denied` when the guard denied its tool calls; a rejected push is `merge_conflict`.
- **Telemetry (P1-06, `telemetry.ts`):** with `FACTORY_OTEL_ENDPOINT` set to a collector on loopback, every session exports Claude Code's OTel metrics and events.
  - Resource attributes name the task, stage, label, round, tier, agent and release.
  - Its env grows only by the eight `OTEL_ENV` names, which G0-3 and G1-3 accept.
- **The alias alarm:** after every session, an `alarm` event is recorded when it ran on a model ID that no pin in `config/factory.yaml` names, or when its alias resolves to an ID that earlier live sessions of the alias never ran on. `report` lists alarms, and `doctor` warns about them for 30 days.
- **Metrics:** `stage_completed` records each session's turns, tokens, cost, duration, runner and round. `report T-…` prints them per stage, with the review findings and any session killed before it reported (charged its cap); `report --week` prints the row for STATUS's weekly taxonomy table, counting the live tasks created that ISO week (UTC).

## Sessions

Every model session gets explicit SDK options; nothing is left to a default:

- **Permissions and settings:**
  - `permissionMode: "dontAsk"`;
  - `allowedTools` and `tools` from `policies/tools.yaml`;
  - `settingSources: []`;
  - flag settings: `apiKeyHelper` reading `$FACTORY_HOME/secrets/anthropic.key`, deny rules, `disableBypassPermissionsMode`, and workflows off.
- **Sandbox:** required, with `failIfUnavailable`.
- **Env:** an exact allowlist (`session/env.ts`): no API key, SSH agent or token ever reaches a session.
- **Isolation:** each task gets its own `CLAUDE_CONFIG_DIR`, `HOME` and `TMPDIR`.
- **Agent:** the plugin's own agent file, passed as the session's agent definition.
- **Hooks:** the plugin's hooks, plus the in-process guard (the plugin guard's policy as an SDK `PreToolUse` hook).
- **Output:** every judgment stage returns structured output (`stages/outputs.ts`). Its schema is the artifact schema minus the fields `factoryctl` owns.

Each session has its own working directory under `runs/<id>/work/`. Only the builder writes, and only `build-report.md` or `build-failure.json`. The builder never reads the raw task text, and the judges read only the bundle (`runs/<id>/bundle/`), never the builder's report.

## Git

Each target has a bare mirror (`mirrors/`), and each task its own `git clone --shared` in `worktrees/<id>`. Every git write the builder makes therefore stays inside its sandboxed working directory.

`factoryctl` alone fetches the task branch into the mirror and pushes from there, with hooks off. The token (`FACTORY_GITHUB_TOKEN`) reaches only that git process and the PR call.

## Releases, the kill switch and gate evidence

- **Releases (`release/install.ts`):** `release install TAG` exports the tagged commit's tree from the object database into `releases/<sha>/`, installs its locked runtime dependencies with scripts off, records digests in `RELEASE.json` (`schemas/release.schema.json`) and makes the directory read-only. `current` pins one release; `bin/factoryctl` runs it. A run's manifest records the release commit (`versions.factory_commit`).
- **Kill switch (`halt.ts`):** `halt` writes `$FACTORY_HOME/HALT`, signals the running task and stops gate containers. While the file exists, no run starts, the pipeline stops at its next boundary without failing the task, and the in-process guard denies every tool call.
- **Gate evidence (`gate/g0.ts`):** `gate G0 --begin` snapshots the operator checkouts; `gate G0` checks G0-1 to G0-4 against the events, run directories and release recorded since, and writes `gates/G0/evidence.json` (`schemas/gate-evidence.schema.json`) and the PR body `evidence.md`. Each session's `stage_started` event records its runner (`sdk` or `replay`) and its env's names, never values.

## Replay

`session/replay.ts` replays recorded SDK transcripts instead of calling a model. Each live session records its stream as `runs/<id>/transcripts/<stage>.ndjson`, so recorded transcripts are replayable.

Replayed tool calls go through the same rules as live ones: `allowedTools` under `dontAsk`, then the in-process guard. The file edits that pass are applied to the working directory.

- `run --replay DIR` drives a task from a transcript directory with zero tokens. Each replayed session runs a placeholder process through the session's spawner, as a live one would.
- `DIR/replay.json` holds test-only injection (`session/injection.ts`):
  - `kill_at` SIGKILLs factoryctl at a named probe point;
  - `gates` replays gate results.

  Replayed gates are refused unless the task's remote is a local path and the GitHub API, if a token is set, is on loopback (`FACTORY_GITHUB_API_URL`).
- `cli/killpoints.test.ts` (in `pnpm test`, gate G1-1) kills the real CLI at 26 points: every stage, both sides of the push and the PR, and inside a remediation round. It then resumes and checks that every step committed once, that none re-ran after finishing, and that there was one push and one PR. It also checks that no intent dangles and no staged file or session process is left.
- `stages/pipeline.test.ts` covers the pipeline (in `pnpm test`).
- `cli/factoryctl.int.test.ts` runs it end to end with the container gates (`pnpm test:gates`).
