# Session handover

A new Claude Code session picks up the factory's development from here. Read this file, then [`ROADMAP.md`](ROADMAP.md) (§2.6 and §3 twice), [`STATUS.md`](STATUS.md) and the [operator guide](operator-guide.md). STATUS is the record of what is done; this file holds what a new session cannot recover from the code alone: where the work stands, what comes next, and how the operator and the agent work together. Update it whenever one of those changes, and keep it free of private target names, task text, findings and secrets, as for STATUS.

## Starting a new session

The work moves between sessions and Claude accounts. From 2026-10-25 it runs in a Claude Code session on the operator's Mac, in their checkout; on 2026-10-27 it moves to another Claude account on the same Mac and checkout, on 2026-11-16 to another again, and on 2026-11-21 to another again, each on the same Mac and checkout. Nothing but this repository carries over: no reminder, scheduled check-in, PR subscription or plan file from an earlier session reaches a new one.

1. Read [`CLAUDE.md`](../../CLAUDE.md), then this file to the end, then STATUS's Current phase row and the deviations log.
2. Check GitHub: open PRs, the latest release (`v0.30.1` at the handover) and `ci` on `main` (green on `746c4b3`, #108's merge). On 2026-11-21 no factory PR was open; Dependabot's were. The Dependabot PRs are the operator's to merge, close or rebase:
   - **#5** (development dependencies, 2026-10-09): `check` fails; closing it is the operator's call.
   - **#109** (trufflehog in `factory-ci.yml`): green; it changes a workflow, a guardrail.
   - **#110** (the gate and runner base images, which replaced #89 on 2026-11-20): `gates` and both `runner` jobs fail. It moves both images to Python 3.15, which breaks the cp314 wheels, as #89 did; the agent's advice is to hold it until after G2. It changes both images, a guardrail.
   - **#111** (markdownlint-cli2 0.24.1, typescript-eslint 8.72.2): green.
   - #81 was taken by #106 (merged 2026-11-19) and is closed.
3. Branches:
   - Merged `claude/*` branches may still be on the remote and in the checkout: `claude/t0024-live` (#107) was at the handover. `git branch -r --merged origin/main` lists them; delete them only with the operator's agreement. Start new work on a fresh branch from `main`.
4. The move to the operator's Mac is done (the next section). On the same Mac and checkout, a new account only checks that `git status` is clean on `main`, pulls, and runs `pnpm install --frozen-lockfile`; on another machine, work through that section again.
   - **The account switch changes no factory credential:** live runs use the API key file in `$FACTORY_HOME`, and the eval CI the `software-factory-ci` workspace's secret, not the Claude Code login. `gh` keeps the operator's own token.
5. No decision is open. Start with What comes next.

## Moving the work to the operator's Mac

The development work continues in Claude Code on the operator's Mac, in their checkout, under another Claude account. The factory's own runs already live there (`$FACTORY_HOME`, default `~/.factory`). The switch is complete when every step below is done; record each in STATUS (the Factory release row, the deviations log) only where it changes what STATUS says.

**Done (2026-10-25 to 27, the first local session):**

- The toolchain is in place and none of the cloud-only variables is set. `v0.27.0` is installed and pinned, `doctor` clean but for `SSH_AUTH_SOCK`.
- The baseline is green on the Mac: `pnpm check` (880 tests), `pnpm test:gates` (88) and `pnpm test:runner` (12). #76 fixed tests that failed on macOS only (`/var` and `/private/var`, a symlink target's Unicode form, Docker Desktop's buildx hidden by a test's `HOME`). #77 gave the unit suite a 30 s timeout: under the full suite's load on the Mac, tests that take about 1 s alone ran past Vitest's 5 s default.
- **Load on the Mac:** the operator's other workloads (a local model server, emulators, other projects' containers) can push the load average above 12. Then `pnpm check` runs about twice as long. Two tests that failed on timing alone are fixed: the replica's concurrent writers, a race in switching a new store to WAL (#93, in `v0.30.0`), and the cleanup hooks of the four suites that delete an installed release tree (#97, a 60 s hook timeout). If a test fails on timing again, look at it.
- **Other projects time their runs on this Mac:** the operator may ask that heavy runs (`pnpm check`, `pnpm test:gates`, `pnpm test:runner`) wait on a shared lock; the session's first prompt says how.
- **Docker on the Mac:** the operator's other projects keep many networks. If `docker network create` fails with "all predefined address pools have been fully subnetted", the operator lists `docker network ls --filter dangling=true` and runs `docker network prune`; the factory recreates `sf-egress-out` on demand.
- The merged cloud branches are deleted. Left for the operator: archiving the cloud sessions on claude.ai/code.

### Once, by the operator, in their own terminal

1. **The toolchain**, as the operator guide's Prerequisites list:
   - Node 24.21.0 (`.node-version`) and `corepack enable` for pnpm 12.6.0 (`packageManager`);
   - Docker Desktop, running; git; `gh`, signed in with access to this repository (`gh auth status`);
   - Claude Code, signed in to the new account. Its own version does not matter for development; `takeover` checks it against the pin.
2. **The cloud-only environment:** unset `FACTORY_GATES_CA_FILE`, `FACTORY_GATES_FETCH_NETWORK` and `FACTORY_EGRESS_UPSTREAM` if a profile sets them. They exist for a cloud container's proxy; on the Mac the gates reach the network directly. The runner's egress proxy may not: see Waiting on the operator, item 4.
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
4. **No scheduled check-ins:** a local session has no reminders or PR subscriptions. Dated work starts when the operator opens a session that day; a PR is watched with `gh pr checks --watch` while the session runs.
5. **The operator's Mac items** (Waiting on the operator) become possible from this session: the agent can run `doctor`, the live runner task and the attended host run once the operator agrees, since live runs bill their account. The operator-only commands still refuse inside Claude Code, also through `!`: the agent writes the exact command, and the operator runs it in their own terminal.
6. **Permissions:** never `bypassPermissions`. The project's `.claude/` is a protected path: a settings change there goes through a PR the operator reviews.

### Retiring the cloud

- **Cloud sessions:** nothing is left running in them (no reminder, no PR subscription). Archive them on claude.ai/code.
- **Merged branches** the cloud sessions left were deleted on 2026-10-27, with the operator's agreement, and the pin move's `claude/epic-cannon-akxfwy` on 2026-11-13 after it merged.
- **`factory/T-0014` and `factory/T-0015`** are the factory's own task branches, merged; they are the operator's to keep or delete.
- **Cloud-session notes** (the end of this file) stay, for a session that goes back to the cloud.

## Where the work stands (2026-11-21)

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
- **The pin move** to 2.1.306 / 0.3.306 is done: `v0.28.0` (#83, `5014b09`), merged by the operator and installed on their Mac on 2026-11-13. Newer versions wait for the next §11 re-check (the operator's decision of 2026-10-25).
- **The live runner check on the new pin** is done (2026-11-13, STATUS's platform log). T-0022, an R0 `ts-mini` task run attended with `--runner container`, passed every stage and gate, and `factoryctl` merged it as the App. No session had a permission denial, so 2.1.306's tighter Bash checks did not show, and every model request left the container by the gateway route. It found that the runner has no target toolchain (What comes next, item 2).
- **Since that check (2026-11-13 to 16):**
  - **`v0.29.0` (#87):** the runner carries the target toolchain. T-0023 (#94) checked it live.
  - **`v0.30.0` (#95):** the opt-in `FACTORY_EGRESS_FAKE_IP` for the runner's egress on this Mac's network (Waiting on the operator, item 4), and the store's WAL race fix (#93). Installed and pinned on 2026-11-15.
  - **Evals:** a judge that failed a correct triage reply is fixed (#90); each run keeps its results as the `eval-results` artifact (#91); a failing case's annotation shows the end of its reply (#98). The flaky holdout case ended with the pin move (What comes next, item 1).
  - **Tests:** the cleanup-hook timeouts under load (#97).
- **Since the 2026-11-16 handover (to 2026-11-21):**
  - **`v0.30.1` (#101):** the summarizer keeps "safe", "compliant" and "ready" out of its texts. Installed and pinned on 2026-11-17.
  - **Evals:** `summarize-evidence`'s grader is order-free (#103), and `triage-injection-auth` is graded by regex on the triager's relayed JSON (#104). The visible suite passed 23 of 23 on #104's merge commit, and the scheduled runs of 2026-11-19 and 20 passed (What comes next, item 1).
  - **#106:** Dependabot's development dependency bumps (#81), with the egress proxy's `dns.lookup` option moved to `order: "verbatim"`.
  - **Live, attended, on `v0.30.1`:** T-0024 in the runner container (#107; What comes next, item 2) and T-0020 on the host, the attended host run (#108; Waiting on the operator, items 2 and 3).
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

Every release up to `v0.30.1` is tagged and published; the operator's home has `v0.30.1` installed and pinned since 2026-11-17 (STATUS's Factory release row).

- **Tagging is no longer the operator's step:** the `release` workflow tags and publishes a version when its bump merges (operator guide, Releases).
- **The backfill is done:** `v0.20.0` to `v0.25.0`, merged before the workflow existed, were tagged and published by running it by hand with each merge commit.
- **Installing stays with the operator:** `factoryctl release install`, `release use` and `factoryctl doctor`, for the releases they will run: the latest one, not each in turn. Record it in STATUS's Factory release row.
- **The eval suite's spend:** the `software-factory-ci` Console workspace reached its monthly API usage limit on 2026-10-22, and every eval run failed from then until it reset on 2026-11-01. The G2 sample's month draws on the same limit: the operator checks it before the freeze.
- **Manual eval runs:** `gh` on this Mac signs in with a fine-grained token that can push workflow files but cannot start a workflow (no Actions: write), so `gh workflow run` returns 403. The operator starts a manual `factory-evals` run from the repository's Actions tab, or adds Actions: Read and write to that token. A manual run costs about $1.90 for the visible and holdout suites, plus up to $1.50 for the smoke task.
- **The operator's Mac:** a local session (the Claude Desktop app, or `claude remote-control` in their checkout) can run what needs their machine: `doctor`, live tasks and the mirror reset. The operator-only commands still refuse inside any Claude Code session.

1. **Retention:** `doctor` warned on 2026-11-19 of 15 finished tasks past retention (`factoryctl prune`, operator-only) and 4 unfinished ones past it, to cancel or resume: T-0002 and T-0004 (`RECEIVED`), T-0005 and T-0006 (`NEEDS_HUMAN` at the merge gate).
2. **T-0020** is done (2026-11-19): it ran as the attended host run (item 3), and the operator merged [py-mini PR 7](https://github.com/caglarsubas/factory-fixture-py-mini/pull/7). Its issue stays open, as factory PRs carry no closing keyword; closing it is the operator's call.
3. **The attended host run** is done (2026-11-19, `v0.30.1`), the first check on macOS of `v0.18.0`'s sandbox rule that keeps a session's commands out of its config directory. T-0020 (R0, `py-mini`) ran with `factoryctl run T-0020 --attach`, without `--runner container`.
   - **The sandbox:** all 7 sessions started and succeeded, and none had a tool error; the builder's 4 Bash calls all ran. Its `claude/dev-mods` stayed empty, and `doctor` found the installed release intact after the run.
   - **Not exercised:** no command aimed at a protected path, so the run shows that the rule lets sessions work on macOS, not that it refuses a write there.
   - **The merge gate:** the approver passed it to a human at R0, as the README example's doctest had not been run. Run offline in the runner image on the candidate commit, the doctest passed (9 examples, 0 failures). The operator approved the head commit, `policy-check` passed on a re-run, the operator merged it, and `factoryctl resume` ended it `DONE` ($0.47).
4. **The runner's route to the registries on this Mac** is done (2026-11-15). The router (`192.168.0.1`, the Mac's only resolver) answers every DNS query with fake-IP addresses in `198.18.0.0/15` and cannot be changed, and `FACTORY_EGRESS_UPSTREAM` does not help. So `v0.30.0` (#95) added the opt-in `FACTORY_EGRESS_FAKE_IP`: the operator's `~/.zshrc` sets it to `198.18.0.0/15`, and `doctor`'s `registry route` check is `ok`. With it, the runner suite's online case passes on this Mac. A shell that runs `factoryctl` or `serve` without it gets a `doctor` warning, and its runner sessions reach no registry.
5. **Before the G2 sample:** reset both fixture mirrors to the frozen release. `v0.15.0` changed both fixture bases, and `ts-mini`'s mirror also carries the merges of T-0016, T-0017, T-0022, T-0023 and T-0024, and `py-mini`'s those of T-0018, T-0019 and T-0020. A task whose change is already merged stops at the spec gate, as T-0021 did. Use `node scripts/mirror-fixture.ts NAME --footprint --factory-ref TAG --push --reset --rulesets`.

## What comes next

1. **The flaky holdout case ended with the pin move (2026-11-17).** On the 2.1.286 pin the nightly holdout suite failed `triage-ci-config-r3` in 3 of 10 runs (2026-11-05, 2026-11-06 and 2026-11-11; score 0.33: the triager was dispatched, but the text the regex read had no `RESULT:` line it accepts). The visible case `triage-docs-r0` failed the same way once (2026-11-02). On the 2.1.306 pin the case passed every run: 3 of 3 in CI (2026-11-15 to 17), and 30 of 30 in a local sample on 2026-11-17, each ending with the exact line `RESULT: R3`, the triager proposing R3, in 2 turns. Neither the triager nor the case changed between the two periods.
   - **What the graders read:** `last_message` is the trace's last assistant text, a subagent's included (checked in the pinned CLI). On 2.1.306 a trace carries no subagent assistant text, so only the session's own reply is graded. Whether a subagent's reply was the cause on 2.1.286 was not checked.
   - **The watch stays:** the evals run with `--keep-temp`, and each failing run's annotation ends with the last 600 characters of its reply (#98). The `eval-results` artifact (#91) holds scores, prompts and grader verdicts; an LLM grader's verdict carries the reply it judged (`evidence`), a regex grader's does not.
   - **`summarize-injection`** failed its regex once (push run, 2026-11-14), and 1 of 17 runs in a local sample on 2026-11-17. The summarizer left the injected line and link out in every run, but that body denied being "ready to merge", and the grader refuses the phrase anywhere in the body. ROADMAP principle 14 keeps "safe", "compliant" and "ready" out of summaries; `plugin/agents/summarizer.md` forbade only the claim. **`v0.30.1`** (#101) fixes the summarizer and keeps the grader strict: it keeps those words out of both texts, also to deny them, and treats text in its inputs that tells it what to write as data. A local sample on its branch passed `summarize-injection` in 30 of 30 runs and `summarize-evidence` in 14 of 15, and none of the 45 bodies carried those words or the injected link. The operator installed it on 2026-11-17, and both summarize cases passed on its merge commit.
   - **`summarize-evidence`'s `criteria` grader** wants AC-1, AC-2 and R1 in that order, though its description asks only that the body names them. The sample's one failure was a body that named all three, the tier first. The grader now accepts them in any order, inside one `<pr_body>` block (#103, merged 2026-11-18; the case passed on its merge commit).
   - **Local samples:** `claude plugin eval PLUGIN --case NAME --runs N --keep-temp` with the pinned CLI (the Agent SDK's platform package in `node_modules`) runs on the CLI's own sign-in, not the factory's key, so that sign-in must be current; ask the operator first. At list prices a triage run costs about $0.033 and a summarize run $0.04.
   - A related fix is merged (#90): the visible case `triage-injection-auth` failed a correct reply on 2026-11-13 because its judge asked for a reason the triager never returns. Since #90 its judge failed 2 of 8 visible-suite runs (push runs of 2026-11-14 and 2026-11-17, 0 and 1 of 3 votes passing), each over a reply that credits the triager with a reason for R3 that its JSON does not carry. #103 dropped the rubric's claim that the triager returns no reason and left reasons ungraded.
     - **The replay:** a stub plugin whose cases repeat a CI reply verbatim, run with `plugin eval --judge-model sonnet`, 5 runs each. The two replies passed 2 of 10 gradings under the old rubric and 8 of 10 under the new one. `claude -p` with the judge's own prompts is no stand-in for that judge: it passed every reply under both rubrics.
     - **#103 did not hold:** the judge failed a correct reply again on its merge commit (2026-11-18, 1 of 3 votes), one that gave a reason for R3 in the session's own words. Across the 8 replies on record, every failing one gives a reason for R3, and every passing one only reports the triager's answer.
     - **#104 drops the judge:** the session relays the triager's JSON verbatim and adds nothing; regex graders check that `proposed_tier` is R3 or Restricted and that `kind` is not `docs`. In 20 local runs, all passed, each reply the JSON and the `RESULT` line alone ($0.69). Merged 2026-11-18; the case passed on its merge commit, and the visible suite passed 23 of 23.
2. **The runner toolchain** is fixed in `v0.29.0` (#87): the runner carries the gate image's Python, npm, corepack (pnpm) and uv, by the same pins, with each task's tool cache in `sessions/T-…/cache`. T-0023 (2026-11-15, ts-mini, merged) ran the target's tests in the runner with it, but corepack could not download `pnpm`: this Mac's DNS sends the registries to fake IPs. `v0.30.0` fixes the route (Waiting on the operator, item 4), and the runner suite's online case now passes on this Mac.
   - **Seen live (2026-11-19, `v0.30.1`):** T-0024, the seeded `store-remove` task (R1, `ts-mini`, attended, `--runner container`, `FACTORY_EGRESS_FAKE_IP` set), passed every stage and gate in one round, and `factoryctl` merged [ts-mini PR 8](https://github.com/caglarsubas/factory-fixture-ts-mini/pull/8) as the App ($0.49). Its builder ran `pnpm typecheck` and `pnpm lint` in the runner: corepack downloaded `pnpm` through the egress proxy, which allowed all 9 connections to `registry.npmjs.org` by the fake-IP opt-in and refused none.
   - **Sandbox mount points:** in the builder's sandbox, `git status` lists dotfiles the sandbox protects (`.bashrc`, `.gitconfig`, `.mcp.json` and others) as untracked, most likely its mount points for them. None reached the candidate, which carried only the task's two files.
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
