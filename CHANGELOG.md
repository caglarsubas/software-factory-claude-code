# Changelog

Every factory release, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. A release is a version tag that matches `plugin/.claude-plugin/plugin.json`; the [operator guide](docs/factory/operator-guide.md#releases) covers cutting and installing one. Breaking changes for the operator are marked **Breaking**.

## [Unreleased]

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
- `FACTORY_GITHUB_API_URL` points `factoryctl` at GitHub Enterprise: https only, or http on loopback.

### Changed

- The run lock records the runner's start time: `halt`, `cancel` and `reject` never signal a pid the system has given to another process, and such a lock is cleared.

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

[Unreleased]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/caglarsubas/software-factory-claude-code/releases/tag/v0.1.0
