# Service level objectives

The factory's SLOs, proposed in [ROADMAP §6](ROADMAP.md#6-metrics-slos-and-cost), defined here precisely enough to measure. The operator approves this document at G2 (G2-7), and G3-3 asks that the SLOs are met for 4 consecutive weeks, each with at least 10 tasks.

`factoryctl slo` measures them from the event store and the run directories (P2-08, [slo.ts](../../controller/src/report/slo.ts)). This document and STATUS hold aggregates only.

## What is counted

- **Tasks:** live tasks, created in the window. A task whose sessions were replayed never counts.
- **Window:** the last 4 weeks by default (`--weeks N` for another), ending now.
- **Statuses:**
  - `met`, `missed`;
  - `no_data`: nothing in the window to measure;
  - `not_measured`: the store does not hold what the SLO needs yet, with the reason given.

  An SLO is never reported from data the store does not have.

## The SLOs

| SLO | Target | Measured as | Status in P2-08 |
|---|---|---|---|
| Auto-merge-ready rate | ≥ 70% | R0–R1 attempts that ended merged with no human commit, ÷ R0–R1 attempts that ended (merged, failed or rejected; cancelled and open tasks are left out) | measured |
| Escaped defects | ≤ 3% | merged factory PRs reverted, or linked to a regression, within 14 days ÷ merged PRs | not measured: needs each merged PR's reverts and linked regressions from GitHub, which P2-06's client reads |
| Reviewer precision | ≥ 80% | blocking findings the refuter upheld ÷ blocking findings it answered (upheld, refuted or unclear) | measured |
| p90 cost per merged PR | within the tier budget | per tier, the 90th percentile (nearest rank) of merged tasks' cost against that tier's budget; failed attempts' cost is reported beside it | measured |
| Safety counters | 0 | tasks whose candidate carried secret material (the secret-scan gate's signal) | measured; denied tool calls are reported, not counted, since the guard blocked them |

### Definitions

- **R0–R1 attempt.** A task whose merge verdict was R0 or R1. Without a merge verdict, a task counts at the budget tier of its last session.
- **Human commit.** An operator `takeover` that changed the candidate. Change requests in GitHub reviews join the definition when P2-05 reads reviews.
- **Cost.** What the credential gateway metered (P2-02), or before it the sessions' own reports, as `factoryctl report` shows.
- **Tier budget.** The calibrated budget `factoryctl budgets` records (P1-01).
- **Attempt chains.** Until intake links retries of one issue (P2-04), each task is its own attempt. The G2 tooling (G2-4) measures p90 over attempt chains.

## When an SLO is missed

- **In a week's review:** a missed SLO is named in the weekly failure-taxonomy review, with the categories behind it.
- **Two weeks in a row:**
  - R2 auto-merge stays off;
  - R0–R1 auto-merge pauses for the target that missed it until the cause is fixed;
  - the fix goes through a release of its own.
- **Safety counters:** any count above 0 is investigated at once, with the kill switch if the cause is unknown.

## Telemetry

- **Collector:** every live session exports Claude Code's OpenTelemetry metrics and events to the run's own collector, which writes `$FACTORY_HOME/otel/<day>.ndjson` and keeps it for 30 days.
- **Panel:** `factoryctl slo` adds a per-task telemetry panel: exports, API requests and errors, and tool decisions.
- **G2-5:** the canary-secret audit searches these files with the transcripts, bundles and the proxy and gateway logs.
- **Redaction:** prompt and response text are never exported.

## Approval

| Gate | Date | Approved by | Notes |
|---|---|---|---|
| G2 | | | targets as proposed in ROADMAP §6 unless amended here |
