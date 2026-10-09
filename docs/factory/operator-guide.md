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

`FACTORY_GITHUB_TOKEN` stays in the shell that runs `factoryctl`. It reaches only the `git push` from the mirror and the PR call. Without it, a run pushes nothing and opens no PR.

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

## Approve

- **Spec gate:** read `spec.md` and `spec.yaml`, then approve and continue:

  ```bash
  factoryctl approve T-0001 --gate spec --reason "scope and acceptance criteria reviewed"
  factoryctl resume T-0001
  ```

  `approve` refuses to run inside a Claude Code session (`CLAUDECODE` set): an agent never approves its own work.

- **Merge gate:** review the PR on GitHub (the diff, the factory's summary, the gate results) and merge it yourself, or close it.
  - `factoryctl approve --gate merge` deliberately does nothing.
  - From Phase 2 the `policy-check` workflow requires your GitHub review on R3 changes.

## Recover

| Situation | What to do |
|---|---|
| `factoryctl` crashed, the host rebooted, or you pressed Ctrl-C | `factoryctl resume T-0001`. Each stage writes its artifact last, so the run continues from the first missing one, and a transition lost in a crash is repaired. |
| "T-0001 is running (pid …)" | Another `factoryctl` holds the run lock. A lock whose process has died is cleared on the next run. |
| A task `FAILED` | `factoryctl status T-0001` and the `stage_failed` event give the category: `gate_fail`, `review_block`, `schema_invalid`, `max_turns`, `budget_exceeded`, `no_change`, `api_error`. A failed task is final: fix the cause, then create a new task. |
| A task should stop for good | `factoryctl cancel T-0001`. A running session is signalled and the task ends at once. |
| A new release misbehaves | `factoryctl release use v0.1.0` pins an earlier installed release; `factoryctl release status` lists them and verifies each one's files. |
| `release status` or `doctor` says a release was modified | Do not use it. Remove it with `chmod -R u+w` and `rm -rf`, then install the tag again. |

The event store (`$FACTORY_HOME/factory.db`) is append-only. Never edit it. To keep a copy, back up the whole `$FACTORY_HOME` while no task runs.

## Kill switch v0

Use it the moment an agent does something you did not expect, or a credential may be exposed.

```bash
factoryctl halt --reason "what you saw"
```

It acts at once:

- writes `$FACTORY_HOME/HALT`;
- signals the running task, whose session aborts;
- stops every gate container;
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

## Where things live

| Path in `$FACTORY_HOME` | Contents |
|---|---|
| `factory.db` | the append-only event store |
| `runs/<task>/` | the evidence bundle and transcripts |
| `releases/<sha>/`, `current`, `bin/factoryctl` | installed releases, the pin, the shim |
| `mirrors/`, `worktrees/<task>/`, `sessions/<task>/` | bare mirrors, per-task clones, per-task session homes |
| `secrets/` | the API key file; never readable by a session |
| `gates/<gate>/` | gate snapshots and evidence |
| `HALT`, `halt.log` | the kill switch and its audit trail |
