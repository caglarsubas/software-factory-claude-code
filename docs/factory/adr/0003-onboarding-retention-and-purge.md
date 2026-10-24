# ADR 0003: Onboarding, retention and purging by record

| Field | Value |
|---|---|
| Status | Proposed in the first P2-11 PR; accepted when the operator merges it |
| Date | 2026-10-22 |
| Changes | ROADMAP principle 8 (§3.1), the "Private store" question of §10, P1-08's admission criteria, and how §2.7's footprint PR is opened |
| Decided by | the operator (2026-10-22): the purge and the App; the operator's approval of the P2-11 plan: the rest |

## Context

ROADMAP P2-11 adds `factoryctl onboard` and `offboard`. Onboarding goes inventory → profile → STOP → footprint PR. Offboarding "purges data and removes the ruleset and App". Each target keeps its data for its own `retention_days`.

Principle 8 says otherwise: "nothing shared is mutable", events are append-only, and bundles are content-addressed. The factory enforces it:

- **Events:** triggers abort any update or delete of an event.
- **Objects:** the object store is write-once (P2-07).
- **The replica:** it only ever copies what it lacks, and a restore brings everything back ([ADR 0001](0001-replication-without-litestream.md)).

So a purge, and a retention that deletes anything, needs an exception to principle 8. Without one, whatever offboarding deleted would come back with the next restore.

§10 left the private store open ("a private GitHub repository, or `$FACTORY_HOME` only"), and nothing decided it by its date. Its default was "a private repository mirrored to `$FACTORY_HOME`". A git repository keeps every profile in its history, and that is at odds with purging a target.

P1-08 admitted a target on three criteria: a green test command, CI present, and a protected default branch. The P1-08 record found that "green in CI" was not enough: the gates run the commands in the gate image.

The factory App has no Workflows or Administration permission (§3.2). It therefore can push neither the footprint's workflow files nor change rulesets.

## Decision

1. **Deleting by record.** A purge is the single exception to principle 8. It deletes a set of tasks: their events, every object only they referenced, their run, worktree and session directories, their eval captures and their OTel lines. It does so in the home and in the replica.
   - **The record comes first.** A `tombstones` table (store schema 4) records each purged task's id, the date and what it held (counts of events, files and objects), never what it said. The tombstone and the deletion of the task's events are one transaction.
   - **The triggers enforce it.**
     - An event can be deleted only once its task has a tombstone.
     - An event can never be added to a tombstoned task.
     - Tombstones are themselves append-only.
     - A purged id is never reused.
   - **Each store decides for itself.** The replica completes a purge from its own record and its own objects. It never deletes anything because the home lacks it, so a home that lost files to a disk fault cannot take its backup down too. A restore completes a purge the replica had recorded and not finished, and the restore drill fails if anything purged comes back.
   - **Nothing survives on disk.** Deleted rows are overwritten (`secure_delete`), and after a purge the database is compacted and its write-ahead log emptied.
   - **A purge is resumable.** It is planned in full into a journal under `$FACTORY_HOME/purges/`, then run step by step, so a crash resumes where it stopped. It runs only while the factory is idle and only by the operator.
2. **The private store** is `$FACTORY_HOME/targets/<owner>__<name>/`, which the replica copies. It holds the profile, the onboarding record and its journal. This settles §10. Offboarding removes the directory with the rest of the target's data.
3. **Retention is shortest-wins.** A task's retention is the shorter of its profile's and the config's `retention_days`, so a profile can shorten retention and never lengthen it.
   - **Scope:** only finished tasks expire, counted from their last event.
   - **What expires:**
     - Transcripts expire into their own deletion.
     - An expired bundle loses its run directory except `task.json`, plus its worktree, session, captures and the objects only it referenced. Its events stay, so the task's history, metrics, calibration and `status` keep working.
   - **The record:** an operator command event, so the replica and a restore apply the same expiry.
   - **When:** `factoryctl prune` runs it, by hand. The operator guide says not to prune before G2 is signed: the fixtures keep their bundles 30 days, and those hold G0 and G1 evidence.
4. **Admission is stricter than P1-08.** All three must hold:
   - every command gate is green in the gate image, not only the test command in CI;
   - the target has CI of its own;
   - its default branch is protected.
5. **The operator opens onboarding and offboarding PRs, outside the outbox.** These PRs carry workflow files, and the rulesets need Administration: both are beyond the App, so the operator's token does it.
   - **Branches:** `software-factory/onboard`, `software-factory/update` and `software-factory/offboard`. They never use `factory/**`, which is the App's and which `policy-check` holds to a verdict.
   - **Idempotence:** one module finds before it acts, with deterministic commits, as the outbox does for tasks. It is the only other file allowed to open a PR.
6. **The App is added and removed by hand.** The operator adds a repository to the App's installation, or removes it, in GitHub's settings. Removing one repository through the API would need a classic personal access token with broad scope, and uninstalling through the App would remove every target. `onboard` and `offboard` print the exact step, then check it by minting an installation token narrowed to the repository.
7. **Offboarding runs in this order:** the App, then the rulesets, then the offboarding PR, then the purge.
   - The App goes first, so the factory loses write access first.
   - The rulesets come off before the PR, because the PR deletes `factory-gates.yml`, which produces the required `gates` check.
   - The purge reports the tier budgets before and after: P1-01's calibration is computed from the events that remain.

## Consequences

- **The migration reaches live data.** Store schema 4 runs on the operator's `factory.db` and replica when the first P2-11 release is installed, and an older `factoryctl` refuses the migrated store. It cannot be rolled back across: the CHANGELOG marks it **Breaking**.
- **The guarantee is narrower.** "Append-only" now means every event of a task without a tombstone. The tests hold the triggers to that:
  - every other update and delete still aborts;
  - nothing can be written to a purged task;
  - a purged id never comes back.
- **What a purge cannot reach:**
  - GitHub's copies, such as the PRs, branches, comments and check runs the factory left on the target;
  - backups the operator made outside the replica;
  - blocks the disk keeps after a file is deleted.

  The operator guide says so.
- **Purging is all or nothing.** A purge stops, deleting nothing, when any task's target cannot be told from its record, or when a kept task's evidence tree is missing.

## Alternatives considered

- **Keep events, delete only files.** This leaves principle 8 untouched, but an offboarded target's task titles, reasons and PR URLs would stay in every event forever. The operator chose deletion.
- **Redact event bodies in place.** The rows, their counts and their order would survive, but it needs updates as well as deletes, and an update path is a wider exception than a delete path guarded by a tombstone.
- **The private store in a private git repository.** This was §10's default. Its history keeps every profile ever committed, so offboarding could not purge one.
