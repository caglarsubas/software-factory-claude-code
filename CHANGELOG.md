# Changelog

Every factory release, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. A release is a version tag that matches `plugin/.claude-plugin/plugin.json`; the [operator guide](docs/factory/operator-guide.md#releases) covers cutting and installing one. Breaking changes for the operator are marked **Breaking**.

## [Unreleased]

## [0.5.0] - 2026-10-17

### Added

- **Leases and fencing (P2-03).** Every run takes its task's lease, and every write `factoryctl` makes carries the lease's epoch. The store refuses a write from any other epoch, in the write's own transaction, so a run whose task was taken over can change nothing more. A lifecycle transition now reads its state inside that transaction. `cancel` and `reject` take the lease over, stopping the run that held it first; a lease that lapses (5 minutes without renewal) belongs to a hung run, which is stopped before the task runs again.
- **`factoryctl serve`.** A scheduler that runs tasks as worker processes, up to the concurrency limit, and never runs together two tasks whose scopes overlap on one target. Killing it leaves its workers running under their leases; the next `serve` takes over only the tasks whose holder is dead or hung.
  - **Commands:** `pause`, `resume`, `cancel` and the new `drain` go through `serve` while it runs, and `run`, `takeover` and `reject` refuse until it stops.
  - **API:** loopback only, with a token from `$FACTORY_HOME/secrets/serve.token` and Host and Origin checks.
  - **Live sessions:** it runs replayed sessions only, until the credential gateway (P2-02).

### Changed

- **`factoryctl halt`** also signals every `serve` worker.
- **`factoryctl status`** shows a task as running while its lease is held.

## [0.4.0] - 2026-10-17

### Added

- **The runner container (P2-01).** Claude Code can run each stage session inside a runner container, while the Agent SDK, the in-process guard and every credential stay in `factoryctl` on the host. Live sessions in the runner stay off until the credential gateway (P2-02); this release ships the image, its controls and their conformance suite.
  - **Image (`runner/Dockerfile`):**
    - the Agent SDK's own CLI binary at the pinned version, checked against the SDK's manifest and npm's registry signature;
    - bubblewrap, socat and git at exact versions;
    - managed settings generated from the release's policies, with the four factory hooks as managed hooks;
    - Docker's default seccomp profile plus the namespace calls the Bash sandbox needs.
  - **Container:** each session runs as the operator's uid, with no capabilities and a read-only root. Mounts sit at their host paths, and the session's token is mounted read-only. Nothing under `$FACTORY_HOME/secrets` and no engine socket is ever mounted.
  - **Network:** an internal network whose only exit is an egress proxy that allows HTTPS to the package registries. It refuses the host, private addresses, other ports and IP literals, and logs every request.
  - **Preflight broker:** the builder's Stop hook asks `factoryctl` to run the gates on the host instead of needing the container engine.
  - **Cleanup:** `halt`, reaping and abort remove runner containers and egress proxies.
  - **Tests:** `pnpm test:runner` drives the pinned CLI in the image against a stub model. CI runs it on x64 and arm64.

### Changed

- **`verify-tools` covers the runner image** and checks npm registry tarballs against npm's pinned signing key.
- **A guard config's preflight** is either a command or the broker's spools.
- **The session env** may carry `HTTPS_PROXY`, `NO_PROXY` and `ANTHROPIC_BASE_URL` in the runner. The env evidence (G0-3, G1-3) accepts them.

## [0.3.3] - 2026-10-16

### Added

- **`factoryctl gate G1`.** Checks G1-1 to G1-5 and drafts the evidence PR, as `gate G0` does:
  - G1-1: the release's kill-point suite and `ci` on the release commit;
  - G1-2: the merged R0–R1 tasks, their targets and their per-stage metrics;
  - G1-3: the checkouts snapshotted by `gate G1 --begin`, a counted task inside that window, the release, and every session's env;
  - G1-4: the `evals` check run on the release commit;
  - G1-5: the tier budgets `factoryctl budgets` recorded, against the P1-01 rule applied now.

  The operator guide's new "Gate G1" section lists the steps.

### Changed

- **A command gate's summary names its command** (`` `pnpm lint && pnpm lint:md`: exit 0 in 3.9s ``). The judges could not tell which checks a passing gate ran, and called acceptance criteria open that a gate had in fact checked.

## [0.3.2] - 2026-10-16

### Fixed

- **The factory's own tests pass in the gate image.** The first task on this repository failed its gates whatever it changed. Three causes:
  - the image had no `git`, which most of the pipeline suite needs to build fixture repositories;
  - it had no `ps`, which the process-group test calls;
  - the release test helper and `check:docs` listed files with `git ls-files`, but the gates run on an exported commit with no `.git`.

  The image now carries `git` and `procps`, pinned by Debian version and checked when the image builds. Both listings fall back to the files on disk, which in an exported commit are exactly the tracked ones. The full suite passes in the image with the network off, the root read-only and no `.git`.
- **This repository's gates run its docs checks.** The self profile's lint command adds `pnpm lint:md`, and its test command adds `pnpm check:docs`, so a docs task is judged on the checks a docs change can break.

## [0.3.1] - 2026-10-16

### Fixed

- **A builder can undo a change it did not mean to make.** The guard now allows `git restore <file>` (without a source) and `git checkout [HEAD] -- <file>` for any unprotected, non-secret file in the worktree, inside the spec's scope or not. These only throw away uncommitted changes. A tool the guard cannot see into, such as `uv run` rewriting `uv.lock`, can change a file outside the scope, and before this fix the builder could not discard it: the preflight then refused the dirty tree, and the task failed as `permission_denied`. Protected paths, the worktree root, pathspec patterns and any other source (`--source`, a branch or an older commit) are still checked as writes; eight new bypass variants pin that.
- **The approver and summarizer read the reviews.** Their prompts named "the review-*.json files" without the names, and both guessed: the approver tried a dozen names before finding them, and the summarizer looked for `review-code-reviewer.json`, never read either report, and wrote that the reviews were missing. The prompts now name `review-code.json` and `review-security.json`, and `refutations.json` only when there is one.
- **The builder keeps to its worktree.** The worktree has no installed dependencies, so a builder looking for a type checker searched the machine and ran one from another directory in your home. The build prompt now says to work only with the worktree and task directory and to leave checks it cannot run to the preflight, which runs them in a container. The prompt also tells the builder to discard a file a command changed by accident.

## [0.3.0] - 2026-10-16

Phase 1, second release: the rest of the Phase 1 pipeline. Refutation, crash-safe side effects and the merge gate, telemetry, and watch, pause and take over. Counted Phase 1 tasks run on this release, because `v0.2.0` cannot record a merged PR.

### Added

- **Refuter pass (P1-03).**
  - Every blocking finding goes to the refuter, which tries to prove it wrong against the bundle and the candidate.
  - Its answers (`refuted`, `upheld` or `unclear`) are committed as `refutations.json`, and only a refuted finding stops blocking.
  - The approver and the summarizer see the refutations.
  - `factoryctl eval capture` captures refuter sessions too, and two fixture cases join the eval suite.
- **Crash-safe side effects (P1-02).**
  - Every push and GitHub write goes through an outbox: an intent before it, an outcome after it.
  - Each effect is looked up before it is made, and dangling intents are reconciled when a run starts.
  - A run killed at any instant neither repeats a push or PR nor loses one.
- **Reaping (P1-02).** Sessions run in their own process groups and are registered while they live; a run that starts after one died stops the processes and gate containers it left behind.
- **The merge gate follows the PR.** `resume` ends a task `DONE` once its PR is merged, and `human_rejected` once it is closed unmerged.
- **Kill-point suite (G1-1).** The CLI is killed at 26 points, in every stage, around both side effects and inside a remediation round; each resumes without a re-run or a duplicate.
- **Telemetry per stage (P1-06).**
  - With `FACTORY_OTEL_ENDPOINT` set to a local collector, every session exports Claude Code's OpenTelemetry metrics and events.
  - Resource attributes name its task, stage, label, round, tier, agent and release.
  - `doctor` shows the setting.
- **Alias alarm (P1-06).** A session that runs on a model ID no pin names, or whose alias resolves to a new ID, records an `alarm`. `report` lists alarms, and `doctor` warns about them.
- **Watch, pause and take over (P1-04).**
  - `factoryctl run|resume --attach` streams each session's messages.
  - `factoryctl pause` holds a task before its next step, until `resume`.
  - `factoryctl takeover` opens your pinned Claude Code in the task's worktree, resuming its live build session, under the build session's walls in auto mode. Your result goes back through the gates and every review on `resume`.
- `report T-…` lists a session killed before it reported, charged its cap, so every run's cost adds up to what the budget counted.
- `FACTORY_GITHUB_API_URL` points `factoryctl` at GitHub Enterprise: https only, or http on loopback.

### Changed

- The run lock records the runner's start time: `halt`, `cancel` and `reject` never signal a pid the system has given to another process, and such a lock is cleared.

### Fixed

- **The judges know what you decided.** Every judge's bundle now carries `decisions.json`: your approvals at the spec gate that still hold, with their reasons. The reviewers, refuter, approver and summarizer are told these are settled. Before, a spec that asked you to choose between options read as undecided after you chose, and the approver raised your choice as a blocking finding.
- **Eval judging (#27, #28).** The `factory-evals` judge graders failed correct answers:
  - their rubrics asked for checks a judge cannot make from the reply alone, or for details a correct reply may leave out;
  - the Haiku judge, which must answer in one word, failed replies it passes when asked to explain.

  The judge is now Sonnet, and each rubric names only the conclusion that separates a pass from a block. A failing case now names its failed graders and the reply its judge saw.
- **Nightly smoke task.** It approves its own fixture spec when the spec-writer rightly stops for a human, so it can reach the merge gate (#27).

## [0.2.0] - 2026-10-13

Phase 1, first release: the factory now enforces budgets and limits, gets crash-safe artifacts and bounded remediation, files every failure under one category, and checks its judges with an eval suite. Counted Phase 1 tasks run on this release.

### Added

- **Budgets and limits (P1-01, #20).**
  - Every session gets `maxTurns` and `maxBudgetUsd`: its stage's share of the task budget, never more than what remains.
  - The task's budget is checked before every step and after every session, and the tier ratchets up as triage, spec and policy learn more.
  - Tier budgets calibrate from live runs.
  - A target's monthly cap pauses its tasks.
  - A 90-minute wall clock counts only active time and aborts a session in flight.
  - New command: `factoryctl budgets`.
- **Remediation rounds (P1-01, #20).** Red gates or a blocking finding go back to the builder with the failures. The same failure twice, or a fifth build, stops the task.
- **Commit protocol (P1-02, #19).**
  - Each step's artifacts are staged, committed by an `artifact_committed` event with their digests and the step's input digests, then moved into place.
  - A changed input re-runs every step downstream of it.
  - Spec approvals are bound to the spec they approved.
- **Failure taxonomy and run metrics (P1-07, #18).** Every failure maps to one of ten categories. New commands: `factoryctl reject` (`human_rejected`) and `factoryctl report` (per-stage metrics, and the weekly row for STATUS).
- **Component evals (P1-05, #21).**
  - 21 `claude plugin eval` cases, 4 of them held out.
  - New command: `factoryctl eval capture`.
  - The `factory-evals` workflow runs the suite on pushes to `main`, and runs the holdout and a smoke task on weekday nights.
- **Release process (P1-09).** This changelog and the `release` workflow, which checks a tag against `plugin.json`, this file and CI before it publishes the GitHub release.

### Fixed

- Judge sessions can read their rubrics. The guard used to deny every read outside the worktree and bundle, so reviews and verdicts, including those of the G0 dry runs, ran without one (#21).
- A push the remote rejects is now `merge_conflict`, not `api_error` (#18).

### Changed

- **Breaking:** tasks started on v0.1.x are refused. Finish them on v0.1.2 (`factoryctl release use v0.1.2`), or create new ones (#19).
- `policies/budgets.yaml` gains `stage_fraction`, and every profile's `budgets.monthly_usd` is now enforced (#20).

## [0.1.2] - 2026-10-13

### Fixed

- The build-stage preflight gets a ready gate image and the container engine's endpoint, instead of trying to build the image inside the session's stripped environment (#16).

## [0.1.1] - 2026-10-13

### Fixed

- Judgment stages may call the SDK's `StructuredOutput` tool, through the tool allowlist and the guard. A denied call had dropped every structured answer (#15).
- The `factoryctl` shim's default `FACTORY_HOME` (#15).
- A listener leak when exporting a tree to tar (#15).

## [0.1.0] - 2026-10-09

The Phase 0 foundation (#4–#14).

### Added

- Factory CI with a single required `ci` check, and the repository ruleset.
- Schemas v1, the policies, the config and the policy engine.
- The `software-factory` plugin: eight agents, the `status` skill, three rubrics and the four hooks, with 58 bypass variants.
- The gate runner, in a disposable container with seeded-defect suites.
- `factoryctl` v0: an append-only event store, the pipeline, the transcript-replay harness, releases, kill switch v0 and the G0 evidence.
- Two fixture targets, `ts-mini` and `py-mini`, with seeded tasks, golden patches and hidden tests.
- The operator guide and the threat model.

[Unreleased]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/caglarsubas/software-factory-claude-code/releases/tag/v0.1.0
