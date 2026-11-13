# Session handover

A new Claude Code session picks up the factory's development from here. Read this file, then [`ROADMAP.md`](ROADMAP.md) (§2.6 and §3 twice), [`STATUS.md`](STATUS.md) and the [operator guide](operator-guide.md). STATUS is the record of what is done; this file holds what a new session cannot recover from the code alone: where the work stands, what comes next, and how the operator and the agent work together. Update it whenever one of those changes, and keep it free of private target names, task text, findings and secrets, as for STATUS.

## Starting a new session

The work moves between sessions and Claude accounts. From 2026-10-25 it runs in a Claude Code session on the operator's Mac, in their checkout; on 2026-10-27 it moves to another Claude account on the same Mac and checkout. Nothing but this repository carries over: no reminder, scheduled check-in, PR subscription or plan file from an earlier session reaches a new one.

1. Read [`CLAUDE.md`](../../CLAUDE.md), then this file to the end, then STATUS's Current phase row and the deviations log.
2. Check GitHub: open PRs, the latest release (`v0.27.0` until the pin move merges, then `v0.28.0`) and `ci` on `main`. On 2026-11-13 the pin move's PR, #83, was open, with dependabot's #5, #34, #80, #81 and #82. The dependabot PRs are the operator's to close or rebase; #34 changes `.github/workflows/`, a guardrail, and #80 and #82 change the gate image.
3. Branches:
   - `claude/epic-cannon-akxfwy` holds the pin move, whose PR #83 is open for the operator's merge (What comes next, step 1). Delete the branch once it merges.
   - No other `claude/*` branch is left: the merged ones were deleted on 2026-10-27. Start new work on a fresh branch from `main`.
4. The move to the operator's Mac is done (the next section). On the same Mac and checkout, a new account only checks that `git status` is clean on `main`, pulls, and runs `pnpm install --frozen-lockfile`; on another machine, work through that section again.
5. No decision is open: the operator chose 2.1.306 for the pin move on 2026-10-25, and its PR is open. Start with What comes next.

## Moving the work to the operator's Mac

The development work continues in Claude Code on the operator's Mac, in their checkout, under another Claude account. The factory's own runs already live there (`$FACTORY_HOME`, default `~/.factory`). The switch is complete when every step below is done; record each in STATUS (the Factory release row, the deviations log) only where it changes what STATUS says.

**Done (2026-10-25 to 27, the first local session):**

- The toolchain is in place and none of the cloud-only variables is set. `v0.27.0` is installed and pinned, `doctor` clean but for `SSH_AUTH_SOCK`.
- The baseline is green on the Mac: `pnpm check` (880 tests), `pnpm test:gates` (88) and `pnpm test:runner` (12). #76 fixed tests that failed on macOS only (`/var` and `/private/var`, a symlink target's Unicode form, Docker Desktop's buildx hidden by a test's `HOME`). #77 gave the unit suite a 30 s timeout: under the full suite's load on the Mac, tests that take about 1 s alone ran past Vitest's 5 s default.
- **Docker on the Mac:** the operator's other projects keep many networks. If `docker network create` fails with "all predefined address pools have been fully subnetted", the operator lists `docker network ls --filter dangling=true` and runs `docker network prune`; the factory recreates `sf-egress-out` on demand.
- The merged cloud branches are deleted. Left for the operator: archiving the cloud sessions on claude.ai/code.

### Once, by the operator, in their own terminal

1. **The toolchain**, as the operator guide's Prerequisites list:
   - Node 24.21.0 (`.node-version`) and `corepack enable` for pnpm 12.6.0 (`packageManager`);
   - Docker Desktop, running; git; `gh`, signed in with access to this repository (`gh auth status`);
   - Claude Code, signed in to the new account. Its own version does not matter for development; `takeover` checks it against the pin.
2. **The cloud-only environment:** unset `FACTORY_GATES_CA_FILE`, `FACTORY_GATES_FETCH_NETWORK` and `FACTORY_EGRESS_UPSTREAM` if a profile sets them. They exist for a cloud container's proxy; on the Mac the gates and the runner reach the network directly.
3. **The latest release,** outside Claude Code, since moving the pin refuses inside it, once the agent has brought the checkout up to date (below):

   ```bash
   pnpm factoryctl release install v0.27.0
   factoryctl doctor
   ```

   `$FACTORY_HOME` keeps its secrets (the API key file, the GitHub App key, `serve.token`) and the replica; nothing moves. Give the agent `doctor`'s output for STATUS's Factory release row.

### In the first local session, by the agent

1. **Bring the checkout up to date:** `git status` first, and stop to ask if anything is uncommitted or the checkout is on another branch. Then `git checkout main`, `git pull --prune --tags` and `pnpm install --frozen-lockfile`.
2. **A green baseline:** `pnpm check`, then `pnpm test:gates` and `pnpm test:runner`, one at a time. The full gate image (with graphifyy) builds here for the first time outside CI; the cloud could not build it.
3. **GitHub through `gh`:** `gh pr create`, `gh pr checks <n> --watch`, and `gh pr merge <n> --merge --match-head-commit <sha>` under the "Who merges" rule below. If a GitHub MCP server is configured instead, it serves the same.
4. **No scheduled check-ins:** a local session has no reminders or PR subscriptions. Dated work (the pin move on 2026-10-28) starts when the operator opens a session that day; a PR is watched with `gh pr checks --watch` while the session runs.
5. **The operator's Mac items** (Waiting on the operator) become possible from this session: the agent can run `doctor`, the live runner task and the attended host run once the operator agrees, since live runs bill their account. The operator-only commands still refuse inside Claude Code, also through `!`: the agent writes the exact command, and the operator runs it in their own terminal.
6. **Permissions:** never `bypassPermissions`. The project's `.claude/` is a protected path: a settings change there goes through a PR the operator reviews.

### Retiring the cloud

- **Cloud sessions:** nothing is left running in them (no reminder, no PR subscription). Archive them on claude.ai/code.
- **Merged branches** the cloud sessions left were deleted on 2026-10-27, with the operator's agreement. Keep `claude/epic-cannon-akxfwy` until the pin move merges.
- **`factory/T-0014` and `factory/T-0015`** are the factory's own task branches, merged; they are the operator's to keep or delete.
- **Cloud-session notes** (the end of this file) stay, for a session that goes back to the cloud.

## Where the work stands (2026-11-13)

- **Phase:** P2, Team-grade. G0 and G1 are signed (`gates/G0.md`, `gates/G1.md`).
- **Phase 2 core:** every core item, P2-01 to P2-09, is done.
- **G2 tooling (plan PR 10):** done in four PRs:
  - #55 (`v0.14.0`): the injection signals;
  - #56 (`v0.15.0`): the seeded fixtures;
  - #57 (`v0.16.0`): `factoryctl gate G2`, the G2-5 canary and `drill serve-kill`;
  - #58 (`v0.17.0`): the switch-on of live `serve` and live sessions in the runner container, which P2-02 left for P2-05 and nothing had done.
- **The §11 re-check before the freeze:** done on 2026-10-21 and logged in STATUS's platform log.
  - No advisory affects the pin.
  - The pin lacks about 25 later fixes without an advisory that apply to the factory's sessions.
  - Mods are on by default from the pinned 2.1.286. A probe showed `settingSources: []` keeps a target's `AGENTS.md` out of sessions, and a mod in a session's own `dev-mods/` loading even under `dontAsk`.
  - The operator decided to move the pin before the freeze.
- **`v0.18.0` (#61):** keeps mods out of sessions' config directories and turns the `AGENTS.md` loader off.
- **P2-14 (`v0.19.0`, #63):** the plugin's `factory-review` workflow, for interactive use only.
- **Parallel items:** P2-13 and P2-10 are done (the next two sections). P2-12 stays stopped until a written egress policy exists (Appendix A).
- **P2-11 (done, 2026-10-22):** four PRs, each a release, following [ADR 0003](adr/0003-onboarding-retention-and-purge.md), the operator's decisions of 2026-10-22: purge by record with tombstones, and the App added and removed by hand, verified by factoryctl.
  - #65 (`v0.20.0`): deleting by record (store schema 4, purge journals, the replica).
  - #66 (`v0.21.0`): retention per profile, `prune`, and old-bundle migration tests.
  - #67 (`v0.22.0`): `onboard`, and the fix for the kill-point suite's "fetch failed" flake (the stub GitHub's keep-alive).
  - #68 (`v0.23.0`): `offboard` and the round-trip test (the done-when). The round trip ran offline only; a live one is for P3-08.
- **The pin move** to 2.1.306 / 0.3.306 is `v0.28.0`, #83, open from `claude/epic-cannon-akxfwy` on 2026-11-13 with `main` merged in. It changes the pin, a guardrail, so the operator merges it.
- **Freeze:** the core freezes on Nov 27 (§5); the G2 sample runs on the frozen system.

## P2-13, the code graph in shadow mode (2026-10-23)

Two PRs, each a release, on the branch `claude/epic-cannon-akxfwy-p2-13`, following the operator's decisions of 2026-10-23 (the tree-sitter wheels pinned by SHA-256 alone; two PRs; one branch, restarted from `main` after the first merged).

- **PR 1, #69 (`v0.24.0`, merged):**
  - graphifyy 0.9.91 in the gate image builds every candidate's code graph offline (`graphify update --no-cluster`), advisory;
  - the pipeline commits it as `graph.json` per round and `drift/<k>/graph.json` per re-verification;
  - `verify-tools` checks PyPI wheels.
  - CI's `gates` job on the full image confirmed the integration suite's expected file edges.
- **PR 2, #70 (`v0.25.0`, merged):** `controller/src/graph/blast.ts`. The hops from the changed files back to the nearest R3 or Restricted path feed `graphHopsToProtected`. Only a fresh graph counts. The rule stays in shadow mode, so no tier moves.
  - `blast.json` per round and per re-verification is the per-task log the done-when asks for.
  - `report T` and `report --week` show it.
  - The operator guide's "Code graph (shadow)" section describes it.
- **P2-13 is done.** The graph's enforcement waits for P3-05's A/B, after G2.

## P2-10, the dashboard (2026-10-24)

Two PRs, each a release, on the same branch, restarted from `main` after each merge.

- **PR 1, #72 (`v0.26.0`, merged): the read-only dashboard.** `factoryctl dashboard` serves the board, the evidence drawer and a live stream on loopback (`controller/src/dashboard/`).
  - **The done-when:** it reads `factory.db` through `EventStore.openReadOnly`, whose `EventReader` type has no write method and on which SQLite refuses writes. The server answers `GET` only.
  - **The stream's position** is store-wide (`EventStore.cursor()`, the events table's row id): `seq` counts per task.
  - **Exposure:** a token new for each launch, in the address's fragment; `refusal()` from `serve/api.ts` checks the token, `Host` and `Origin`; a strict CSP; the page writes text with `textContent` only.
- **PR 2, #73 (`v0.27.0`, merged): the command bus.** The dashboard passes its commands to `serve`'s API with `serve`'s token, and `serve` validates and writes them: pause, resume, drain, and a task's pause, resume, priority (new, also `factoryctl priority`) and cancel. With no `serve`, a command is refused.
  - **Drawer opens:** `$FACTORY_HOME/dashboard/drawer-opens.ndjson`, counted by `report --week` (§6 approval fatigue).
  - **Left out, by the operator's decisions of 2026-10-24** (a STATUS deviation row): approve or reject, request changes, re-run a stage, extend the budget, raise the tier. Raising a tier waits until after G2: done safely it must reach the spec gate, reviewer selection and the policy step before they run, which changes the policy code that feeds auto-merge.
- **P2-10 is done.**

## Waiting on the operator

Every release up to `v0.27.0` is tagged and published; the operator's home has `v0.27.0` installed and pinned since 2026-10-25 (STATUS's Factory release row).

- **Tagging is no longer the operator's step:** the `release` workflow tags and publishes a version when its bump merges (operator guide, Releases).
- **The backfill is done:** `v0.20.0` to `v0.25.0`, merged before the workflow existed, were tagged and published by running it by hand with each merge commit.
- **Installing stays with the operator:** `factoryctl release install`, `release use` and `factoryctl doctor`, for the releases they will run: the latest one, `v0.27.0` or the pin move's once it is out, not each in turn. Record it in STATUS's Factory release row.
- **The eval suite's spend:** the `software-factory-ci` Console workspace reached its monthly API usage limit on 2026-10-22, and every eval run failed from then until it reset on 2026-11-01. The pin move's eval runs and the G2 sample's month draw on the same limit: the operator checks it before the freeze.
- **The operator's Mac:** a local session (the Claude Desktop app, or `claude remote-control` in their checkout) can run what needs their machine: `doctor`, the live checks below, T-0020 and the mirror reset. The operator-only commands still refuse inside any Claude Code session.

1. **The pin move's PR, #83:** review and merge it; then, once the eval run on the merge commit passes, install and use `v0.28.0` (What comes next, step 1).
2. **One live task in the runner.** This bills the operator's account. Run one `ts-mini` R0 task with `factoryctl run T-… --runner container --attach`, then check `$FACTORY_HOME/runs/T-…/egress/proxy.ndjson` for its requests on the gateway route. Once the pin move is installed, run one again on the new pin, before the G2 sample.
3. **T-0020** is admitted from an issue and still `RECEIVED`: run it or cancel it.
4. **One attended host run** (`factoryctl run T-… --attach`, without `--runner container`) is the first check, on macOS, of `v0.18.0`'s sandbox rule that keeps a session's commands out of its config directory.
5. **Before the G2 sample:** reset both fixture mirrors to the frozen release. `v0.15.0` changed both fixture bases. Use `node scripts/mirror-fixture.ts NAME --footprint --factory-ref TAG --push --reset --rulesets`.

## What comes next

1. **The pin move** (`v0.28.0`): #83 is open from `claude/epic-cannon-akxfwy`. It changes the Claude Code and SDK pin, a guardrail, so the operator clicks its merge once CI is green.
   - **Done on 2026-11-13:** `main` (through #78) merged into the branch; npm's tags and the SDK pairing re-checked (0.3.306's `claudeCodeVersion` is 2.1.306; `stable` is now 2.1.311); the advisory check (one new advisory, fixed in 2.1.251, affects neither pin); `pnpm install --frozen-lockfile` with the age gate on; every suite; CHANGELOG, STATUS, the threat model and this file. The PR body carries the probe results.
   - **Newer versions** wait for the next §11 re-check (the operator's decision of 2026-10-25).
   - **Live checks** that only a real session shows: tighter Bash checks in 2.1.306 that become denials under `dontAsk`. The live `ts-mini` R0 runner task and the attended host run (Waiting on the operator) are where they show; a denial there is a finding for the next release.
   - **After the merge:** the `release` workflow tags and publishes `v0.28.0` once `ci` passes on the merge commit. The visible eval suite runs on that push too (the merge changes `config/`); it must pass before the operator installs the release. Then the operator installs and uses it, runs `doctor`, puts their own `claude` at 2.1.306 for `takeover`, and runs the live checks below. Record the install in STATUS's Factory release row.
2. **A flaky holdout case:** since 2026-11-01 the nightly holdout suite fails `triage-ci-config-r3` about one run in three (score 0.33: the triager was dispatched, but the reply had no closing `RESULT:` line the regex accepts). The runs keep no transcript. Find out whether the reply's format or the tier is wrong, before the freeze, since the G2 sample runs on the frozen system.
3. **Parallel items:** P2-10, P2-11, P2-13 and P2-14 are done; P2-12 stays stopped.
4. **The freeze and G2.**
   - Tag the frozen release. The operator then runs the G2 procedure in the operator guide's Gate G2 section:
     - `gate G2 --begin`;
     - the 15-attempt sample;
     - the seeded suite;
     - `drill serve-kill`;
     - the drift, restore and kill-switch drills;
     - `factoryctl gate G2`.
   - Open the `gates/G2` evidence PR and STOP for the operator's signature (G2-7). R2 auto-merge stays off.
5. **Phase 3** only after G2 is signed (Appendix A, Phase 3 kickoff).

## How the operator and the agent work

- **The operator** is the repository owner. They:
  - merge every PR that changes a guardrail (below), and run every live task;
  - run the operator-only commands, which refuse inside Claude Code: `release install` and `use`, `approve`, `unhalt`, `reject`, `takeover`, `replica init`, `restore`, `prune`, `onboard`, `offboard`, and `drill kill-switch` and `serve-kill`.
- **Commands for the operator:** step by step. Their shell is zsh, where `#` starts no comment, so a command block carries no inline comments. Never ask them to paste or echo a token.
- **One PR at a time, from the session's branch:**
  1. Commit and push, open the PR, then push a STATUS commit with the PR's number. The cancelled CI run on the superseded commit is expected.
  2. Watch the PR until it merges.
  3. After the merge, restart the branch from `main`.
- **Who merges (the operator's decision of 2026-10-24):**
  - **The agent merges** a PR once CI is green on its latest commit, the branch is up to date with `main`, no review thread is open, and `pnpm check` passed locally.
  - **The operator merges** a PR that changes a guardrail:
    - the hooks or the guard (`plugin/hooks/`);
    - `policies/`;
    - the runner's managed settings, seccomp profile or egress proxy;
    - the credential gateway;
    - `.github/workflows/`;
    - the governance and verdict code;
    - the Claude Code or Agent SDK pin.

    The agent gets such a PR green, then tells the operator in one line what it changes in the guardrails.
- **Every core PR** bumps the version in `plugin/.claude-plugin/plugin.json`, both profiles' `factory_release`, and a dated CHANGELOG section with its compare link. `pnpm check:release` checks them.
- **STATUS:** IDs, PR links, release tags, commit SHAs taken from git (never typed from memory) and aggregates. A plan change goes through an ADR; a fallback or deviation gets a row in the deviations log.
- **Before a push:** `pnpm check`, and `pnpm test:gates` for anything near the pipeline, gates or fixtures. Run the heavy suites one at a time: run alongside one another, they starve the kill-point suite's timing.

## Cloud-session notes

These apply only to a Claude Code session in a cloud container; a local session on the Mac needs none of them:

- **Docker:** if Docker has stopped, restart it, then wait for `docker info` to answer:

  ```bash
  rm -f /var/run/docker/containerd/containerd.pid /var/run/docker.pid /var/run/docker.sock
  dockerd > /tmp/dockerd.log 2>&1 &
  ```

- **Container suites:** `pnpm test:gates` needs `FACTORY_GATES_CA_FILE` (the container's CA bundle) and `FACTORY_GATES_FETCH_NETWORK=host`. `pnpm test:runner` needs `FACTORY_EGRESS_UPSTREAM="$HTTPS_PROXY"`. The first runner run builds the image, which takes several minutes.
- **The plan:** Phase 2 revision 2 is summarised in STATUS's Current phase row and the deviations log, and its remaining steps are above. It lived in the earlier session's plan file, which is not in this repository.
- **GitHub:** a cloud session has no `gh`; it uses the GitHub MCP tools for PRs, checks, merges and releases. To watch a PR, subscribe to its activity and keep one safety-net check-in while it waits.
- **The age gate:** on a branch whose lockfile names packages younger than 7 days, every `pnpm` command refuses to run. Never relax `minimumReleaseAge` to get past it; run the tools from `./node_modules/.bin/` for partial checks, or wait for the date.
