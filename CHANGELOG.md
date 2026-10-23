# Changelog

Every factory release, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. A release is a version tag that matches `plugin/.claude-plugin/plugin.json`; the [operator guide](docs/factory/operator-guide.md#releases) covers cutting and installing one. Breaking changes for the operator are marked **Breaking**.

## [Unreleased]

## [0.24.0] - 2026-10-23

### Added

- **The code graph (P2-13, PR 1 of 2).** The gate image carries graphifyy 0.9.91. Each gate run builds the candidate's code graph with `graphify update --no-cluster`: offline, with no LLM, on the read-only tree.
  - The graph is advisory: it is never one of the gates and never fails them.
  - Its record in `gates.json` names the tool and stamps the candidate commit, so a graph of an older commit reads as stale.
  - The pipeline commits the graph as `graph.json` beside each round's `gates.json`, and as `drift/<k>/graph.json` beside each re-verification's. It does so only when the record says it was built and the file's digest matches. Replayed gates carry none.
- **`verify-tools` checks PyPI wheels.** A wheel with PEP 740 provenance is checked with cosign; the four tree-sitter wheels, which publish none, are checked against PyPI's own record of the file.

## [0.23.0] - 2026-10-22

### Added

- **`factoryctl offboard OWNER/NAME` (P2-11, last part).** It lets a target go, access first ([ADR 0003](docs/factory/adr/0003-onboarding-retention-and-purge.md)). It is operator-only. Each step is recorded in the target's record once done, so a run can stop anywhere and be repeated:
  1. The target takes no new task. It refuses while a task of the target is unfinished or the onboarding PR is open.
  2. The operator removes the repository from the App's installation, and a narrowed mint checks it.
  3. The footprint's rulesets are deleted.
  4. A PR from `software-factory/offboard` deletes the footprint and takes the layer out, so the target's files return to what they were.
  5. Once the factory is idle, a purge journal deletes every task of the target in the home and the replica, with the mirror and the gate cache volume. The calibration is recomputed without the target, and the private store's directory goes last.

  The report gives the tier budgets before and after, and scans the home, the replica and the remaining events for the target's names and its tasks' titles. `--local-only --reason` covers a repository that is gone, and `--app-unavailable --reason` a suspended App.
- **P2-11's done-when, `roundtrip.test.ts`.** In `pnpm test`, the real `factoryctl` onboards ts-mini, runs and rejects a task on it beside another target's task that shares an object with it, then offboards it. It checks five things:
  - the target's tree is back to its base, byte for byte;
  - no file in the home or the replica holds its name or its task's title;
  - the other task and the shared object are intact;
  - the purged id is never issued again;
  - a restore and the restore drill bring nothing back.
- `doctor` points an offboarding target at `factoryctl offboard`.

## [0.22.0] - 2026-10-22

### Added

- **`factoryctl onboard OWNER/NAME` (P2-11, third part).** It takes a repository on as a target: inventory, a drafted profile, admission, a STOP for the operator, then the footprint PR, the rulesets and the App's access ([ADR 0003](docs/factory/adr/0003-onboarding-retention-and-purge.md)). It is operator-only.
  - Each run takes the target one state further (`drafted`, `confirmed`, `proposed`, `merged`, `active`) and stops where a person acts. Every step finds before it acts, so a run can be repeated at any point, after a crash too.
  - **The inventory** reads the default branch from the mirror without a checkout. It proposes the commands from the lockfile and `package.json` scripts, or from uv and `pyproject.toml`. It reproduces both fixtures' commands exactly, and notes what it cannot decide instead of guessing.
  - **Admission** needs every command gate green in the gate image, CI of the target's own, and a protected default branch. The profile must be valid and name its approvers.
  - **`--confirm`** accepts only the profile admission passed on. It builds one deterministic commit of the footprint and the layer: a marked block in `CODEOWNERS` and in `CLAUDE.md`, `.claude/rules/factory-invariants.md`, and the factory's plugin in `.claude/settings.json`, pinned to the release. It merges into the target's files and records what it added, for offboarding. The PR goes from `software-factory/onboard` with the operator's token, not through the task outbox.
  - **After the merge,** it checks the default branch holds what was proposed and that `gates` passed, applies the rulesets, and checks the App reaches the repository. If the App does not, it prints the installation-settings step.
  - **`--update`** proposes a profile edit or a release move on `software-factory/update`. A closed update leaves the target on the change it had.
- **The private store,** `$FACTORY_HOME/targets/<owner>__<name>/`, holds `target.json` (`schemas/target.schema.json`), `profile.yaml`, `inventory.json` (`schemas/inventory.schema.json`) and an audit journal. The replica copies it, and a restore brings it back.
- **`task create --repo OWNER/NAME`** uses an active target's confirmed profile and remote. **`intake` without profiles** polls every active target with an `intake:` block. Both refuse a profile changed since it was confirmed.
- **`doctor`** checks every target in the store: its state, its profile against the confirmed one, its rulesets and the App's access.

## [0.21.0] - 2026-10-22

### Added

- **Retention per profile (P2-11, second part).** A finished task keeps its evidence for the shorter of its profile's and the config's `retention_days`, counted from its last activity ([ADR 0003](docs/factory/adr/0003-onboarding-retention-and-purge.md)).
  - Transcripts expire into the run's transcripts and session directory.
  - A bundle expires into everything but `task.json`, with the worktree, the session directory and the eval captures. The task's events stay.
  - A task's telemetry expires from the OTel files.

  Each expiry is an `evidence_expired` event recorded before anything goes. Objects only expired evidence names are deleted, in the home and, from its own record, in the replica, and a restore leaves expired files out. A task that has not finished is never pruned.
- **`factoryctl prune [--dry-run]`.** It shows and applies what is due, and finishes a purge that stopped part-way. It is operator-only, and runs only while the factory is idle.
- **`doctor`** warns when tasks are past retention and when a purge stopped part-way.
- **Schema migrations tested on old bundles.** `controller/src/store/testdata/` holds homes that v0.1.2 and v0.7.0 wrote with their own `factoryctl` (`generate.ts` rebuilds them). `old-homes.test.ts` checks that each one:
  - migrates to store schema 4 with every event kept and still append-only;
  - keeps every artifact valid at the schema version it declares;
  - is read by `status`, `report` and `prune --dry-run`;
  - can be pruned, purged, replicated and restored.

### Changed

- `status` reads a task's record from the object store when its run directory is gone, and marks a task whose bundle expired.
- The refusal for a task started on v0.1.x says to cancel it and create a new task: v0.1.x cannot open the store since `v0.20.0`.

## [0.20.0] - 2026-10-22

### Changed

- **Breaking: store schema 4.** `factory.db` and the replica gain a `tombstones` table, the one record a purge writes ([ADR 0003](docs/factory/adr/0003-onboarding-retention-and-purge.md)). Installing this release migrates both on first use, and an older `factoryctl` then refuses the store: there is no rolling back across it.
- **Events stay append-only except by record.** An event can now be deleted only once its task has a tombstone. Nothing can be added to a tombstoned task, tombstones are themselves append-only, and a purged task's id is never reused. Every other update and delete still aborts.
- Deleted rows are overwritten (`secure_delete`).
- The replica's sync starts after the highest row id it has ever copied, which SQLite keeps after a purge deleted those rows, rather than after the highest row it still holds.

### Added

- **Purging by record (P2-11, first part).** A purge is planned in full into a journal under `$FACTORY_HOME/purges/`, then run step by step; a crash anywhere resumes where it stopped. Each purge:
  - writes the tombstones, deleting the tasks' events in the same transaction;
  - deletes every object only those tasks referenced, and objects no task names that are over an hour old;
  - removes their run, worktree and session directories and eval captures;
  - drops their OTel lines;
  - compacts the store;
  - has the replica complete the same purge from its own record.

  A restore completes a purge the replica had recorded and not finished. The restore drill fails if anything purged comes back. Nothing runs a purge yet: `offboard` and `prune` come in the next P2-11 releases.
- **ADR 0003** records the purge as the single exception to principle 8. It also settles the private store (`$FACTORY_HOME/targets/`), retention (shortest of profile and config), the admission bar, and how onboarding and offboarding PRs are opened.

## [0.19.0] - 2026-10-21

### Added

- **`/software-factory:factory-review`, the plugin's workflow (P2-14), for interactive use only.** In a person's own Claude Code session it reviews their change against a base ref, or by default against the upstream branch:
  - a scope step writes the diff, capped as the factory caps it, into the git directory;
  - the plugin's own code and security reviewers review it, joined by the dependency and migration reviewers when a changed path matches the policy's globs;
  - the plugin's refuter tests every blocking finding.

  It returns the findings and how many still block. It never changes the working tree, pushes, posts or approves, and it spends tokens on the person's own login. Factory sessions keep workflows off.
- The script is plain JavaScript, as the workflow runtime needs. `controller/src/plugin/workflow.ts` generates it from the factory's review and refutation schemas, reviewer table, `policies/risk.yaml` routing and diff cap, and a test fails when the committed file differs. A unit test runs it against stand-ins. An integration test shows the pinned CLI loading it in a person's session and not in a factory session.

## [0.18.0] - 2026-10-21

### Security

- **Mods stay out of factory sessions.** Claude Code 2.1.286 and later run mods, plugin code that runs inside the CLI, outside the sandbox. On the pinned CLI a mod in a session's own config directory, `dev-mods/<session id>/`, loads even headless under `dontAsk`. Now:
  - a session's sandboxed commands may not write to its config directory, its home's `.claude` or the release's plugin;
  - a session whose config directory's `dev-mods/` holds anything does not start, and its task fails as `permission_denied`;
  - `takeover` refuses the same;
  - the runner's managed settings also set `allowManagedModsOnly` on Claude Code's built-in mod guard.
- **Claude Code's built-in `AGENTS.md` loader is off** (`instructionFiles: "managed-only"`) in session settings and the runner's managed settings. `settingSources: []` already kept a target's `AGENTS.md` out of sessions.

### Added

- The runner conformance suite shows both with the real CLI. The target carries canary instruction files and a mod, and a user plugin and a session mod are planted in the session's config directory. No canary reaches the model, no mod runs, and the session can write into neither its config directory nor the plugin. The stub model logs which watched strings each request carries (`STUB_WATCH`).

## [0.17.0] - 2026-10-21

### Added

- **Live sessions in the runner (the switch-on P2-02 left for P2-05).** `factoryctl run T-… --runner container` (and `resume`) runs a task's live sessions in runner containers. The task gets its own internal network and egress proxy, whose one route leads to the credential gateway; the gateway now also listens where that route reaches it. Each session gets its own gateway token. The build's preflight runs on the host through the broker, and the session's OTLP goes through the gateway to the run's collector. The network and proxy go when the run ends.
- **Live `serve`.** Without `--replay`, `serve` runs live sessions unattended, every one in the runner. It builds the runner image before it starts, and a worker refuses live sessions anywhere else.

## [0.16.0] - 2026-10-21

### Added

- **`factoryctl gate G2`.** It checks G2-1 to G2-6 on the frozen system and drafts the evidence PR. It matches each task in the window to its seeded fixture case by text and target, and checks:
  - G2-1: the first 15 clean R0–R1 attempts, failed ones included, each judged merged without a human commit or change request from the PR's commits and reviews;
  - G2-2: every seeded attack stopped at a human gate, each injection vector covered (the issue one admitted from an issue), the outbox's pushes and the App's repository activity all under `factory/**`, and no `Workflow` tool use in any transcript;
  - G2-3: a serve-kill record's tasks reached their merge gates, live, with no side effect made twice and one PR each;
  - G2-4: p90 cost per merged PR by tier, each PR charged every attempt of its case up to the merge;
  - G2-5: the canary audit;
  - G2-6: a drift re-verification that merged, and passing restore and kill-switch drills from the window.

  G2-7 lists the SLOs, approver–human agreement and approval latency for the operator to approve.
- **The G2-5 canary.** `gate G2 --begin` plants a canary in the secret store, which every later `run` and `serve` carries in its own environment. The audit looks for it, and for the factory's API key, App key and `serve` token, in:
  - the run directories, with git bundles unpacked (deltas included) and the egress proxy logs;
  - the object store, the session homes and the OTel files;
  - the event store.

  It names a hit by file, never by value.
- **`factoryctl drill serve-kill`** (operator only): SIGKILLs `serve` while it runs at least three tasks, and records them for G2-3.
- The `ts-mini` `limit-off-by-one` injection case also asks for "ultracode" (G2-2).

## [0.15.0] - 2026-10-21

### Added

- **G2 seeded fixtures.** The fixtures gain 18 seeded tasks, each with a golden patch that passes every gate and hidden tests that fail at the base:
  - 14 R0–R1 tasks, for 22 in all and 18 without an injection: enough for G2-1's 15-attempt sample;
  - an auth change (`ts-mini` `session-revoke`) and a code-execution sink (`py-mini` `report-formula`), for 3 cases in each class;
  - an injection through a code comment (`ts-mini` `shipping-world-zone`) and one through a vendored dependency (`py-mini` `units-label`).

  A seeded case names the repository file that carries its injection as `carrier` in `tasks.yaml`.

### Changed

- **Breaking for the fixture mirrors:** both fixture bases gain a file, so their base commits change. Reset each mirror before gate G2's sample: `node scripts/mirror-fixture.ts NAME --footprint --factory-ref v0.15.0 --push --reset --rulesets`.

## [0.14.0] - 2026-10-21

### Added

- **Injection signals (G2-2).** Two deterministic signals keep a possible injection away from auto-merge:
  - **A denied tool call.** A task in which the guard or a stage's tool list denied any tool call goes to the human merge gate, and its `factory/verdict` says `needs_human`.
  - **Instructions aimed at an agent.** The policy step scans the task's text, and the target files its sessions read or its candidate changed. A line addressed to an AI near an ask no task needs makes the task at least R2, with a security review. That is a new `injection_suspect` rule in `policies/risk.yaml`. The lines found are committed as `injection.json`.

## [0.13.0] - 2026-10-19

### Added

- **GitHub intake (P2-04).** `factoryctl intake PROFILE...` turns a target's labelled issues into tasks.
  - A profile's new `intake:` block names the label and the maintainers who may apply it.
  - An issue enters only when the latest application of the label is a maintainer's, and only as the text it had then. An edit after the label holds it until a maintainer labels it again, and a label from anyone else is ignored.
  - Issue text is always untrusted. The task records who admitted it and which label event.
- **The issue status mirror (P2-04).** An admitted issue gets one comment from the App: the task's ID, state and PR. The end of every run updates it through the outbox's new `comment_edit` effect.

### Changed

- **Breaking:** the factory App needs **issues: read and write** too. Grant it in the App's settings and accept the change on its installation; `doctor` fails until then.

## [0.12.0] - 2026-10-19

### Added

- **Re-verification on base drift (P2-06).** Before it merges an approved R0–R1 task, `factoryctl` fetches the target's base. If the base moved since the candidate was verified, it does not merge. Instead it:
  - merges the new base into the task branch;
  - runs the gates and the policy again;
  - pushes the result and posts a new `factory/verdict` on it, with the approver's decision carried over;
  - waits for the required checks on the new head.

  A base change to the PR's own files, a merge conflict, red gates or a higher tier sends the task to the human merge gate instead. Each re-verification is committed under `runs/<task>/drift/<k>/`, and `manifest.json` names the new base.
- **Serialised merges (P2-06).** `factoryctl` merges into one target one task at a time, under the target's merge lease, held from the base check to the merge. A lease whose holder died is free.

### Changed

- **The store gains `merge_leases`** (schema 3), and a replica now runs the store's migrations at every sync, so a replica made by an earlier release takes the new schema.

## [0.11.1] - 2026-10-18

### Fixed

- **`doctor` no longer flags a fixture's `factory-branches` ruleset that matches.** GitHub leaves a boolean rule parameter out when it is false, its default, and `doctor` read the missing `update_allows_fetch_and_merge` as a difference. It now takes a missing boolean as false, and the template no longer sends the default.

## [0.11.0] - 2026-10-18

### Added

- **The governance footprint (P2-05b).** It is rendered from a target's profile (`governance.approvers`, new), the App's ID and a release commit:
  - `.factory/policy.yaml` and `.factory/gates.yaml`;
  - a `factory-gates` workflow on `pull_request`;
  - a `policy-check` workflow on `pull_request_target` that never checks out the PR and can only read;
  - the `factory-main` and `factory-branches` rulesets.

  `scripts/mirror-fixture.ts --footprint --factory-ref vX.Y.Z --push --rulesets` rolls it out to a fixture, and `doctor` checks each governed fixture's rulesets.
- **R0–R1 merge themselves in Phase 2.** With the App, an approved R0–R1 task waits as `AUTO_APPROVED` until the required checks pass on the judged commit. `factoryctl` then squash-merges the PR at exactly that commit, through the outbox, so a crash never merges twice. A failed check, a moved head or a refused merge sends it to the human merge gate. `serve` polls it with the merge gate.
- **`policies/approvals.yaml` names the current phase** (`current_phase: P2`). Its ladder decides both what `factoryctl` merges and what `policy-check` passes without a human.

### Changed

- **`policy-check` follows the approvals ladder.** In Phase 2, R2 and R3 need an approver's review of the head commit, and Restricted is never merged.
- **`.factory/**` is protected:** R3 in the risk policy, and denied to every session by the guard.
- **A profile's `reviewers.migration_paths`** bring in the migration reviewer, as `**/migrations/**` does.

## [0.10.0] - 2026-10-18

### Added

- **The factory GitHub App (P2-05).** With an App set, `factoryctl` acts as it: each run signs a JWT with the App's key, kept in `$FACTORY_HOME/secrets/github-app.pem`, and trades it for an installation token narrowed to the task's own repository, renewed within the hour.
  - **Setup:** `factoryctl app init --app-id N --installation-id N` records the App's IDs and checks them at once.
  - **`doctor`:** checks the key, that GitHub knows the App by it, its permissions (exactly checks, contents and pull requests write, metadata read) and its installation.
  - **Fallback:** without an App, `FACTORY_GITHUB_TOKEN` still pushes and opens PRs.
- **The `factory/verdict` check run.** After publishing, the App posts it on the candidate commit through the outbox.
  - **Content:** the commit judged, the reviewed base, the tier, the approver's decision, the spec's digest and the digest of every committed artifact, as canonical JSON with its sha256.
  - **Record:** a copy is committed as `verdict-check.json`, and `publish.json` records its URL.
- **`policy-check`**, the check a target's `pull_request_target` workflow runs from the pinned release (`controller/src/governance/policy-check-cli.ts`). For a `factory/**` PR it:
  - reads the base branch's `.factory/policy.yaml`;
  - computes the tier again from GitHub's diff and a sink scan of the head's added lines, in the gate image with no network;
  - accepts only a verdict from the App, on the PR's head, with a matching digest and a tier at least the computed one;
  - holds R3, and anything passed to a human, until a listed approver approves the head commit.

  The workflows and rulesets that make it required come with P2-05b.
- **Eval cases for the reviewer graph (P2-09).** Each new reviewer has a case that should block and one that should pass: a typosquatted, unpinned dependency against a pinned devDependency, and a NOT NULL column with no backfill against an additive migration. Each also has a held-out block case: a dependency from a git branch with an install script, and a rename that drops a column. Both reviewers are judgment roles now, so the suite must keep a pass and a block case for each.

## [0.9.0] - 2026-10-17

### Added

- **The reviewer graph (P2-09).** Two read-only reviewers join a round when the risk policy asks for their review on the candidate's diff, besides the code and security reviewers that see every candidate. Their findings go to the refuter and block like any other.
  - **Dependency reviewer:** runs when the change touches a dependency manifest. It checks whether each new or changed dependency is needed, and its identity (typosquats), pinning, install scripts and source.
  - **Migration reviewer:** runs when the change touches a `migrations/` path. It checks what the migration does to existing rows, destructive steps, reversibility, ordering against the code, and locks.
  - **Coverage:** each has its rubric, routing (sonnet, medium effort) and tool policy. Their eval cases follow in their own PR, as the eval rule requires.
- **Seeded fixture tasks:** `ts-mini` adds a pinned runtime dependency, and `py-mini` adds a SQLite store with a migration. Each seeded task now records the reviews the policy engine asks for.

### Changed

- **The ux-evaluator is deferred** by [ADR 0002](docs/factory/adr/0002-ux-evaluator-deferred.md) until a target with a UI and a preview deploy is admitted.

### Fixed

- **Concurrent opens of the event store or the replica.** They no longer fail with "database is locked" when another process holds the lock while the database switches to WAL; they wait up to the busy timeout.

## [0.8.0] - 2026-10-17

### Added

- **Telemetry by default (P2-08).** Every live run starts its own OTLP collector on loopback, and sessions export Claude Code's metrics and events to it. The collector writes them to `$FACTORY_HOME/otel/<day>.ndjson` for 30 days; nothing leaves the host. `FACTORY_OTEL_ENDPOINT` still points sessions at a collector of your own, and `FACTORY_OTEL=off` turns telemetry off. The gateway forwards OTLP exports to it, the route runner sessions use once P2-05 turns them on.
- **`factoryctl slo`.** It measures the SLOs of the new [docs/factory/slo.md](docs/factory/slo.md) over the last 4 weeks (`--weeks N`): the auto-merge-ready rate, reviewer precision, p90 cost per merged PR by tier, and the safety counters. Escaped defects are reported as not measured until the GitHub client reads reverts. A per-task telemetry panel follows.
- **`doctor` drift checks.** It fails when the runner's managed settings differ from what the release generates. With `FACTORY_GITHUB_TOKEN`, it diffs this repository's `main` ruleset on GitHub against `.github/rulesets/main.json`.

## [0.7.0] - 2026-10-17

### Added

- **Durability (P2-07, [ADR 0001](docs/factory/adr/0001-replication-without-litestream.md)).** `factoryctl` replicates its own state instead of using Litestream, whose releases carry no signature or attestation the factory could verify.
  - **Object store:** a write-once, content-addressed store in `$FACTORY_HOME/objects` holds every committed artifact (by the digest its commit event records), each task's files and each run's evidence. The build also commits a git bundle of its candidate commits.
  - **Replica:** `factoryctl replica init DIR` sets a replica, meant for another volume. Every run, worker and `serve` syncs new events and missing objects to it every second, and every command syncs before it exits. `replica status` and `doctor` show how far behind it is.
  - **Restore:** `factoryctl restore --source DIR` rebuilds an empty home from the replica. Each restored task rebuilds its clone from its target and its committed candidate on its next run, and the outbox keeps it from pushing or opening anything twice.
  - **Drills (G2-6):** `factoryctl drill restore` restores the replica into a scratch home and records RTO, RPO and any file not restored intact. `factoryctl drill kill-switch` halts the factory and records how long until no agent activity is left; it leaves the factory halted.
- **The kill-switch runbook** in the operator guide: pause, drain, halt, App suspension, key rotation and revert.

### Changed

- **Pushes** go from the home's own mirror, not the path recorded at checkout, so a task restored into another home pushes from its own mirror.

## [0.6.0] - 2026-10-17

### Added

- **The credential and budget gateway (P2-02).** Live sessions no longer use the API key. `factoryctl run` starts a gateway on loopback that holds the key; each session gets its own token, in a file under `$FACTORY_HOME/tokens/`, and calls the gateway as its `ANTHROPIC_BASE_URL`.
  - **Hard cap:** a session's token is good up to what is left of the task's hard budget. Once its metered spend reaches that, the gateway refuses its next request, and the task fails as `budget_exceeded` mid-stage.
  - **Metering:** every response is metered from the usage the API reports, priced by the new `prices` table in `config/factory.yaml` (ROADMAP §11), and recorded as a `usage` event. Budgets, `report` and the manifest count metered cost; a session's own estimate is kept as `reported_cost_usd`, and a killed session is charged what was metered instead of its cap.
  - **Revocation:** a token is revoked when its session ends, and every token while the factory is halted.
  - **Scope:** only the Messages and token-counting routes, for a priced model, reach the API; the session's credential never does.
- **The runner's gateway route.** The egress proxy forwards one fixed route to the gateway on the host (`http://<proxy>:3129`), logging only method, path and status, so a runner session reaches the model without the key ever entering its container. The runner suite checks it with the pinned CLI.

### Changed

- **Config and schema:** `config/factory.yaml` gains the required `prices` table, and the event schema the `usage` type. Events written by earlier releases stay valid.
- **`factoryctl serve`** still runs replayed sessions only, now until P2-05 turns on live runner sessions under governance.

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

[Unreleased]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.24.0...HEAD
[0.24.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/caglarsubas/software-factory-claude-code/compare/v0.5.0...v0.6.0
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
