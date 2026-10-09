# Factory build status

Claude Code updates this file after every deliverable; the plan is [`ROADMAP.md`](ROADMAP.md), which is never edited here. This repository is public: record IDs, links and aggregates only, never private target names, task text or findings.

| Field | Value |
|---|---|
| Current phase | P0 Foundation (in progress) |
| Next gate | G0 · target Oct 23, 2026 |
| Factory release | none yet (first: `v0.1.0` at G0) |
| Claude Code / Agent SDK pin | 2.1.286 / 0.3.286 (stable on Oct 9, 2026; re-check at P0 start) |
| P0 entry criteria | GitHub App ☐ · Console workspace with spend limit ☐ · `main` created ☑ · toolchain pinned ☑ (Node 24.21.0, pnpm 12.6.0, TypeScript 6.0.3) — code work started without the first two by operator decision; both are required before G0-1 |

Status values: `todo`, `doing`, `review`, `done`, `blocked`, `deferred`. A deliverable is `done` only when its "done when" check in the roadmap passes and the evidence link proves it.

## Phase 0 · Foundation

| ID | Deliverable | Track | Status | PR | Evidence |
|---|---|---|---|---|---|
| P0-01 | Scaffold, factory CI, repository ruleset | core | done | #4 | merged 2026-10-09 with `ci` green; ruleset applies once the owner imports `.github/rulesets/main.json` |
| P0-02 | Schemas v1 | core | review | #6 | 17 schemas (strict Ajv 2020); 9 valid and 25 invalid fixtures behave as expected |
| P0-03 | Policies, config, policy engine | core | review | #6 | 26 table-driven cases plus fail-upward property tests; 4 engine mutations each caught |
| P0-04 | Plugin v0.1 | core | todo | | |
| P0-05 | Four hooks and bypass-variant suite | core | todo | | |
| P0-06 | Gate runner in a disposable container | core | todo | | |
| P0-07 | `factoryctl` v0 and replay harness | core | todo | | |
| P0-08 | Fixture targets and profiles | core | todo | | |
| P0-09 | Operator guide, threat model, G0, `v0.1.0` | core | todo | | |

### Gate G0

| ID | Criterion | Status | Evidence | Date | Signed by |
|---|---|---|---|---|---|
| G0-1 | Fixture dry runs produce the full artifact chain and a PR | todo | | | |
| G0-2 | At least 20 bypass variants all exit 2 | todo | | | |
| G0-3 | Operator checkout unchanged; session `env` equals the allowlist | todo | | | |
| G0-4 | Factory CI green; `doctor` confirms pins | todo | | | |
| G0-5 | Operator signs; globs and budgets confirmed | todo | | | |

## Phase 1 · Local MVP

| ID | Deliverable | Track | Status | PR | Evidence |
|---|---|---|---|---|---|
| P1-01 | Budgets and limits | core | todo | | |
| P1-02 | Restart invariant and outbox | core | todo | | |
| P1-03 | Refuter pass | core | todo | | |
| P1-04 | `run --attach` and `takeover` | core | todo | | |
| P1-05 | Eval capture and component evals | core | todo | | |
| P1-06 | OTel per stage and alias alarm | core | todo | | |
| P1-07 | Failure taxonomy and weekly review | core | todo | | |
| P1-08 | Pilot target onboarding | core | todo | | |
| P1-09 | Release process | core | todo | | |

### Gate G1

| ID | Criterion | Status | Evidence | Date | Signed by |
|---|---|---|---|---|---|
| G1-1 | At least 10 kill points: 0 re-runs, 0 duplicate side effects | todo | | | |
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
| 2026-10-09 | P0-01 | `claude plugin validate --strict` in CI | added with P0-04 | the validator needs a plugin manifest, which P0-04 creates |
| 2026-10-09 | P0-01 | markdownlint default rules | MD060 (table pipe alignment) disabled | cosmetic only; enabling it would require reformatting ROADMAP.md, which is never edited |
| 2026-10-09 | P0-02 | `schema_version` on every schema | `finding` has none | findings are embedded in reviews, which carry the version |
| 2026-10-09 | P0-03 | Appendix B `risk.yaml` shape | adds `baseline` (R0 only for docs-only diffs) and `manifests`; uses `minimum_risk: Restricted` instead of `tier: Restricted`; one condition per rule | every rule can only raise a tier, and its trace stays unambiguous |
| 2026-10-09 | P0-03 | budgets in `config/factory.yaml` (§2.4) | budgets only in `policies/budgets.yaml` | one source of truth; the config holds concurrency, routing, model pins and retention |
| 2026-10-09 | P0-03 | self-profile R3 paths (§3.3) | also `scripts/**` | the repository checks are guardrails too; stricter only |

### Platform re-verification (ROADMAP §11)

| Gate | Date | CLI / SDK pin | New advisories | Feature-status changes | Price changes | Action |
|---|---|---|---|---|---|---|
| plan | 2026-10-09 | 2.1.286 / 0.3.286 | none beyond §11 | — | — | baseline |
