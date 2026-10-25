# Session handover

A new Claude Code session picks up the factory's development from here. Read this file, then [`ROADMAP.md`](ROADMAP.md) (§2.6 and §3 twice), [`STATUS.md`](STATUS.md) and the [operator guide](operator-guide.md). STATUS is the record of what is done; this file holds what a new session cannot recover from the code alone: where the work stands, what comes next, and how the operator and the agent work together. Update it whenever one of those changes, and keep it free of private target names, task text, findings and secrets, as for STATUS.

## Starting a new session

The work moves between sessions and Claude accounts, and from 2026-10-25 from cloud sessions to a Claude Code session on the operator's Mac. Nothing but this repository carries over: no reminder, scheduled check-in, PR subscription or plan file from an earlier session reaches a new one.

1. Read [`CLAUDE.md`](../../CLAUDE.md), then this file to the end, then STATUS's Current phase row and the deviations log.
2. Check GitHub: open PRs, the latest release (`v0.27.0` at the handover) and `ci` on `main`. At the handover no factory PR was open; three old dependabot PRs were (#5, #22 and #34). They are the operator's to close or rebase; #34 changes `.github/workflows/`, a guardrail.
3. Branches:
   - `claude/epic-cannon-akxfwy` holds the pin move (What comes next, step 1). Its PR opens on or after 2026-10-28 02:38 UTC.
   - Every other `claude/*` branch is merged into `main`. Start new work on a fresh branch from `main`.
4. On the first local session, work through [Moving the work to the operator's Mac](#moving-the-work-to-the-operators-mac) before anything else.
5. Ask the operator for the one open decision: the pin move's version (What comes next, step 1).

## Moving the work to the operator's Mac

The development work continues in Claude Code on the operator's Mac, in their checkout, under another Claude account. The factory's own runs already live there (`$FACTORY_HOME`, default `~/.factory`). The switch is complete when every step below is done; record each in STATUS (the Factory release row, the deviations log) only where it changes what STATUS says.

### Once, by the operator, in their own terminal

1. **The toolchain**, as the operator guide's Prerequisites list:
   - Node 24.21.0 (`.node-version`) and `corepack enable` for pnpm 12.6.0 (`packageManager`);
   - Docker Desktop, running; git; `gh`, signed in with access to this repository (`gh auth status`);
   - Claude Code, signed in to the new account. Its own version does not matter for development; `takeover` checks it against the pin.
2. **The checkout:**

   ```bash
   cd ~/path/to/software-factory-claude-code
   git checkout main
   git pull --prune --tags
   pnpm install --frozen-lockfile
   ```

3. **The cloud-only environment:** unset `FACTORY_GATES_CA_FILE`, `FACTORY_GATES_FETCH_NETWORK` and `FACTORY_EGRESS_UPSTREAM` if a profile sets them. They exist for a cloud container's proxy; on the Mac the gates and the runner reach the network directly.
4. **The latest release,** outside Claude Code, since moving the pin refuses inside it:

   ```bash
   pnpm factoryctl release install v0.27.0
   factoryctl doctor
   ```

   `$FACTORY_HOME` keeps its secrets (the API key file, the GitHub App key, `serve.token`) and the replica; nothing moves. Give the agent `doctor`'s output for STATUS's Factory release row.

### In the first local session, by the agent

1. **A green baseline:** `pnpm check`, then `pnpm test:gates` and `pnpm test:runner`, one at a time. The full gate image (with graphifyy) builds here for the first time outside CI; the cloud could not build it.
2. **GitHub through `gh`:** `gh pr create`, `gh pr checks <n> --watch`, and `gh pr merge <n> --merge --match-head-commit <sha>` under the "Who merges" rule below. If a GitHub MCP server is configured instead, it serves the same.
3. **No scheduled check-ins:** a local session has no reminders or PR subscriptions. Dated work (the pin move on 2026-10-28) starts when the operator opens a session that day; a PR is watched with `gh pr checks --watch` while the session runs.
4. **The operator's Mac items** (Waiting on the operator) become possible from this session: the agent can run `doctor`, the live runner task and the attended host run once the operator agrees, since live runs bill their account. The operator-only commands still refuse inside Claude Code, also through `!`: the agent writes the exact command, and the operator runs it in their own terminal.
5. **Permissions:** never `bypassPermissions`. The project's `.claude/` is a protected path: a settings change there goes through a PR the operator reviews.

### Retiring the cloud

- **Cloud sessions:** nothing is left running in them (no reminder, no PR subscription). Archive them on claude.ai/code.
- **Merged branches** the cloud sessions left: `claude/awesome-gates-v2vo3h`, `claude/epic-cannon-akxfwy-p2-11` and `claude/epic-cannon-akxfwy-p2-13`. Delete them once the operator agrees: `git push origin --delete <branch>`. Keep `claude/epic-cannon-akxfwy` until the pin move merges.
- **`factory/T-0014` and `factory/T-0015`** are the factory's own task branches, merged; they are the operator's to keep or delete.
- **Cloud-session notes** (the end of this file) stay, for a session that goes back to the cloud.

## Where the work stands (2026-10-25)

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
- **The pin move** to 2.1.306 / 0.3.306 is built on `claude/epic-cannon-akxfwy` and opens on Oct 28, when pnpm's age gate accepts it. `main` at `v0.27.0` is already merged into it, so it takes `v0.28.0` unless another release comes first.
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

Every release up to `v0.27.0` is tagged and published; the operator's home has `v0.19.0` installed and pinned (STATUS's Factory release row).

- **Tagging is no longer the operator's step:** the `release` workflow tags and publishes a version when its bump merges (operator guide, Releases).
- **The backfill is done:** `v0.20.0` to `v0.25.0`, merged before the workflow existed, were tagged and published by running it by hand with each merge commit.
- **Installing stays with the operator:** `factoryctl release install`, `release use` and `factoryctl doctor`, for the releases they will run: the latest one, `v0.27.0` or the pin move's once it is out, not each in turn. Record it in STATUS's Factory release row.
- **The operator's Mac:** a local session (the Claude Desktop app, or `claude remote-control` in their checkout) can run what needs their machine: `doctor`, the live checks below, T-0020 and the mirror reset. The operator-only commands still refuse inside any Claude Code session.

1. **One live task in the runner.** This bills the operator's account. Run one `ts-mini` R0 task with `factoryctl run T-… --runner container --attach`, then check `$FACTORY_HOME/runs/T-…/egress/proxy.ndjson` for its requests on the gateway route. Once the pin move is installed, run one again on the new pin, before the G2 sample.
2. **T-0020** is admitted from an issue and still `RECEIVED`: run it or cancel it.
3. **One attended host run** (`factoryctl run T-… --attach`, without `--runner container`) is the first check, on macOS, of `v0.18.0`'s sandbox rule that keeps a session's commands out of its config directory.
4. **Before the G2 sample:** reset both fixture mirrors to the frozen release. `v0.15.0` changed both fixture bases. Use `node scripts/mirror-fixture.ts NAME --footprint --factory-ref TAG --push --reset --rulesets`.

## What comes next

1. **The pin move** (a core release of its own, `v0.28.0`), opening on or after 2026-10-28 02:38 UTC. The branch `claude/epic-cannon-akxfwy` holds it. It changes the Claude Code and SDK pin, a guardrail, so the operator clicks its merge.
   - **Version:** the newest npm `stable` at or above 2.1.305 that is at least 7 days old (`minimumReleaseAge`), with the SDK whose `claudeCodeVersion` matches. 2.1.304 fails behind the gateway when ToolSearch is outside a session's tools.
   - **The open decision:** on 2026-10-24 npm's `stable` was 2.1.308 (published 2026-10-22) and `latest` 2.1.310. The branch pins 2.1.306 (published 2026-10-21), whose probes are done. On Oct 28 only 2.1.306 clears the age gate; 2.1.308 clears it from Oct 29 and would need the probes again. The agent recommended staying on 2.1.306 and taking newer versions at the next §11 re-check; ask the operator before choosing.
   - **State of the branch (2026-10-24):** `main` at `v0.27.0` (31745df) is merged in as 8748d13, with no conflict and the lockfile untouched. Until the age gate opens, pnpm refuses every script on this branch (the lockfile names packages younger than 7 days), so checks run through `./node_modules/.bin/` against the old install: `tsc` and `eslint` pass, and Vitest fails only the doctor and runner tests that compare the installed SDK (0.3.286) with the new pin.
   - **Bump the pin in:** `config/factory.yaml`, `controller/package.json` and the lockfile, `runner/Dockerfile` (URLs and checksums), the CI workflows' `npx` lines, and the `verify-tools` test fixture.
   - **Adapt to:**
     - tool search through the gateway;
     - OTel's new `prompt_text`;
     - the SDK's `--flag=value` argv;
     - structured output on a refusal;
     - tighter Bash checks that become denials under `dontAsk`.
   - **Re-run:** every suite, then the eval suite on the release commit.
   - **The branch** holds two commits on the old `main` 76c3033: 52476d1 moves the pin to 2.1.306 / 0.3.306, and 69c3534 keeps a flagged request on the session's pinned model (`availableModels` with `switchModelsOnFlag: false`, host and runner). Their messages carry the probe evidence.
   - **The age gate** accepts every 0.3.306 package in the lockfile from 2026-10-28 02:37:47 UTC (win32-arm64 was published last).
   - **Steps:**
     1. If `main` moved since 31745df, merge it into the branch again with a merge commit, since the branch is pushed. Resolve the lockfile with pnpm, never by hand.
     2. Re-check npm's dist-tags and that 0.3.306 is still the SDK for 2.1.306. Re-run the advisory check for anything newer than STATUS's pre-freeze row.
     3. Run a plain `pnpm install --frozen-lockfile` with the gate on: it must pass. Then run `pnpm check` and `pnpm exec vitest run --config vitest.gates.config.ts controller/src/plugin/workflow.int.test.ts controller/src/session/models.int.test.ts`.
     4. Release it:
        - CHANGELOG: the pin move and the flagged-request rule;
        - STATUS: the pin row, the platform log's action, and the release;
        - the threat model: the ASI02 and ASI05 residuals that cite fixes missing from 2.1.286 now say 2.1.306 carries them, plus the model-fallback control;
        - HANDOVER: the operator's steps (the eval suite passes on the release commit before the tag; then tag, install and use the release, run `doctor`, put their own `claude` at 2.1.306 for takeover, and run one live `ts-mini` R0 runner task and one attended host run).
     5. Open the PR with the probe results in its body. CI's runner jobs and gates job are the first container runs of 2.1.306.
2. **Parallel items:** P2-10, P2-11, P2-13 and P2-14 are done; P2-12 stays stopped.
3. **The freeze and G2.**
   - Tag the frozen release. The operator then runs the G2 procedure in the operator guide's Gate G2 section:
     - `gate G2 --begin`;
     - the 15-attempt sample;
     - the seeded suite;
     - `drill serve-kill`;
     - the drift, restore and kill-switch drills;
     - `factoryctl gate G2`.
   - Open the `gates/G2` evidence PR and STOP for the operator's signature (G2-7). R2 auto-merge stays off.
4. **Phase 3** only after G2 is signed (Appendix A, Phase 3 kickoff).

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
