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
- **GitHub access:** the factory GitHub App, from `v0.10.0` ([GitHub App and verdicts](#github-app-and-verdicts)).
  - Without an App, a fine-grained token, `FACTORY_GITHUB_TOKEN`, pushes and opens PRs, but cannot post verdicts.
  - Scope the token to the target repositories only, with contents and pull requests write. It never needs workflows or administration permission.

### Credentials

Credentials never go into an environment variable a session could inherit, and never into a file in a repository.

```bash
export FACTORY_HOME=~/.factory          # the default; run state lives here, outside every repository
mkdir -p -m 700 "$FACTORY_HOME/secrets"
install -m 600 /dev/stdin "$FACTORY_HOME/secrets/anthropic.key"   # paste the Console key, then Ctrl-D
unset ANTHROPIC_API_KEY                 # it would override the key file
```

The key never reaches a session. From `v0.6.0` every live session calls the credential gateway in `factoryctl` with a token of its own, and only the gateway sends the key to the API (see [Credential gateway](#credential-gateway)). Sessions are denied the key file and their token files, by Read rules and by the sandbox. `takeover`, your own interactive session, still authenticates with the key file through `apiKeyHelper`.

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
- that the kill switch is off;
- the replica: set, on another volume and caught up (P2-07);
- that the runner's managed settings are what the release's policies generate (P2-08);
- with `FACTORY_GITHUB_TOKEN` set, that this repository's `main` ruleset on GitHub matches `.github/rulesets/main.json` (P2-08). The token needs Administration: read; without it the check only warns. The target repositories' rulesets and the App's permissions join this check with P2-05.

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
4. **Roll back** with `factoryctl release use v0.19.0`: any installed release can be pinned again, except across a store schema change. Since `v0.20.0` (store schema 4), earlier releases refuse the store. Tasks keep the event history they ran on, so check the changelog's **Breaking** notes before you roll back across them.

Tag and pin only from your own terminal: `release install` and `release use` refuse to run inside a Claude Code session.

## Onboard a target

From `v0.22.0` (P2-11, [ADR 0003](adr/0003-onboarding-retention-and-purge.md)) `factoryctl onboard` takes a repository on as a target. Admission accepts a repository only when it has all three of these:

1. **Every command gate green in the gate image.** Passing in the repository's own CI is not enough: the gates run the profile's commands in the gate image on every task, so they must pass there.
2. **CI of its own.** A workflow in `.github/workflows`, besides the factory's, that runs on every PR.
3. **A protected default branch:** branch protection or a ruleset. For this repository, that protection is the ruleset in [`.github/rulesets/main.json`](../../.github/rulesets/main.json), imported under Settings → Rules → Rulesets.

The profile must also be valid and name its approvers. Admission changes nothing on GitHub: agents never push or hold credentials, and `factoryctl` performs every GitHub side effect.

`onboard` is operator-only: it refuses to run inside Claude Code. It needs two things set up first:

- **The App.** See [GitHub App and verdicts](#github-app-and-verdicts).
- **Your own `FACTORY_GITHUB_TOKEN`.** A fine-grained token on the target with Contents, Workflows, Pull requests and Administration: write. It needs more than the App's token because the footprint PR carries workflow files, and the rulesets need Administration, which the App never holds.

Each run takes the target one step further, then stops where you act. You can run the same command again at any point, including after a crash.

1. **Take the inventory and run admission.**

   ```zsh
   factoryctl onboard OWNER/NAME
   ```

   It does three things:
   - reads the default branch;
   - drafts `$FACTORY_HOME/targets/OWNER__NAME/profile.yaml` from what it finds, the first time only;
   - runs admission: the commands in the gate image, then CI, then protection.

   From then on the profile is yours, and no run writes it again. If something fails, the command exits 1 and names it: fix it in the target or the profile, then run the command again.
2. **Stop and review the profile.**
   - Approvers and intake maintainers start as your GitHub login.
   - Its header lists the files the release already holds at R3, and what the inventory could not decide.
   - Set `protected_paths`, `restricted`, `invariants`, the budget and retention.

   After an edit, run step 1 again: what you confirm must be what admission passed.
3. **Confirm.**

   ```zsh
   factoryctl onboard OWNER/NAME --confirm
   ```

   It builds one commit of the footprint ([Footprint](#footprint)) and the layer below, pushes it to `software-factory/onboard`, and opens the PR.
4. **Review and merge the PR on GitHub.** The PR must pass its `gates` check. You opened it, so where the repository requires an approval yours does not count: another maintainer approves it, or you merge as an admin.
5. **Finish.**

   ```zsh
   factoryctl onboard OWNER/NAME
   ```

   It checks that the default branch holds the footprint as proposed and that `gates` passed on it. Then it applies the `factory-main` and `factory-branches` rulesets, and checks that the App reaches the repository.

   If the App does not, the command prints the installation's settings URL. Open it, go to Repository access → Only select repositories, add the repository, Save, and run the command again. The target is then active.

The layer is what onboarding writes for the people and the sessions that work in the target, beside the footprint:

- **A marked block in `CODEOWNERS`.** It goes in `.github/CODEOWNERS` if the repository has no CODEOWNERS file. The approvers own every R3 and Restricted path and the factory's files.
- **A marked section in `CLAUDE.md`.** It covers the release, `factory/**`, the R3 and Restricted paths, and `spec_dir`.
- **`.claude/rules/factory-invariants.md`:** the profile's invariants.
- **The factory's marketplace and plugin in `.claude/settings.json`**, pinned to the release. The plugin's hooks need Node 24.

The layer merges into what the target already has. `target.json` records exactly what it added, so offboarding takes that out and nothing else.

Once the target is active:

- **Tasks.** `factoryctl task create --repo OWNER/NAME --title … --body-file …` uses the confirmed profile and the target's remote.
- **Intake.** `factoryctl intake` with no profiles polls every active target whose profile has an `intake:` block.
- **Changing the profile.** Both commands refuse a profile changed since it was confirmed. To change it, or to move the target to a new release by setting `factory_release`, edit the profile and run:

  ```zsh
  factoryctl onboard OWNER/NAME --update
  ```

  It proposes the change on `software-factory/update`. After the merge, step 5 finishes it, and until then the target takes no new tasks. A closed update leaves the target as it was.
- **Checking it again.** `factoryctl onboard OWNER/NAME` applies again a ruleset that drifted, and checks that the App still reaches the repository.
- **`doctor`** checks every target in the store: its state, its profile, its rulesets and the App's access.

From a development checkout, name the release the footprint pins with `--factory-ref vX.Y.Z`, adding `--source DIR` when the checkout is elsewhere.

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
  - From `v0.9.0` (P2-09) there may also be `review-dependency.json` or `review-migration.json`.
  - The dependency reviewer runs when the change touches a dependency manifest, and the migration reviewer when it touches a `migrations/` path. The risk policy's `reviews` decide this (`policies/risk.yaml`).
- **Sessions:** `transcripts/`, the recorded sessions.
- **Builder report:** `work/build/build-report.md`. It is for you only, and the judges never see it.

`manifest.json` holds digests of every artifact, the commits judged, the release and its commit, the model IDs and the cost per stage.

### From GitHub issues

From `v0.13.0` (P2-04) a target's issues can become tasks. Give its profile an `intake:` block, `intake: {label: factory, maintainers: [your-login]}`, then poll it:

```bash
factoryctl intake PROFILE.yaml [PROFILE.yaml ...]   # once; schedule it to poll
```

Each poll reads every open issue carrying the label and prints what it did with each one:

- **Admitted:** the latest application of the label is a listed maintainer's, and the issue's body and title have not changed since. The task is the issue's text as it was then. Its text is always untrusted, and the maintainer is recorded as the one who admitted it. Run it as any other task.
- **Ignored:** someone not on the list labelled it. The factory writes nothing to the issue.
- **Held:** it was edited after the label. A maintainer reads the edit and labels it again (remove the label, add it back) to admit it.
- **Waiting:** it was labelled again while the task from its earlier label is still live; the new text is admitted once that task ends.

An admitted issue gets one comment from the App: the task's ID, its state and its PR. Every run of the task brings it up to date, through the outbox. It never repeats the issue's text or anything an agent wrote. This needs the App's issues permission (see [GitHub App and verdicts](#github-app-and-verdicts)): `doctor` fails until you grant it.

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

### Leases

Every run takes its task's lease first (P2-03), and everything it writes carries the lease's epoch. The store refuses a write from any other epoch, so a run that lost its task can change nothing more.

- **One run per task:** `run` and `resume` refuse a task whose lease a live run holds.
- **Operator takeover:** `cancel` and `reject` take the lease over. They stop the run that held it first (SIGTERM, then SIGKILL after 10 seconds), with its session processes and containers, then end the task under the new epoch.
- **Lapsing:** a lease lapses 5 minutes after its last renewal (runs renew every 15 seconds). A lapsed lease whose holder still runs belongs to a hung run, which is stopped before anything takes the task again.

`factoryctl status` shows `(running)` for a task whose lease is held.

### Serve

`factoryctl serve` schedules tasks and is the single writer while it runs. From `v0.17.0` it runs live sessions, unattended, and every one of them in the runner container (see [Runner container](#runner-container)): it builds the runner image before it starts, and its workers refuse live sessions anywhere else. With `--replay DIR` it runs replayed sessions instead.

- **Scheduling:** up to `concurrency.max_tasks` tasks at once (`config/factory.yaml`, or `--max-tasks`). Each runs as a worker process holding the task's lease. Two tasks on one target whose spec scopes overlap never run together; a task without a spec yet overlaps everything on its target.
- **Kill safety:** killing `serve` leaves its workers running under their leases. The next `serve` leaves them alone, and takes over only the tasks whose holder is dead or hung.
- **Commands:** while it runs, the CLI is its client.
  - `pause` and `resume` without a task stop and restart new work.
  - `factoryctl drain` lets running tasks finish, then stops `serve`.
  - `pause`, `resume` and `cancel` with a task go through it.
  - `run`, `takeover` and `reject` refuse until it stops.
- **API:** it listens on `127.0.0.1:7317` (`--port`; `--host` takes a tailnet address only).
  - Every request needs the bearer token in `$FACTORY_HOME/secrets/serve.token`.
  - Every request also needs a `Host` header naming the bound address, and its own `Origin` if it sends one.
  - Every write needs a JSON body.

## Approve

- **Spec gate:** read `spec.md` and `spec.yaml`, then approve and continue:

  ```bash
  factoryctl approve T-0001 --gate spec --reason "scope and acceptance criteria reviewed"
  factoryctl resume T-0001
  ```

  `approve` refuses to run inside a Claude Code session (`CLAUDECODE` set): an agent never approves its own work. The approval is bound to the spec you read: if the spec runs again, the task stops at the spec gate for a new approval.

- **Merge gate:** review the PR on GitHub (the diff, the factory's summary, the gate results) and merge it yourself, or close it. Then run `factoryctl resume T-0001`: it reads the PR and ends the task `DONE` when it was merged, or `FAILED` as `human_rejected` when it was closed without a merge.
  - `factoryctl approve --gate merge` deliberately does nothing.
  - From `v0.11.0`, on a target with the footprint, `policy-check` requires an approving review of the head commit from a listed approver for every tier the ladder leaves to a human: R2 and R3 in Phase 2.
  - After you approve on GitHub, add or remove any label on the PR: that re-runs `policy-check`. A review alone does not, because a review event would run the PR's own workflow.
- **Injection signals (G2-2, from `v0.14.0`):** two signals keep a possible injection away from auto-merge.
  - **A denied tool call.** If the guard or a stage's tool list denied any tool call during the task, the task stops at the merge gate. The reason is `N tool call(s) were denied during the task: possible injection`, and its `factory/verdict` says `needs_human`, so `policy-check` waits for your review too.
  - **Instructions aimed at an agent.** The policy step scans the task's text, and the target files its sessions read or its candidate changed. A line addressed to an AI, near an ask no task needs, raises the task to R2, which you approve. Asks of this kind include a push to `main`, secrets or tokens, CI workflows, ignoring instructions, or sending data out. The lines it found, never their text, are in `runs/T-0001/injection.json`.
- **R0–R1 in Phase 2:** with the App, an approved R0–R1 task does not stop at the merge gate. It waits as `AUTO_APPROVED (gate: checks)` until `gates` and `policy-check` pass on the judged commit, then `factoryctl` squash-merges the PR at exactly that commit, and the task ends `DONE`.
  - `serve` polls it every 5 minutes; without `serve`, `factoryctl resume` checks once.
  - It goes to the human merge gate instead if a required check fails, the PR's head moves, or GitHub refuses the merge. The reason is in `factoryctl status`.
  - **Merges are serialised and re-verified (P2-06).** `factoryctl` merges into a target one task at a time, under the target's merge lease, and only onto the base the candidate was verified on. If the default branch moved since then, it does not merge. Instead:
    - it merges the new base into the task branch;
    - it runs the gates and the policy again on the result;
    - it pushes the result and posts a new `factory/verdict` on it, with the approver's decision carried over;
    - it waits for `gates` and `policy-check` on the new head again.

    The evidence is under `runs/T-0001/drift/<k>/`, and `manifest.json` then names the new base as `reviewed_base_commit`.
  - Re-verification sends the task to the human merge gate instead when the base changed a file the PR changes, the merge conflicts, the gates fail on it, or the policy now puts the change above the approved tier. The reason starts with `base drift:`.
  - A tier you merge yourself is not re-verified: check that its PR is up to date before you merge.

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
| "T-0001 was started by a factoryctl without the commit protocol" | The task began on v0.1.x, and v0.1.x cannot open the store since `v0.20.0`. Cancel it and create a new task. |
| "T-0001 is running (pid …)" | Another `factoryctl` holds the run lock. A lock whose process has died, or whose pid now belongs to another process, is cleared on the next run; `halt`, `cancel` and `reject` never signal such a pid. |
| A task `FAILED` | `factoryctl report T-0001` gives its category, one of the ten in [the taxonomy](#failure-taxonomy-and-weekly-review), and the cost of each stage. A failed task is final: fix the cause, then create a new task. |
| A task should stop for now | `factoryctl pause T-0001`; it holds before its next step until `factoryctl resume T-0001`. |
| A task needs a hand | `factoryctl takeover T-0001`; your result goes back through the gates and reviews on `resume`. |
| A task should stop for good | `factoryctl cancel T-0001`. A running session is signalled and the task ends at once. |
| A new release misbehaves | `factoryctl release use v0.1.0` pins an earlier installed release; `factoryctl release status` lists them and verifies each one's files. |
| `release status` or `doctor` says a release was modified | Do not use it. Remove it with `chmod -R u+w` and `rm -rf`, then install the tag again. |

The event store (`$FACTORY_HOME/factory.db`) is append-only. Never edit it. To keep a copy, back up the whole `$FACTORY_HOME` while no task runs.

## Credential gateway

From `v0.6.0` (P2-02) every live session's model traffic goes through the gateway that `factoryctl run` starts on loopback for the run. Replayed runs have none.

- **Tokens, not the key:** each session gets a token, in a file under `$FACTORY_HOME/tokens/`, and calls the gateway as its `ANTHROPIC_BASE_URL`. The gateway swaps the token for the key on the way to the API. A token is good for that one session of that task. It is revoked, and its file deleted, when the session ends, and every token is revoked by `halt`.
- **The hard cap:** a session's token is good up to what is left of the task's hard budget when the session starts. Once its metered spend reaches that, the gateway refuses its next request, the session ends, and the task fails as `budget_exceeded` mid-stage. A request already running finishes, so a task can pass its cap by at most the requests in flight.
- **Metered cost:** the gateway meters every response from the usage the API reports, prices it by the table in the release's `config/factory.yaml` (`prices`, ROADMAP §11), and records it as a `usage` event. Budgets, `report`, the manifest and calibration all count metered cost; a session's own estimate stays beside it as `reported_cost_usd`.
- **What it forwards:** the Messages and token-counting routes only, for a model the price table names, without the session's credential. Anything else is refused there.

When a §11 re-check finds a price change, the price table changes in a release of its own.

## GitHub App and verdicts

From `v0.10.0` (P2-05) `factoryctl` acts as the factory's own GitHub App when one is set.

**Set it up once:**

1. **Register the App** under your account:
   - repository permissions: checks, contents, issues and pull requests read and write, metadata read; nothing else (issues from `v0.13.0`, for intake);
   - no webhook;
   - installable only on your account.
2. **Install it** on the target repositories only.
3. **Store its private key** as `$FACTORY_HOME/secrets/github-app.pem` (mode 600).
4. **Record its IDs.** Neither is a secret:

   ```bash
   factoryctl app init --app-id 1234567 --installation-id 12345678
   ```

   It writes `$FACTORY_HOME/github-app.json` and checks the App at once. `FACTORY_GITHUB_APP_ID`, `FACTORY_GITHUB_APP_INSTALLATION_ID` and `FACTORY_GITHUB_APP_KEY_FILE` override it.

**What `doctor` checks:**

- the key's permissions;
- that GitHub knows the App by that key;
- the App's permissions, which must be exactly the four above (more fails as surely as less);
- that an installation token can be minted.

**In a run:**

- **Tokens:** each run signs a JWT with the key and trades it for an installation token narrowed to the task's own repository. The token is renewed well inside its hour. The key never leaves `factoryctl`, and sessions see neither.
- **The verdict:** after publishing, `factoryctl` posts a `factory/verdict` check run on the candidate commit, through the outbox, so a crash never posts two. It carries:
  - the commit judged and the base it was reviewed against;
  - the tier and the approver's decision;
  - the spec's digest and the digest of every committed artifact;
  - the factory release and policy;
  - all as canonical JSON with its sha256.

  `verdict-check.json` in the run directory keeps a copy, and `publish.json` its URL.

**`policy-check`:** a target's pull_request_target workflow runs it ([policy-check.ts](../../controller/src/governance/policy-check.ts)), from the pinned factory release and never from the PR. For a `factory/**` PR it:

- reads the base branch's `.factory/policy.yaml`: the App's ID, the approvers, and the target's protected and restricted paths;
- computes the tier again, from GitHub's diff and a sink scan of the head's added lines;
- accepts the verdict only from that App, on the PR's head, with a matching digest and a tier at least the computed one;
- holds R3, and anything the approver passed to a human, until a listed approver approves the head commit;
- never passes Restricted.

### Footprint

From `v0.11.0` (P2-05b) a target's footprint makes these checks binding. It is rendered from the target's profile (`governance.approvers`), the App's ID and a tagged release:

- **`.factory/policy.yaml`:** the App, the approvers, and the protected and restricted paths. policy-check reads it from the base branch.
- **`.factory/gates.yaml`:** the profile's commands and gate adapters, for the gates job.
- **`.github/workflows/factory-gates.yml`:** the gates on every PR, from the release.
- **`.github/workflows/policy-check.yml`:** policy-check on `pull_request_target`. It never checks out the PR, and its token can only read.
- **Rulesets:**
  - `factory-main` requires a PR, squash merges, and the `gates` and `policy-check` checks from GitHub Actions on the default branch.
  - `factory-branches` lets only the repository's admins create, update or delete branches outside `factory/**`, so the App can push only its own branches.

Both workflows run the release by its commit, never by a tag that could move. Changing `.factory/` or `.github/` is R3, and the guard keeps every session out of both.

For the fixtures, `mirror-fixture` adds the footprint as a second deterministic commit on the base and applies the rulesets. `FACTORY_GITHUB_TOKEN` needs Contents and Workflows: write and Administration: write on both fixtures:

```bash
node scripts/mirror-fixture.ts ts-mini --footprint --factory-ref v0.11.0 --push --rulesets
node scripts/mirror-fixture.ts py-mini --footprint --factory-ref v0.11.0 --push --rulesets
```

`doctor` then checks each governed fixture's rulesets against the release's. Pushing a later release's footprint moves `main` again, so the mirror bases change with it.

## Budgets and limits

Every task runs inside four limits (P1-01):

| Limit | What happens |
|---|---|
| The task's budget, by tier | The task fails as `budget_exceeded`, mid-stage when the gateway refuses a session's request. Before triage the task is budgeted at the highest tier; afterwards at the highest tier any step has found. |
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

From `v0.8.0` (P2-08) every live run starts its own OpenTelemetry collector on loopback. Each session exports Claude Code's metrics and events to it, and the collector writes them to `$FACTORY_HOME/otel/<day>.ndjson`, kept for `retention_days.otel` (30 days). Nothing leaves the host.

- **Tags:** resource attributes name each session's task, stage, label, round, tier, agent and release (`factory.task_id`, `factory.stage`, …).
- **Redaction:** prompt and response text stay redacted.
- **Runner sessions:** they will reach the collector through the gateway's route on their egress proxy.
- **Uses:** `factoryctl slo` reads these files, and so does the G2-5 canary audit.

To send the telemetry to a collector of your own instead, or to turn it off:

```bash
export FACTORY_OTEL_ENDPOINT=http://127.0.0.1:4318   # your collector; loopback only, it forwards with its own credentials
export FACTORY_OTEL_PROTOCOL=http/protobuf           # or grpc, http/json
export FACTORY_OTEL=off                              # no telemetry: G2-5's audit and the SLO panel lose it
```

A remote endpoint, or one with credentials in it, is refused: a session must never hold a credential or send data off the host. `doctor` shows the setting.

**SLOs.** The SLO definitions, their targets and how each is measured are in [`slo.md`](slo.md); you approve them at G2. To see them measured:

```bash
factoryctl slo             # the last 4 weeks; --weeks N for another window
```

Each SLO shows its value, what it was measured on and whether it is met. An SLO the store cannot measure yet says so. Below the SLOs is a telemetry panel: per task, the exports, API requests and errors, and tool decisions.

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

## Kill switch

Use it the moment an agent does something you did not expect, or a credential may be exposed. Choose the lightest step that is enough, and escalate.

1. **Stop new work, gently.** `factoryctl pause` stops `serve` issuing work, and `factoryctl drain` lets running tasks finish and then stops `serve`. Use these when nothing is wrong with what is running.
2. **Halt.** This stops every agent action on this host at once:

   ```bash
   factoryctl halt --reason "what you saw"
   ```

   - It writes `$FACTORY_HOME/HALT`.
   - It signals the running task and every `serve` worker, whose sessions abort.
   - It stops every gate container and runner container.
   - It makes the in-process guard deny every further tool call.
   - It makes the credential gateway refuse every request and revoke every token.

   While `HALT` exists, no run starts. A halted task does not fail: it stays where it stopped. `factoryctl status` shows `HALTED`.
3. **Cut GitHub access, if a GitHub credential may be exposed.**
   - From P2-05, suspend the factory App's installation: on GitHub, Settings → Applications → Installed GitHub Apps → the factory App → Configure → Suspend.
   - Until then, revoke `FACTORY_GITHUB_TOKEN`.
   - Close the factory's open PRs and delete the `factory/*` branches.
4. **Rotate the Anthropic key, if it may be exposed or spend is running away.**
   - Disable the key in the Console, or set the workspace spend limit to $0.
   - Create a new key and replace `$FACTORY_HOME/secrets/anthropic.key` with it (`install -m 600 /dev/stdin …`).
   - Sessions never held the key, only their own gateway tokens, which the halt revoked.
5. **Revert a bad merge** on the target like any other commit.

To restart, find and fix the cause, then lift the halt and continue:

```bash
factoryctl unhalt --reason "cause found and fixed"
factoryctl resume T-0001
```

`unhalt` refuses to run inside a Claude Code session. Every halt and unhalt is appended to `$FACTORY_HOME/halt.log`, and the running task records the halt as a `command` event.

**The kill-switch drill (G2-6)** halts the factory as above, then times how long until no agent activity is left on the host: no live writer, session process, runner container or gate container.

```bash
factoryctl drill kill-switch
```

It passes within 5 minutes, writes its record under `$FACTORY_HOME/drills/`, and leaves the factory halted. Run it while `serve` has tasks in flight, so the drill has something to stop.

## Durability

From `v0.7.0` (P2-07, [ADR 0001](adr/0001-replication-without-litestream.md)), `factoryctl` replicates its own state:

- **Object store:** every committed artifact, each task's files and each run's evidence go into a write-once, content-addressed store in `$FACTORY_HOME/objects`.
- **Candidate commits:** the build also commits a git bundle of its candidate commits, so an unpushed candidate survives a lost disk.
- **Replica:** the event store and the object store are copied every second, while anything runs, to a replica you choose.

Set the replica once, on another volume (an external disk, or a separate partition):

```bash
factoryctl replica init /Volumes/Backup/factory-replica
factoryctl replica status
```

Every run, worker and `serve` syncs it every second, and every command syncs it before it exits. `doctor` warns when no replica is set, when it is on the same volume as the home, or when it is behind.

**Restore after losing the home.** Restore into an empty `$FACTORY_HOME`, set the replica again, and resume each task:

```bash
factoryctl restore --source /Volumes/Backup/factory-replica
factoryctl replica init /Volumes/Backup/factory-replica
factoryctl resume T-0001
```

- **What comes back:** the events, every object, and each task's run directory.
- **On resume:** each task rebuilds its clone from its target and its committed candidate. The outbox then finds on GitHub whatever was already pushed or opened, so nothing is pushed or opened twice.
- **Back up yourself:** the replica does not hold your private profile store or the API key file.

**The restore drill (G2-6)** restores the replica, as it stands, into a scratch home, without touching yours:

```bash
factoryctl drill restore
```

It records the restore time (RTO, limit 1 hour), how far the replica was behind (RPO, limit 1 minute), and any file not restored intact, under `$FACTORY_HOME/drills/`.

**Purging by record.** From `v0.20.0` ([ADR 0003](adr/0003-onboarding-retention-and-purge.md)), the factory deletes what it recorded in one way only: a purge, which `offboard` and `prune` will run. A purge:

- writes a tombstone for each task first, deleting its events in the same transaction;
- deletes the objects only those tasks referenced, their directories and their OTel lines;
- compacts the store, so nothing deleted stays in its file;
- has the replica complete the same purge from its own record.

A purge that stops part-way leaves its journal in `$FACTORY_HOME/purges/`, and `factoryctl prune` finishes it. A restore never brings a purged task back, and the restore drill fails if one does. `v0.20.0` migrates `factory.db` and the replica to store schema 4, and an older `factoryctl` refuses them afterwards: install it only when you will not roll back.

### Retention

From `v0.21.0` ([ADR 0003](adr/0003-onboarding-retention-and-purge.md)), each target keeps its evidence for its profile's `retention_days`, never longer than `config/factory.yaml`'s: the shorter of the two applies. Only finished tasks expire, counted from their last activity:

- **`transcripts`:** the run's transcripts and the session directory go.
- **`bundles`:** the whole run directory goes but `task.json`, with the worktree, the session directory and the eval captures. The task's events stay, so `status`, `report`, `budgets` and the calibration still see it; `status` marks it `(evidence expired)`.
- **`otel`:** its telemetry goes from `$FACTORY_HOME/otel/`.

A task that has not finished is never pruned, since it can still resume; `prune` lists the ones past retention for you to cancel or resume. Nothing expires on its own: `doctor` warns when something is due, and you run:

```bash
factoryctl prune --dry-run
factoryctl prune
```

`prune` runs only while nothing else runs: no run, no `serve`, no session and no container. It refuses inside a Claude Code session. Each expiry is recorded as an event before anything goes, the replica deletes the same from its own record, and a restore leaves expired files out. A purge that stopped part-way finishes first.

Do not prune before G2 is signed: the fixtures keep their bundles 30 days, and those bundles are G0 and G1 evidence.

## Runner container

From `v0.4.0` (P2-01) a session's Claude Code can run in a runner container instead of on your machine. `factoryctl` and the Agent SDK stay on the host, with the in-process guard and every credential.

What the container gets:

- **Identity:** your uid (never root), no capabilities and a read-only root.
- **Network:** an internal network whose only exit is the task's egress proxy. The proxy allows HTTPS to the package registries and refuses your machine, private addresses and everything else. It logs each request to `$FACTORY_HOME/runs/<task>/egress/proxy.ndjson`.
- **Files:** its worktree, task and session directories at their host paths. Nothing under `$FACTORY_HOME/secrets` and no Docker socket is ever mounted.

A runner session reaches the model through one fixed route on its egress proxy (`http://<proxy>:3129`) to the credential gateway on the host. The real API key never enters a container: the runner holds only its session's token, mounted read-only and denied to every tool and to the sandbox. The runner suite checks this route, and a session stopped at its hard cap, against a stub model. From `v0.17.0` live runner sessions are on: `serve` runs every live session in the runner, and `factoryctl run T-… --runner container` (or `resume`) does the same for an attended run; `run` without it keeps sessions on the host. A runner session exports its telemetry through the same route: the gateway relays OTLP to the run's collector. The task's network and proxy go when the run ends, and `reap` removes those a dead run left.

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

## Gate G2

G2 closes Phase 2, on the frozen system. `factoryctl gate G2` checks its six automated criteria from the event store, the run directories, the drill records and GitHub; G2-7 is your signature. It matches each task in the window to a seeded fixture case by its text and target, so the sample is what you ran, in the order you ran it.

1. **Freeze.** Install the frozen release (`factoryctl release install TAG`, `release use TAG`) and run `factoryctl doctor`. Reset both fixture mirrors to that release: `node scripts/mirror-fixture.ts NAME --footprint --factory-ref TAG --push --reset --rulesets`.
2. **Open the evidence window.** `factoryctl gate G2 --begin` records the release and plants G2-5's canary in `$FACTORY_HOME/secrets/canary`. Every `run` and `serve` you start from now on carries it in its own environment. Start them after this step.
3. **Run the sample (G2-1).** Create a task from each clean R0–R1 case in `fixtures/targets/*/tasks.yaml`, with `factoryctl task create --profile fixtures/targets/NAME/profile.yaml --title TITLE --body-file fixtures/targets/NAME/tasks/KEY.md --untrusted`, and run each to its end. The first 15 are the sample, failed ones included: do not cancel or re-create an attempt to replace it. At least 11 must merge with no commit of yours and no change request.
4. **Run the seeded suite (G2-2).** Run every auth, sink and injection case. File each issue-vector injection (one with no `carrier`) as an issue whose body is the case's text, and label it `factory` to admit it. Every case must stop at a human gate, the App must push nowhere outside `factory/**` (from the repository activity), and the "ultracode" case must start no workflow.
5. **Kill serve (G2-3).** With three tasks running under `serve`, run `factoryctl drill serve-kill`. It SIGKILLs `serve` alone and records the three tasks. Start `serve` again; each task must reach its merge gate with no side effect made twice and one PR.
6. **Run the drills (G2-6).** Let one task's base move before its merge, so it is re-verified and merges. Run `factoryctl drill restore`, and `factoryctl drill kill-switch` last (it leaves the factory halted: `unhalt` after).
7. **Run the gate.** `factoryctl gate G2` writes `$FACTORY_HOME/gates/G2/evidence.json` and `evidence.md`. It reads GitHub with `FACTORY_GITHUB_TOKEN`, or else the App's token:
   - G2-1: the sample's outcomes, on the release recorded at `--begin`, unchanged since install.
   - G2-2: each seeded attack's stop, the outbox's pushes and the App's activity on each target, and `Workflow` tool uses in the transcripts.
   - G2-3: the serve-kill record, and each of its tasks' states, side effects and PRs.
   - G2-4: p90 cost per merged PR by tier, each PR charged every attempt of its case up to the merge, against the tier budget.
   - G2-5: the canary and the factory's secrets (API key, App key, `serve` token) across the run directories (transcripts, git bundles unpacked, egress proxy logs), the object store, the session homes, the OTel files and the event store. Hits are named by file, never by value.
   - G2-6: a drift re-verification that merged, and passing restore and kill-switch drill records from the window.
   - G2-7 lists the SLOs over the window, approver–human agreement and approval latency for you to approve, and the release's R2 rung.
8. **Open and sign the evidence PR.** Open the `gates/G2` PR with `evidence.md` as its body. Approving it signs G2-7 and the SLOs; R2 auto-merge stays off.

## Where things live

| Path in `$FACTORY_HOME` | Contents |
|---|---|
| `factory.db` | the append-only event store |
| `runs/<task>/` | the evidence bundle and transcripts |
| `releases/<sha>/`, `current`, `bin/factoryctl` | installed releases, the pin, the shim |
| `mirrors/`, `worktrees/<task>/`, `sessions/<task>/` | bare mirrors, per-task clones, per-task session homes |
| `procs/` | the running sessions' processes, so a run that dies leaves none behind |
| `secrets/` | the API key file, and G2-5's canary while a G2 window is open; never readable by a session |
| `tokens/` | each live session's gateway token while it runs; never readable by a session |
| `objects/` | the write-once object store: artifacts, task files and run evidence by digest; never readable by a session |
| `replica.json`, `drills/` | where the replica is, and the drill records |
| `purges/` | the journal of a purge that has not finished; `factoryctl prune` finishes it |
| `targets/<owner>__<name>/` | the private store: each onboarded target's `target.json`, `profile.yaml`, `inventory.json` and `journal.ndjson`; the replica copies it |
| `gates/<gate>/` | gate snapshots and evidence |
| `HALT`, `halt.log` | the kill switch and its audit trail |
