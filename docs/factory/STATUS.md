# Factory build status

Claude Code updates this file after every deliverable; the plan is [`ROADMAP.md`](ROADMAP.md), which is never edited here. This repository is public: record IDs, links and aggregates only, never private target names, task text or findings.

| Field | Value |
|---|---|
| Current phase | P1 Local MVP: P1-07 (#18), P1-02 (#19, #25), P1-01 (#20), P1-05 (#21, #27), P1-09 (#23), P1-03 (#24), P1-06 (#26), P1-04 (#29) and P1-08 (#30) merged, with the eval judge fix (#28); `v0.3.0` cut for the counted tasks, which have started |
| Next gate | G1 |
| Factory release | `v0.2.0` (`ad5a7d4`, tagged and published 2026-10-16), installed and pinned by the operator, `doctor` clean. `v0.3.0` is cut for the counted Phase 1 tasks, to be tagged once its PR merges |
| Claude Code / Agent SDK pin | 2.1.286 / 0.3.286 (stable on Oct 9, 2026; re-checked on Oct 13, see the platform log) |
| P0 entry criteria | GitHub App ☐ (a token scoped to the fixture repositories stood in for G0-1; see deviations) · Console workspace with spend limit ☑ · `main` created ☑ · toolchain pinned ☑ (Node 24.21.0, pnpm 12.6.0, TypeScript 6.0.3) |

Status values: `todo`, `doing`, `review`, `done`, `blocked`, `deferred`. A deliverable is `done` only when its "done when" check in the roadmap passes and the evidence link proves it.

## Phase 0 · Foundation

| ID | Deliverable | Track | Status | PR | Evidence |
|---|---|---|---|---|---|
| P0-01 | Scaffold, factory CI, repository ruleset | core | done | #4 | merged 2026-10-09 with `ci` green; the owner imported `.github/rulesets/main.json` on 2026-10-16, at the P1-08 admission check; `main` reports the deletion, non-fast-forward, pull-request and `ci` status-check rules active |
| P0-02 | Schemas v1 | core | done | #6 | merged 2026-10-09 with `ci` green; 17 schemas (strict Ajv 2020); 9 valid and 25 invalid fixtures behave as expected |
| P0-03 | Policies, config, policy engine | core | done | #6 | merged 2026-10-09 with `ci` green; 26 table-driven cases plus fail-upward property tests; 4 engine mutations each caught |
| P0-04 | Plugin v0.1 | core | done | #8 | merged 2026-10-09 with `ci` green; 8 agents, 1 skill, 3 rubrics, marketplace; `claude plugin validate --strict` passes on the pinned 2.1.286 (CI step); conformance test keeps agents, `tools.yaml`, routing and `hooks.json` in agreement |
| P0-05 | Four hooks and bypass-variant suite | core | done | #8 | merged 2026-10-09 with `ci` green; 58 bypass variants exit 2, 13 ordinary actions pass, 11 protected writes denied under a broad scope; missing config, invalid config and missing script fail closed; 9 guard mutations each caught; require-gates, format-typecheck and ledger each tested through the real entrypoint |
| P0-06 | Gate runner in a disposable container | core | done | #9 | merged 2026-10-09 with `ci` green; 19 seeded-defect runs (11 TypeScript, 8 Python) each fail exactly the gates they target, including `export-ignore`, `nosemgrep` and `trufflehog:ignore` bypass attempts; both rule packs (13 rules) pass their annotated tests; 8 pinned downloads verified by cosign, SLSA or GitHub attestation in CI; require-gates now runs the preflight itself |
| P0-07 | `factoryctl` v0 and replay harness | core | done | #11 | merged 2026-10-09 with `ci` green; 9 replay tests run every stage with zero tokens in `pnpm test`: the full run to the merge gate, exact session options and an env equal to the allowlist, guard denials, the spec gate and resume, crash repair, red gates, `review_block`, `schema_invalid`, `max_turns` and cancellation; `factoryctl` end to end with container gates in the gates job; append-only events enforced by triggers |
| P0-08 | Fixture targets and profiles | core | done | #13 | merged 2026-10-09 with `ci` green; `ts-mini` and `py-mini` with 5 seeded tasks each (R0 docs, R1 feature, R3 auth change at the spec gate, R3 sink, R1 with prompt injection); `factoryctl task create` accepts all 10; each golden patch applies and lands on its tier; in containers both targets are green at base, every hidden test fails at base and passes with its golden patch, with the expected sinks; deterministic base commits for the mirrors; `profiles/self` and `profiles/template` validate |
| P0-09 | Operator guide, threat model, G0, `v0.1.0` | core | done | #14, #15, #16 | [operator guide](operator-guide.md) (install, run, approve, recover, kill switch v0, G0) and one-page [threat model](threat-model.md) mapping all 20 OWASP LLM 2025 and Agentic 2026 risks, enforced by check-docs; `factoryctl release install` puts a version tag read-only into `releases/<sha>` with tree and file digests, pins it and writes the shim (a trial install with pnpm: 7,483 files, and `doctor` run from it confirms the pins); kill switch v0 (`halt`, `unhalt`): a halt mid-session denies every further tool call and ends the run without failing the task, which resumes after `unhalt`; `factoryctl gate G0` checks G0-1 to G0-4 and drafts the evidence PR, each criterion tested to pass on complete fixture runs and fail on what it guards. the G0 evidence PR (#17) is open, with G0-1 to G0-4 passing on `v0.1.2` |

### Gate G0

| ID | Criterion | Status | Evidence | Date | Signed by |
|---|---|---|---|---|---|
| G0-1 | Fixture dry runs produce the full artifact chain and a PR | done | [both fixtures](gates/G0.md) went task → spec → gates → reviews → verdict → PR on `v0.1.2` with valid manifests; 14 live sessions, $1.69 in total | 2026-10-13 | |
| G0-2 | At least 20 bypass variants all exit 2 | done | 58 of 58 variants exit 2 through the released guard hook | 2026-10-13 | |
| G0-3 | Operator checkout unchanged; session `env` equals the allowlist | done | the operator checkout (12,814 files) and the release (7,487 files) byte-identical; 14 sessions, each env exactly the 17-name allowlist | 2026-10-13 | |
| G0-4 | Factory CI green; `doctor` confirms pins | done | `ci` green on `95d3abc`; `doctor`: Node 24.21.0, Claude Code 2.1.286, Agent SDK 0.3.286 | 2026-10-13 | |
| G0-5 | Operator signs; globs and budgets confirmed | done | the operator merged #17, confirming the protected globs and tier budgets in [the evidence](gates/G0.md) | 2026-10-13 | caglarsubas |

## Phase 1 · Local MVP

| ID | Deliverable | Track | Status | PR | Evidence |
|---|---|---|---|---|---|
| P1-01 | Budgets and limits | core | done | #20 | an over-budget replay fixture ends `FAILED budget_exceeded` after its build, before the gates, with no review session and no branch, in the pipeline suite and through the CLI. Every session gets `maxTurns` and `maxBudgetUsd` (its stage's share, never more than remains); the task budget is checked before every step and after every session; tier budgets calibrate from live runs (`factoryctl budgets` records them); a target's monthly cap pauses its tasks; the 90-minute wall clock counts only active time and aborts a session in flight. Remediation rounds: red gates or a blocking finding go back to the builder; the same failure twice, or a fifth build, stops the task; a gate error fails without a round |
| P1-02 | Restart invariant and outbox | core | done | #19, #25 (merged) | the kill-point suite passes in CI (`pnpm test`): the real CLI is SIGKILLed at 26 points (every stage, before and after both the push and the PR, and inside a remediation round) and resumed. Each resume commits every step once, re-runs no finished step, pushes once, opens one PR, and leaves no dangling intent, staged file or session process. A lock whose pid was reused is neither signalled nor kept. Removing the PR lookup or the reaping fails the suite. Part 2, the outbox: every push and GitHub write is keyed (D6), recorded as an intent and an outcome, and found before it is made; dangling intents are reconciled at run start, and a conformance test forbids effects outside the outbox. Sessions run in registered process groups that the next run reaps, with the dead run's gate containers. At the merge gate, a merged PR ends the task `DONE` and a closed one `human_rejected`. Part 1, the commit protocol: every step's artifacts are staged as `.pending`, committed by an `artifact_committed` event carrying their digests and the step's input digests, then moved into place. A step is done only while its commit matches its current inputs and its files are intact; recovery rolls committed `.pending` files forward and removes the rest. Tested in replay: a lost transition after a commit is repaired, a changed file re-runs its step, a changed input re-runs every step downstream, and a changed spec reopens the spec gate (through `BLOCKED` once the build started). Tasks begun on v0.1.x are refused |
| P1-03 | Refuter pass | core | done | #24 (merged) | in replay, a seeded false positive is refuted and blocks nothing (no remediation round; the approver and summarizer see `refutations.json`), while a seeded true bug is upheld and goes back to the builder, and an unclear answer blocks too; no refuter runs when nothing blocks. Two fixture eval cases (refute a parameterised query, uphold an off-by-one) pass 2 of 2 on the pinned CLI |
| P1-04 | `run --attach` and `takeover` | core | done | #29 (merged) | Tested in replay and through the CLI: a takeover's commits re-enter through the gates. The operator's edit becomes the round's candidate, and `resume` re-runs only the gates, both reviews, the approval and the summary on it. The build stays done, and the same PR gets the new head. A takeover with no change leaves the task as it was, and one before any build is refused. Through the real CLI, with a stand-in for Claude Code, `takeover` checks the pinned version, refuses inside Claude Code, and launches a new session in auto mode under the release's settings, plugin and sandbox, with no token or key in its env. The pinned CLI accepts those flags live. `pause` holds a task at the next step boundary, after the step in flight commits, until `resume`; `run --attach` streams every session's messages |
| P1-05 | Eval capture and component evals | core | done | #21, #27, #28 (merged) | 21 `claude plugin eval` cases (17 visible, 4 held out), a pass and a block case for each of the seven judgment agents, from the fixtures and this repository; on the pinned CLI the visible suite passes 17 of 17 at threshold 0.8 for $1.51 and the holdout 4 of 4. The first runs found that no judge could read its rubric: the guard allowed only the worktree and bundle, so every review and verdict, the G0 runs included, ran without one; fixed and tested here. `pnpm check:evals` enforces the suite's rules; `factoryctl eval capture` writes candidate cases outside the repository; the `factory-evals` workflow runs the suite on pushes to `main` and nightly. Done: the suite passed in CI on the push of #27's merge to `main` (`factory-evals` run 8). Getting there took two grader fixes, neither of them to an agent. First, the rubrics had asked the judge to fail a reply that "adds a conclusion of its own", which it cannot check from the reply alone (#27). Second, the Haiku judge, which must answer in one word, failed correct replies it passes when asked to explain, and four criteria demanded details a correct reply may leave out, such as a file path, an exploit or a fix. The judge is now Sonnet, and those criteria name only the conclusion (#28). Re-judging the same replies directly, Sonnet passed the correct ones 10 of 10 and failed wrong ones 10 of 10. The visible suite then passed 19 of 19 ($1.59) and the holdout 4 of 4 ($0.37); judging costs about $0.04 a run. The smoke task reached the merge gate live on 2026-10-16 (run 9, $0.59) |
| P1-06 | OTel per stage and alias alarm | core | done | #26 (merged) | per-stage cost, tokens and minutes in `factoryctl report` for every run, from the event store with or without OTel, now including a session killed before it reported (charged its cap, as the budget counts it). With `FACTORY_OTEL_ENDPOINT` set, every session exports Claude Code's OTel metrics and events, tagged with task, stage, label, round, tier, agent and release. A live session on the pinned SDK exported to a loopback collector, with prompt and response text redacted. The alias alarm records an `alarm` event for a session on an unpinned model ID, or an alias that resolves to a new ID; `report` lists alarms and `doctor` warns about them. Tested in replay and through the CLI |
| P1-07 | Failure taxonomy and weekly review | core | review | #18 (merged) | every failure path maps to one of the ten categories, each tested in replay (the builder's failure, no change, denied edits, budget, a session error, a runner crash, a rejected push); `factoryctl reject` records `human_rejected`; `stage_completed` records duration, runner and round; `factoryctl report` prints per-stage metrics and the weekly row; done when the first weekly row lands below |
| P1-08 | Pilot target onboarding | core | done | #30 (merged) | the operator chose this repository as the pilot target on 2026-10-16. Admission on `main`: `factory-ci` green on the #29 merge commit (test command `pnpm test`), CI present (`ci` is the single required check), and the default branch protected by the imported ruleset. The check first found `main` unprotected, since the P0-01 ruleset had never been imported; the operator imported it before this PR. Its profile is `profiles/self` (public, as the repository is), on `v0.2.0`; it needs no footprint PR, since the repository already carries the factory. The operator approved the profile by merging #30 on 2026-10-16 |
| P1-09 | Release process | core | done | #23 (merged) | `CHANGELOG.md` (Keep a Changelog, v0.1.0 to v0.2.0); `pnpm check:release` keeps `plugin.json`'s version, the newest dated section and its link reference in agreement; the `release` workflow publishes a GitHub release only for a tag that matches them, after `ci` passed on the tagged commit; the operator guide's release, install and rollback steps. `v0.2.0` was tagged on the #23 merge commit and the `release` workflow published it on 2026-10-16 after `ci` passed there |

### Gate G1

| ID | Criterion | Status | Evidence | Date | Signed by |
|---|---|---|---|---|---|
| G1-1 | At least 10 kill points: 0 re-runs, 0 duplicate side effects | done | 26 kill points in `cli/killpoints.test.ts`, each with 0 re-runs and 0 duplicate pushes or PRs, green in CI since #25; `factoryctl gate G1` confirms it | 2026-10-13 | |
| G1-2 | At least 5 R0–R1 merges across 2 or more targets, with metrics | todo | | | |
| G1-3 | Zero checkout writes; `env` allowlist holds | todo | | | |
| G1-4 | Component eval suite passes at its threshold | todo | | | |
| G1-5 | Tier budgets set and recorded | todo | | | |
| G1-6 | Operator signs; R0–R1 auto-merge enabled for P2 | todo | | | |

## Phase 2 · Team-grade

| ID | Deliverable | Track | Status | PR | Evidence |
|---|---|---|---|---|---|
| P2-01 | Runner container | core | todo | | |
| P2-02 | Credential and budget gateway | core | todo | | |
| P2-03 | Scheduler, leases, `factoryctl serve` | core | todo | | |
| P2-04 | GitHub intake and status mirror | core | todo | | |
| P2-05 | Governance wiring and forgery test | core | todo | | |
| P2-06 | Merge-time re-verification | core | todo | | |
| P2-07 | Durability and kill switch | core | todo | | |
| P2-08 | OTel export, panels, SLO definitions | core | todo | | |
| P2-09 | Reviewer graph and ux-evaluator | parallel | todo | | |
| P2-10 | Dashboard v1 | parallel | todo | | |
| P2-11 | `onboard` and `offboard` | parallel | todo | | |
| P2-12 | Advisory second opinion | parallel | todo | | |
| P2-13 | Code graph in shadow mode | parallel | todo | | |
| P2-14 | Optional plugin workflow | parallel | todo | | |

### Gate G2

| ID | Criterion | Status | Evidence | Date | Signed by |
|---|---|---|---|---|---|
| G2-1 | At least 11 of 15 consecutive R0–R1 attempts merge without human edits | todo | | | |
| G2-2 | Seeded attacks stop; 0 pushes outside `factory/**`; 0 "ultracode" workflow runs | todo | | | |
| G2-3 | Three concurrent tasks survive a `serve` kill | todo | | | |
| G2-4 | p90 cost per merged PR within tier budget | todo | | | |
| G2-5 | Canary-secret audit: 0 hits | todo | | | |
| G2-6 | Drift, restore and kill-switch drills pass | todo | | | |
| G2-7 | Operator signs; SLOs approved; R2 auto-merge stays off | todo | | | |

## Phase 3 · Delivery and optimisation

| ID | Deliverable | Track | Status | PR | Evidence |
|---|---|---|---|---|---|
| P3-01 | Eval-replay gate | core | todo | | |
| P3-02 | Ingestion relays | core | todo | | |
| P3-03 | Deploy adapter | core | todo | | |
| P3-04 | Model router | core | todo | | |
| P3-05 | Code graph, stage 2 | core | todo | | |
| P3-06 | Provenance and attestations | core | todo | | |
| P3-07 | Remote runner evaluation | core | todo | | |
| P3-08 | Second target | core | todo | | |
| P3-09 | R2 autonomy calibration | core | todo | | |

### Gate G3

| ID | Criterion | Status | Evidence | Date | Signed by |
|---|---|---|---|---|---|
| G3-1 | Audited chain verifies; a tampered bundle fails verification | todo | | | |
| G3-2 | Replay gate blocks a seeded regression; A/A run passes | todo | | | |
| G3-3 | SLOs met for 4 consecutive weeks of at least 10 tasks | todo | | | |
| G3-4 | Second target: at least 3 merges, 0 factory-core commits | todo | | | |
| G3-5 | Operator signs; steady-state cadence set | todo | | | |

## Logs

### Weekly failure-taxonomy review (aggregates only)

| Week | Tasks | Merged | gate_fail | review_block | budget_exceeded | max_turns | schema_invalid | permission_denied | api_error | merge_conflict | wall_clock | human_rejected | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Fallbacks and deviations

| Date | Deliverable | Planned | Used instead | Reason |
|---|---|---|---|---|
| 2026-10-09 | P0 entry criteria | GitHub App and Console spend limit before any P0 work | P0-01…P0-08 built first; both required before G0-1 | operator decision: no P0 deliverable before G0-1 needs credentials |
| 2026-10-09 | P0-01 | latest TypeScript (7.0) | TypeScript 6.0.3 | typescript-eslint 8.x supports TypeScript < 6.1; type-aware lint rules outweigh the faster compiler |
| 2026-10-09 | P0-01 | LICENSE file | not added | licence choice is the owner's decision (tied to the §10 question on offering the factory to others); until then all rights are reserved |
| 2026-10-09 | P0-01 | ruleset with CODEOWNERS review applied by the factory | ruleset JSON committed for owner import; code-owner review off | rulesets are settings a PR cannot apply; PRs are authored under the owner's account, so required code-owner review would deadlock until the factory App authors PRs |
| 2026-10-09 | P0-01 | `claude plugin validate --strict` in CI | added with P0-04 (#8) | the validator needs a plugin manifest, which P0-04 creates |
| 2026-10-09 | P0-01 | markdownlint default rules | MD060 (table pipe alignment) disabled | cosmetic only; enabling it would require reformatting ROADMAP.md, which is never edited |
| 2026-10-09 | P0-02 | `schema_version` on every schema | `finding` has none | findings are embedded in reviews, which carry the version |
| 2026-10-09 | P0-03 | Appendix B `risk.yaml` shape | adds `baseline` (R0 only for docs-only diffs) and `manifests`; uses `minimum_risk: Restricted` instead of `tier: Restricted`; one condition per rule | every rule can only raise a tier, and its trace stays unambiguous |
| 2026-10-09 | P0-03 | budgets in `config/factory.yaml` (§2.4) | budgets only in `policies/budgets.yaml` | one source of truth; the config holds concurrency, routing, model pins and retention |
| 2026-10-09 | P0-03 | self-profile R3 paths (§3.3) | also `scripts/**` | the repository checks are guardrails too; stricter only |
| 2026-10-09 | P0-04 | every §2.2 agent in plugin v0.1 | the eight P0–P1 agents: triager, spec-writer, builder, code-reviewer, security-reviewer, refuter, approver, summarizer | the dependency and migration reviewers and the ux-evaluator arrive with P2-09, second-opinion with P2-12, the localiser with P2-13; the gate-runner is a script (P0-06) |
| 2026-10-09 | P0-04 | markdownlint default rules | MD041 (first line a heading) off under `plugin/` | agent and skill prompts start with frontmatter |
| 2026-10-09 | P0-05 | hooks in exec form | shell form: `node … \|\| exit 2` (the ledger uses `\|\| true`) | exec form passes through every exit code, so a missing runtime or a crash (exit 1) would fail open; the wrapper turns any failure into exit 2, and CI checks every hook carries it |
| 2026-10-09 | P0-06 | every gate container with `--network none` | gates, scans and tests run with no network; setup and the vulnerability-database refresh run in separate fetch containers | dependencies must come from the lockfile, not the builder's checkout; setup runs with lifecycle scripts and source builds off, the refresh sees no target content, and P2-01's egress proxy narrows both to package registries |
| 2026-10-09 | P0-06 | worktree-only mount | no host mount: the committed tree is streamed into a per-run volume from the object database | stricter; `git archive` would honour the change's own `export-ignore` and hide files from every gate |
| 2026-10-09 | P0-07 | a `git worktree` per task in `worktrees/<id>` | a `git clone --shared` of the mirror in `worktrees/<id>` | every git write the builder makes stays inside its sandboxed working directory; `factoryctl` alone fetches the branch into the mirror and pushes from there |
| 2026-10-09 | P0-07 | GitHub App for pushes and PRs | `FACTORY_GITHUB_TOKEN`, an operator token, reaches only the push and the PR call; no `factory/verdict` check run yet | the App is an owner action due before G0-1, and its tokens replace this one then; the verdict check run lands with the governance wiring (P2-05) |
| 2026-10-09 | P0-07 | `format-typecheck` runs format and typecheck commands after each edit | `factoryctl` configures no post-edit commands; the Stop preflight runs the gates in containers | the hook runs outside the Bash sandbox, and formatters and linters load config the builder can edit |
| 2026-10-09 | P0-08 | fixture targets mirrored to throwaway GitHub repositories | `scripts/mirror-fixture.ts` pushes each fixture's deterministic base; the two repositories are not created yet | creating repositories in the operator's account is an owner action, like the App, due before G0-1 |
| 2026-10-09 | P0-09 | `factoryctl gate G<n>` drafts and opens the evidence PR | it writes the PR body (`evidence.md`) and the STATUS rows; the operator opens the `gates/G0` PR | opening a PR on the factory repository needs a token `factoryctl` must never hold for its own repository; the operator's approval of that PR is the signature |
| 2026-10-13 | G0 | gate run on `v0.1.0` | on `v0.1.2` | the first live runs found three bugs, each fixed with a test that reproduces the live failure: judgment stages could not call the SDK's `StructuredOutput` tool past the tool allowlist and guard (#15); the `factoryctl` shim's default `FACTORY_HOME` (#15); the build preflight built the gate image inside the session's stripped environment (#16) |
| 2026-10-13 | G0-1 | the GitHub App for the dry runs | a fine-grained token scoped to the two fixture repositories (contents and pull requests) | the App is still an owner action; the token reached only `factoryctl`'s push and PR calls, never a session; the App replaces it before Phase 1 runs on other targets |
| 2026-10-13 | G0-5 | the operator approves the evidence PR | the operator merged #17 | GitHub does not let a PR's author approve it; the PRs are authored under the operator's account until the factory App authors them |
| 2026-10-13 | P1-07 | categories mapped from SDK result subtypes and guard events | also from the pipeline's own checks: a builder that records a failure or makes no change is `gate_fail`, or `permission_denied` when the guard denied its tool calls; a rejected push is `merge_conflict`; the pipeline's raw cause stays in the event as `cause` | the builder's own outcomes have no SDK subtype; `factoryctl report` maps v0.1.x events the same way |
| 2026-10-13 | P1-01 | a tier's budget is observed max × 1.5 until it has 20 runs | D1: `max(initial, observed max × 1.5)` over live runs that reached the merge gate, frozen at the value the first 20 set | one cheap first run must not strand a tier below its initial budget; failed and replayed runs say nothing about what a successful run costs |
| 2026-10-13 | P1-01 | a soft per-stage `maxBudgetUsd` | D2: `min(stage share × task budget, what remains)`, the shares in `policies/budgets.yaml`; a session that trips it fails the task as `budget_exceeded` | the roadmap names the cap, not its size; the controller's own check after every session is the hard cap |
| 2026-10-13 | P1-01 | a monthly cap per target | D3: the profile's `budgets.monthly_usd`; reaching it pauses the task (it keeps its state) instead of failing it | a cap reached by other tasks is not this task's failure |
| 2026-10-13 | P1-01 | the hard per-task cap | D4: a session that started and never reported is charged its cap | a killed process reports no cost; the cap keeps the task's spend an upper bound until the P2-02 gateway meters it exactly |
| 2026-10-13 | P1-01 | remediation for every failure | D5: a gate whose status is `error` fails the task as `gate_fail` without a round; "at most 3 rounds" read as three remediation rounds, so at most four builds | an infrastructure error is not the builder's to fix |
| 2026-10-13 | P1-01 | run start and end events | `command` events `run_started` and `run_ended`, with a heartbeat file that reconstructs a killed run's end | no event type was needed; the wall clock reads them |
| 2026-10-13 | P1-03 | one refuter session per blocking finding, with the bundle only | with the bundle and the read-only candidate checkout, as the reviewers have | the refuter's instructions are to trace the failure through the actual code, which the diff alone does not show |
| 2026-10-13 | P1-05 | held-out cases selected by tag, two runs per case, the full suite nightly | held-out cases in their own directory (`plugin/evals-holdout/`), since `--tag` only includes; one run per case; nightly on weekdays: holdout and smoke, plus the visible suite on Mondays; the visible suite also on every push to `main` that changes the plugin, policies or config | the operator's CI budget of about $50 a month: a visible run costs about $1.50, the holdout $0.40, a smoke task up to $1.50 |
| 2026-10-13 | P1-05 | evals that call an agent directly | each case asks the eval session to dispatch the plugin's agent (`allowed_tools: [Agent]`), with `--allow-tools Read` so the agent can read its rubric; a `tool_used` grader proves the dispatch, a regex grades the relayed answer, and a Sonnet judge grades the block cases (Haiku until #28) | the eval runner has no key to select a plugin agent; its documented route is the Agent tool |
| 2026-10-13 | P1-02 | one deliverable | two PRs: the commit protocol (#19), then the outbox, reconcile, reaping and the kill-point suite | budgets and remediation rounds (P1-01) build on the commit protocol, and the kill-point suite needs the rounds to cover them |
| 2026-10-13 | P1-02 | outbox keys by task, stage and attempt | D6: `task/stage/round/kind[/name]`, with a per-key `attempt` on each intent and outcome | one step can hold several effects (the push and the PR), and a round re-runs its steps |
| 2026-10-13 | P1-02 | a PR reconciled by its head branch | by its head branch and head commit, in any state | a task id reused in another `FACTORY_HOME` must not adopt an older PR from the same branch name |
| 2026-10-13 | P1-02 | intents for every push, PR, comment and check run | the outbox supports all four, and the pipeline makes the push and the PR | P1 posts no comment or check run; check runs need the factory GitHub App, since a fine-grained token cannot create them |
| 2026-10-13 | P1-02 | kill points in every stage | SIGKILL at probe points named in `--replay`'s `replay.json`, with replayed gates allowed only for a local remote and a loopback API | the suite runs the real CLI with zero tokens and no containers, so it runs in `pnpm test` on every PR |
| 2026-10-13 | P1-02 | a merged PR moves the task on | `MERGED`, then `DONE` at once | Phase 1 has no deploy stage |
| 2026-10-13 | P1-06 | OTel to the operator's collector | only to a collector on loopback, with no exporter headers; resource attributes named `factory.task_id`, `factory.stage`, `factory.label`, `factory.round`, `factory.tier`, `factory.agent_id` and `factory.release` | a session must hold no credential, and profiles allow Anthropic egress only: the local collector forwards under its own credentials |
| 2026-10-13 | P1-06 | an alarm when an alias resolves to a new ID | also when a session runs on an ID no pin names; an `alarm` event that does not stop the task, judged against earlier live sessions only | sessions pass the pinned ID, so a new ID means a changed pin or a model the CLI chose; replayed transcripts are not evidence of what an alias resolves to |
| 2026-10-16 | P1-04 | `pause` as a NEEDS_HUMAN gate | a `command` event the pipeline checks before each step; the task keeps its state, and `status` shows `(paused)` | a gate is a lifecycle state, and most running states have no transition to NEEDS_HUMAN; a pause is the operator's hold, not the task's progress |
| 2026-10-16 | P1-04 | `takeover` resumes the stage session | it resumes the last live build session, or starts a new one; the operator's session is not metered against the task budget | the build is the only stage whose session changes code; an interactive session reports no cost to factoryctl |
| 2026-10-16 | P1-05 | the nightly smoke run drives a fixture task to the merge gate | the smoke approves its own spec gate once when the spec-writer asks for a human, then resumes | ts-mini's R0 docs task documents limits that a seeded bug contradicts, and a spec-writer that stops there is right; the smoke tests the pipeline, not the operator's judgment, and its task is never counted |
| 2026-10-16 | P1-08 | a pilot target the operator chooses, apart from this repository and the fixtures, onboarded through a profile in the private store and a footprint PR | operator decision: this repository is the pilot; its public profile `profiles/self` and existing footprint stand in, and admission was checked on it | the operator's choice; G1-2's two targets are met by this repository and the fixtures. Until P2-11, onboarding a repository the factory was not built around is untested, and this repository takes R0–R1 docs tasks only (its code paths are R3), so counted code tasks run on the fixtures |
| 2026-10-16 | P1-09 | counted Phase 1 tasks run on `v0.2.0` | on `v0.3.0` | `v0.2.0` was tagged before the merge gate followed the PR (#25), so its `resume` cannot record a merged PR, and it lacks the refuter (#24); a task begun on `v0.2.0` resumes on `v0.3.0` |
| 2026-10-13 | G0 | the evidence PR from a `gates/G0` branch | from this session's branch, with the evidence in [`gates/G0.md`](gates/G0.md) | the session can push only its own branch |

### Platform re-verification (ROADMAP §11)

| Gate | Date | CLI / SDK pin | New advisories | Feature-status changes | Price changes | Action |
|---|---|---|---|---|---|---|
| plan | 2026-10-09 | 2.1.286 / 0.3.286 | none beyond §11 | — | — | baseline |
| G0 | 2026-10-13 | 2.1.286 / 0.3.286 | not re-checked | not re-checked | not re-checked | pins confirmed by `doctor`; the advisory, feature and price re-check is due before Phase 1 starts |
| P1 start | 2026-10-13 | 2.1.286 / 0.3.286 (npm `stable` is now 2.1.287, `latest` 2.1.296 and SDK 0.3.296) | [GHSA-pq7j-f95f-qfcv](https://github.com/anthropics/claude-code/security/advisories/GHSA-pq7j-f95f-qfcv) (plugin SHA pin bypass, fixed in 2.1.179), [GHSA-5j29-h97v-84ch](https://github.com/anthropics/claude-code/security/advisories/GHSA-5j29-h97v-84ch) (fixed in 2.1.129) and [GHSA-gfvf-j8jh-jxxw](https://github.com/anthropics/claude-code/security/advisories/GHSA-gfvf-j8jh-jxxw) (fixed in 2.1.260): none affects the pin; no SDK advisory; the [2.1.292 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) fixes a permission bypass for Windows UNC paths, without an advisory | [dynamic workflows](https://code.claude.com/docs/en/workflows.md) are now GA; the other §11 statuses are unchanged | [none](https://platform.claude.com/docs/en/about-claude/pricing); from 2.1.296 the CLI prices Sonnet 5.5 cache reads at $0.10 per million (was $0.20), so the pin's `maxBudgetUsd` estimate overcounts them | pins kept: no advisory affects them, native Windows is unsupported, sessions keep `disableWorkflows`, and an overcounting budget estimate errs safe |
