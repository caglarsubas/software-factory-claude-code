# Operator guide

How to install, run, approve, recover and stop the factory in Phase 0 and Phase 1. One operator runs one task at a time, attended, on a macOS, Linux or WSL2 host. Every command is `factoryctl`; [`controller/README.md`](../../controller/README.md) describes what each stage does, and the [threat model](threat-model.md) explains why the guardrails are there.

## Install

### Prerequisites

- **Node and pnpm:** Node 24 LTS (the pin is in `.node-version`) and pnpm from `packageManager` (`corepack enable`).
- **Tools:** git, plus Docker or Podman, running. The gates run in containers; set `FACTORY_CONTAINER_ENGINE=podman` for Podman.
- **Sandbox:** Claude Code's Bash sandbox, which every session requires:
  - Linux: `bubblewrap` and `socat`.
  - macOS: `sandbox-exec`, built in.
  - Native Windows is unsupported because it runs unsandboxed.
- **Anthropic Console:** a workspace with a spend limit, and an API key for it.
- **GitHub access, until the factory GitHub App replaces it:** a fine-grained token, `FACTORY_GITHUB_TOKEN`.
  - Scope it to the target repositories only, with contents and pull requests write.
  - It never needs workflows or administration permission.

### Credentials

Credentials never go into an environment variable a session could inherit, and never into a file in a repository.

```bash
export FACTORY_HOME=~/.factory          # the default; run state lives here, outside every repository
mkdir -p -m 700 "$FACTORY_HOME/secrets"
install -m 600 /dev/stdin "$FACTORY_HOME/secrets/anthropic.key"   # paste the Console key, then Ctrl-D
unset ANTHROPIC_API_KEY                 # it would override the key file
```

Sessions authenticate through `apiKeyHelper`, which reads that file. Every session is denied the file, by Read rules and by the sandbox.

`FACTORY_GITHUB_TOKEN` stays in the shell that runs `factoryctl`. It reaches only the `git push` from the mirror and the PR calls. Without it, a run pushes nothing and opens no PR. On GitHub Enterprise, set `FACTORY_GITHUB_API_URL` to its API: `factoryctl` sends the token only over https.

### Install a release

Tasks run an installed, read-only release, never a working checkout. A PR to the factory therefore never judges itself (ROADMAP §3.3).

```bash
git clone https://github.com/caglarsubas/software-factory-claude-code.git && cd software-factory-claude-code
git fetch --tags && pnpm install --frozen-lockfile
pnpm factoryctl release install v0.1.0   # export the tag's tree, install its locked deps, pin it
export PATH="$FACTORY_HOME/bin:$PATH"   # factoryctl now runs from the pinned release
factoryctl doctor                       # no line may say "fail"
```

`release install` does the following:

1. Exports the tagged commit into `releases/<sha>/`.
2. Installs the release's own locked runtime dependencies, with lifecycle scripts off.
3. Records digests in `RELEASE.json` and makes the directory read-only.
4. Moves the pin (`$FACTORY_HOME/current`) to the new release.
5. Writes `$FACTORY_HOME/bin/factoryctl`.

Commands that move the pin refuse to run inside a Claude Code session; only the operator moves the pin.

`doctor` checks the following:

- the Node, Claude Code and Agent SDK pins;
- the API key file's permissions, and that `ANTHROPIC_API_KEY` is unset;
- the container engine and the sandbox prerequisites;
- that the installed release is intact;
- that the kill switch is off.

## Releases

A release is a version tag on `main` whose version equals `plugin/.claude-plugin/plugin.json` and has its own section in [`CHANGELOG.md`](../../CHANGELOG.md). `pnpm check:release` holds the two together on every PR.

1. **Bump.** A PR sets the new version in `plugin.json`, moves the `[Unreleased]` notes into a dated section for it, adds its link reference, and states any **Breaking** change for you.
2. **Tag**, once that PR is merged and `ci` is green on the merge commit:

   ```bash
   git switch main && git pull --ff-only
   git tag -a v0.2.0 -m "v0.2.0" && git push origin v0.2.0
   ```

   The `release` workflow then checks the tag against `plugin.json` and the changelog, waits for `ci` to pass on the tagged commit, and publishes the GitHub release with the changelog section as its notes. A tag that does not match fails the workflow, and no release is published.
3. **Install and pin** it on your machine, as in [Install a release](#install-a-release): `git fetch --tags`, then `pnpm factoryctl release install v0.2.0` from your checkout. `factoryctl doctor` must then show no `fail`.
4. **Roll back** with `factoryctl release use v0.1.2`: any installed release can be pinned again. Tasks keep the event history they ran on, so check the changelog's **Breaking** notes before you roll back across them.

Tag and pin only from your own terminal: `release install` and `release use` refuse to run inside a Claude Code session.

## Admit a target

A repository becomes a factory target only when it has all three of these:

1. **A test command that passes inside the gate image.** Passing in the repository's own CI is not enough: the gates run the test command in the gate image, so it must pass there.
2. **CI.** The repository has its own CI, which runs on every PR.
3. **A protected default branch.** For this repository, that protection is the ruleset in [`.github/rulesets/main.json`](../../.github/rulesets/main.json), imported under Settings → Rules → Rulesets.

Admitting a target changes nothing on GitHub by itself: agents never push or hold credentials, and `factoryctl` performs every GitHub side effect.

## Run a task

```bash
factoryctl task create --profile PROFILE.yaml --title "Add cursor pagination for orders" \
  --body-file task.md --untrusted       # --untrusted for any text you did not write yourself
factoryctl run T-0001                   # until the task needs a human or ends
factoryctl status                       # every task; `status T-0001` for one
```

A run goes triage → spec → build → gates → code and security review → approve → summarize → publish. It stops at `NEEDS_HUMAN` with a gate:

- `gate: spec`: the spec asks for a human, or the change looks R3 or Restricted before any code is written.
- `gate: merge`: always, in Phase 0 and Phase 1. The PR is open on the target and a human merges every tier.

The evidence lives in `$FACTORY_HOME/runs/T-0001/`:

- **Spec:** `spec.md` and `spec.yaml`.
- **Results:** `gates.json`, `review-code.json`, `review-security.json`, `verdict.json` and `manifest.json`.
- **Sessions:** `transcripts/`, the recorded sessions.
- **Builder report:** `work/build/build-report.md`. It is for you only, and the judges never see it.

`manifest.json` holds digests of every artifact, the commits judged, the release and its commit, the model IDs and the cost per stage.

### Watch, pause and take over

- **Watch:** `factoryctl run T-0001 --attach`, or `resume --attach`. You see a line for each message as the session works: what it says, each tool call with the file or command it touches, tool errors, and each session's result with its cost.
- **Pause:** `factoryctl pause T-0001 [--reason …]`. The task stops before its next step, once the step in flight has committed. Nothing fails, and the task shows `(paused)` in `status`.
  - `run` refuses a paused task; `factoryctl resume T-0001` lifts the pause and continues.
  - To stop at once, use `cancel`, which ends the task, or `halt`, which stops everything.
- **Take over:** `factoryctl takeover T-0001` opens your own Claude Code in the task's worktree. It resumes the last live build session if there is one, and starts a new session if there isn't.
  - **What it runs under:** the walls of a build session.
    - Settings, plugin and guard come from the installed release; only the release's settings apply (`--setting-sources ""`).
    - The sandbox is required.
    - The environment is allowlisted: no token or key from your shell.
    - The permission mode is `auto`, because you are at the keyboard. It is never `bypassPermissions`.
  - **Version check:** it refuses to start unless `claude --version` (or `FACTORY_CLAUDE_BIN`) is the pinned Claude Code.
  - **When you exit:** your changes, committed or not, become the candidate, and the task goes back to `BUILDING`. `factoryctl resume T-0001` then runs the gates, every review, the approval, the summary and the push again on your commits, to the same PR. A takeover result is never merged on your word alone.
  - **Not metered:** your session's cost is not charged to the task.
  - **Not inside Claude Code:** `takeover` refuses to run inside a Claude Code session.

## Approve

- **Spec gate:** read `spec.md` and `spec.yaml`, then approve and continue:

  ```bash
  factoryctl approve T-0001 --gate spec --reason "scope and acceptance criteria reviewed"
  factoryctl resume T-0001
  ```

  `approve` refuses to run inside a Claude Code session (`CLAUDECODE` set): an agent never approves its own work. The approval is bound to the spec you read: if the spec runs again, the task stops at the spec gate for a new approval.

- **Merge gate:** review the PR on GitHub (the diff, the factory's summary, the gate results) and merge it yourself, or close it. Then run `factoryctl resume T-0001`: it reads the PR and ends the task `DONE` when it was merged, or `FAILED` as `human_rejected` when it was closed without a merge.
  - `factoryctl approve --gate merge` deliberately does nothing.
  - From Phase 2 the `policy-check` workflow requires your GitHub review on R3 changes.

- **Reject:** when you will not take a task's result, at either gate, end it:

  ```bash
  factoryctl reject T-0001 --reason "solves the wrong problem"
  ```

  The task fails as `human_rejected`; close its PR on GitHub yourself. `reject` refuses to run inside a Claude Code session.

## Recover

| Situation | What to do |
|---|---|
| `factoryctl` crashed, was killed, the host rebooted, or you pressed Ctrl-C | `factoryctl resume T-0001`. Every step commits its files through an event, so a crash leaves each step committed or not. The run continues from the first step that is not, a file half-written by the crash is rolled forward or removed, and a transition lost in the crash is repaired. A push or PR the crash interrupted is looked up before anything runs: it is recorded if it happened and made later if not, never twice. Session processes and gate containers the dead run left behind are stopped. |
| You edited or removed a file in `runs/T-0001/` | Its step runs again on the next `resume`, and so does every step that read it. A spec that changes needs your approval again. |
| "T-0001 was started by a factoryctl without the commit protocol" | The task began on v0.1.x. Finish it with that release (`factoryctl release use v0.1.2`), or create a new task. |
| "T-0001 is running (pid …)" | Another `factoryctl` holds the run lock. A lock whose process has died, or whose pid now belongs to another process, is cleared on the next run; `halt`, `cancel` and `reject` never signal such a pid. |
| A task `FAILED` | `factoryctl report T-0001` gives its category, one of the ten in [the taxonomy](#failure-taxonomy-and-weekly-review), and the cost of each stage. A failed task is final: fix the cause, then create a new task. |
| A task should stop for now | `factoryctl pause T-0001`; it holds before its next step until `factoryctl resume T-0001`. |
| A task needs a hand | `factoryctl takeover T-0001`; your result goes back through the gates and reviews on `resume`. |
| A task should stop for good | `factoryctl cancel T-0001`. A running session is signalled and the task ends at once. |
| A new release misbehaves | `factoryctl release use v0.1.0` pins an earlier installed release; `factoryctl release status` lists them and verifies each one's files. |
| `release status` or `doctor` says a release was modified | Do not use it. Remove it with `chmod -R u+w` and `rm -rf`, then install the tag again. |

The event store (`$FACTORY_HOME/factory.db`) is append-only. Never edit it. To keep a copy, back up the whole `$FACTORY_HOME` while no task runs.

## Budgets and limits

Every task runs inside four limits (P1-01):

| Limit | What happens |
|---|---|
| The task's budget, by tier | The task fails as `budget_exceeded`. Before triage the task is budgeted at the highest tier; afterwards at the highest tier any step has found. |
| A session's share of that budget | The session stops at its `maxBudgetUsd`, and the task fails as `budget_exceeded`. |
| 90 minutes of active time | The task fails as `wall_clock`. Time spent waiting for you at a gate does not count. |
| The target's monthly cap (`budgets.monthly_usd` in its profile) | The task **pauses**: a run stops before its next step and the task keeps its state. Resume it next month, or after raising the cap. |

The Console workspace's spend limit stays the backstop behind all four.

Tier budgets start at the values in `policies/budgets.yaml`. While a tier has fewer than 20 live runs that reached the merge gate, its budget is the most any of them cost × 1.5, never below the initial value; after 20 runs it is frozen. To see the budgets and each target's spend this month, and to record them for G1-5:

```bash
factoryctl budgets   # writes $FACTORY_HOME/budgets/calibration.json
```

### Remediation rounds

A reviewer's blocking finding first goes to the refuter, which tries to prove it wrong. A finding it refutes stops blocking. One it upholds, or cannot decide, still blocks. `refutations.json` holds each answer and its evidence.

When the gates fail, or a blocking finding survives the refuter, the builder gets another round, with the failures in its prompt. The task stops when:

- the same failure comes back after a round (`gate_fail` or `review_block`);
- three remediation rounds, four builds in all, did not clear it.

A gate that errored, rather than failed, is an infrastructure problem: the task fails as `gate_fail` without another round. `factoryctl report T-0001` shows each round's sessions; `rounds/<n>/` in the run directory holds each later round's files.

## Component evals

`plugin/evals/` holds the component eval suite (P1-05), run by `claude plugin eval`. Each case sends one judgment agent a fixed request: a pass case it must accept, or a block case it must stop. Cases are tagged with the agent (`role:`), the expected outcome (`expect:pass` or `expect:block`) and where their code comes from (`target:fixture` or `target:self`).

- **When they run:** the `factory-evals` workflow runs the suite on every push to `main` that changes the plugin, policies or config.
  - On weekday nights it runs the held-out cases (`plugin/evals-holdout/`) and a smoke run of one live fixture task to the merge gate, capped at $1.50. On Mondays it also runs the visible suite.
  - It never runs on a pull request, so a fork never reaches the key.
- **Setup, once:**
  1. Create the `software-factory-ci` workspace in the Anthropic Console with a $50 monthly spend limit, and an API key in it.
  2. Add the key as the repository secret `ANTHROPIC_API_KEY`: Settings → Secrets and variables → Actions → New repository secret.
- **Run them yourself:** `claude plugin eval plugin --ablation none --allow-tools Read --trust-plugin --threshold 0.8` from the repository root. A full run costs about $1.50.
- **Rules (`pnpm check:evals`):**
  - every judgment agent has a pass and a block case;
  - every case checks that it dispatched the plugin's own agent;
  - 15–30% of cases are held out;
  - a pull request may not change an agent or rubric together with the evals that judge it.
- **Capture:** `factoryctl eval capture T-0001` writes a run's judgment stages as candidate cases under `$FACTORY_HOME/evals/captured/`, each with the answer the run observed. Decide whether that answer was right, set `expect:`, and move a `target:fixture` or `target:self` case into `plugin/evals/`. A `target:private` case holds a private target's code: it never enters this repository.

## Telemetry and the alias alarm

`factoryctl report T-0001` shows each stage's cost, tokens and minutes from the event store, telemetry or not. A session killed before it reported shows as `✗ killed`, charged its cap.

To also export Claude Code's OpenTelemetry metrics and events, run a collector on this machine and point the factory at it:

```bash
export FACTORY_OTEL_ENDPOINT=http://127.0.0.1:4318   # loopback only; the collector forwards with its own credentials
export FACTORY_OTEL_PROTOCOL=http/protobuf           # or grpc, http/json
```

Every session then exports metrics and events. Resource attributes name its task, stage, label, round, tier, agent and release (`factory.task_id`, `factory.stage`, …). Prompt and response text stay redacted. A remote endpoint or one with credentials in it is refused: a session must never hold a credential or send data off the host. `doctor` shows the setting.

**The alias alarm** needs no telemetry. Every session reports the model IDs it ran on. An `alarm` event is recorded, and printed as `ALARM`, when either is true:

- the ID is not one that `config/factory.yaml` pins;
- an alias now resolves to an ID its earlier live sessions never ran on.

The task continues. `report T-0001` lists its alarms, and `doctor` warns for 30 days. Check whether the change was yours (a new pin) before you trust the run's reviews.

## Failure taxonomy and weekly review

Every failed task carries exactly one category (P1-07):

| Category | Cause |
|---|---|
| `gate_fail` | the gates failed, or the builder recorded a failure or made no change |
| `review_block` | the approver rejected the change |
| `budget_exceeded` | a session reached its budget |
| `max_turns` | a session reached its turn limit |
| `schema_invalid` | a stage's answer did not match its schema |
| `permission_denied` | the builder failed or made no change while the guard denied its tool calls |
| `api_error` | a session or `factoryctl` itself failed |
| `merge_conflict` | the task's branch moved on the remote |
| `wall_clock` | the task used up its 90 minutes of active time |
| `human_rejected` | you rejected it with `factoryctl reject`, or closed its PR without merging |

Once a week, run `factoryctl report --week 2026-W42` (the ISO week, in UTC) and add the row it prints to the weekly table in STATUS. It counts the live tasks created that week by outcome: aggregates only, which is all the public repository may hold. Replayed tasks never count.

## Kill switch v0

Use it the moment an agent does something you did not expect, or a credential may be exposed.

```bash
factoryctl halt --reason "what you saw"
```

It acts at once:

- writes `$FACTORY_HOME/HALT`;
- signals the running task, whose session aborts;
- stops every gate container and runner container;
- makes the in-process guard deny every further tool call.

While `HALT` exists, no run starts. A halted task does not fail: it stays where it stopped. Escalate by severity:

1. **The halt alone:** stops every agent action on this host. `factoryctl status` shows `HALTED`.
2. **A GitHub credential may be exposed:**
   - revoke `FACTORY_GITHUB_TOKEN` on GitHub;
   - close the factory's open PRs;
   - delete the `factory/*` branches.
3. **The Anthropic key may be exposed, or spend is running away:**
   - disable the key in the Console, or set the workspace spend limit to $0;
   - delete `$FACTORY_HOME/secrets/anthropic.key`.
4. **A merged change is bad:** revert it on the target like any other commit.

To restart, find and fix the cause, then lift the halt and continue:

```bash
factoryctl unhalt --reason "cause found and fixed"
factoryctl resume T-0001
```

`unhalt` refuses to run inside a Claude Code session. Every halt and unhalt is appended to `$FACTORY_HOME/halt.log`, and the running task records the halt as a `command` event.

The full runbook (pause, drain, App suspension, key rotation, revert) and its drill arrive with P2-07.

## Runner container

From `v0.4.0` (P2-01) a session's Claude Code can run in a runner container instead of on your machine. `factoryctl` and the Agent SDK stay on the host, with the in-process guard and every credential.

What the container gets:

- **Identity:** your uid (never root), no capabilities and a read-only root.
- **Network:** an internal network whose only exit is the task's egress proxy. The proxy allows HTTPS to the package registries and refuses your machine, private addresses and everything else. It logs each request to `$FACTORY_HOME/runs/<task>/egress/proxy.ndjson`.
- **Files:** its worktree, task and session directories at their host paths. Nothing under `$FACTORY_HOME/secrets` and no Docker socket is ever mounted.

Live runner sessions turn on with the credential gateway (P2-02), so the real API key never enters a container; until then `run` keeps sessions on the host.

Check the image and its controls on your machine at each release (it needs Docker):

```bash
pnpm test:runner
```

On Linux hosts with AppArmor, the runner is AppArmor-unconfined so that its Bash sandbox can create namespaces. On Ubuntu 24.04, also allow unprivileged user namespaces: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Docker Desktop on a Mac needs neither.

## Gate G0

The operator signs each gate by approving its evidence PR. For G0, take these steps:

1. **Prepare the fixtures.** Create the throwaway repositories `factory-fixture-ts-mini` and `factory-fixture-py-mini`, then push each fixture's deterministic base:

   ```bash
   FACTORY_GITHUB_TOKEN=… node scripts/mirror-fixture.ts ts-mini --push
   FACTORY_GITHUB_TOKEN=… node scripts/mirror-fixture.ts py-mini --push
   ```

2. **Install and check the release.** Install `v0.1.0` as above; `factoryctl doctor` must show no `fail`.
3. **Snapshot your checkouts.** From your factory checkout, run `factoryctl gate G0 --begin`. Add `--checkout DIR` for every other checkout of yours you want held to "byte-identical".
   - Leave these checkouts alone until `factoryctl gate G0` runs.
   - Only `.git/index`, the stat cache that `git status` rewrites, is outside the comparison.
4. **Run one task per fixture to its PR.** Use the fixture files from the release, so the profiles cannot drift:

   ```bash
   R="$FACTORY_HOME/current/fixtures/targets"
   factoryctl task create --profile "$R/ts-mini/profile.yaml" --title "Add cursor pagination for orders" --body-file "$R/ts-mini/tasks/orders-pagination.md" --untrusted
   factoryctl task create --profile "$R/py-mini/profile.yaml" --title "Add a low-stock report" --body-file "$R/py-mini/tasks/low-stock-report.md" --untrusted
   factoryctl run T-0001 && factoryctl run T-0002   # approve a spec gate if one stops a run
   ```

5. **Run the gate.** `factoryctl gate G0` checks G0-1 to G0-4 and writes `$FACTORY_HOME/gates/G0/evidence.json` and `evidence.md`.
   - G0-1: both dry runs reached the merge gate, with live sessions, the installed release, a PR on the fixture repository and a manifest that verifies.
   - G0-2: the released guard denies every bypass variant.
   - G0-3: your checkouts and the release are byte-identical, and every session's env was exactly the allowlist.
   - G0-4: factory CI is green on the release commit, and `doctor` confirms the pins.
6. **Open and sign the evidence PR.** Open the `gates/G0` PR: `evidence.md` is its body, and it updates the Gate G0 table in STATUS. Approving it signs G0-5, which confirms the default protected globs and tier budgets the evidence lists.

`evidence.md` holds IDs, links and aggregates only, because it goes into this public repository. `evidence.json` stays in `$FACTORY_HOME`.

## Gate G1

G1 closes Phase 1. `factoryctl gate G1` checks its five automated criteria from the event store, the run directories, the release and GitHub's check runs; G1-6 is your signature.

1. **Open the evidence window.** From your factory checkout, run `factoryctl gate G1 --begin` (add `--checkout DIR` for each other checkout of yours). Leave those checkouts alone until the gate runs; `.git/index` is outside the comparison.
2. **Run at least one counted task inside the window.** Any R0–R1 task, to its merge: `run`, review, merge, then `resume` so the task ends `DONE`.
3. **Record the tier budgets.** `factoryctl budgets` writes `$FACTORY_HOME/budgets/calibration.json` from the P1-01 rule. Run it after the last task: G1-5 fails on a record older than the event store.
4. **Run the gate.** `factoryctl gate G1` writes `$FACTORY_HOME/gates/G1/evidence.json` and `evidence.md`:
   - G1-1: the release's kill-point suite has at least 10 points, and `ci` passed on the release commit.
   - G1-2: at least 5 R0–R1 tasks merged across 2 or more targets, live, on an installed release, each with per-stage tokens, minutes, cost, rounds and review findings.
   - G1-3: your checkouts and the release are byte-identical since `--begin`, at least one counted task ran inside the window, and every session's env was exactly the allowlist.
   - G1-4: the `factory-evals` suite (`evals`) passed on the release commit.
   - G1-5: the recorded tier budgets equal the P1-01 rule applied to the event store now.
5. **Open and sign the evidence PR.** Open the `gates/G1` PR with `evidence.md` as its body; it fills STATUS's Gate G1 table. Approving it signs G1-6, after which R0–R1 auto-merge may be enabled for Phase 2.

`evidence.md` holds IDs, links and aggregates only. `evidence.json` stays in `$FACTORY_HOME`.

## Where things live

| Path in `$FACTORY_HOME` | Contents |
|---|---|
| `factory.db` | the append-only event store |
| `runs/<task>/` | the evidence bundle and transcripts |
| `releases/<sha>/`, `current`, `bin/factoryctl` | installed releases, the pin, the shim |
| `mirrors/`, `worktrees/<task>/`, `sessions/<task>/` | bare mirrors, per-task clones, per-task session homes |
| `procs/` | the running sessions' processes, so a run that dies leaves none behind |
| `secrets/` | the API key file; never readable by a session |
| `gates/<gate>/` | gate snapshots and evidence |
| `HALT`, `halt.log` | the kill switch and its audit trail |
