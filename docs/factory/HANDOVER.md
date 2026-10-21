# Session handover

A new Claude Code session picks up the factory's development from here. Read this file, then [`ROADMAP.md`](ROADMAP.md) (§2.6 and §3 twice), [`STATUS.md`](STATUS.md) and the [operator guide](operator-guide.md). STATUS is the record of what is done; this file holds what a new session cannot recover from the code alone: where the work stands, what comes next, and how the operator and the agent work together. Update it whenever one of those changes, and keep it free of private target names, task text, findings and secrets, as for STATUS.

## Where the work stands (2026-10-21)

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
- **Parallel items:** P2-10, P2-11, P2-13 and P2-14 are todo. P2-12 stays stopped until a written egress policy exists (Appendix A).
- **Freeze:** the core freezes on Nov 27 (§5); the G2 sample runs on the frozen system.

## Waiting on the operator

1. **Tag and install the untagged releases.** Each tag goes on its PR's merge commit:

   | Release | Merge commit |
   |---|---|
   | `v0.14.0` | `4e14606` (#55) |
   | `v0.15.0` | `5a95bc1` (#56) |
   | `v0.16.0` | `7cc2620` (#57) |
   | `v0.17.0` | `a574e4d` (#58) |

   Then `factoryctl release install v0.17.0`, `release use v0.17.0` and `factoryctl doctor`. Record each tag and install in STATUS's Factory release row as earlier releases are recorded.
2. **One live task in the runner.** This bills the operator's account. Run one `ts-mini` R0 task with `factoryctl run T-… --runner container --attach`, then check `$FACTORY_HOME/runs/T-…/egress/proxy.ndjson` for its requests on the gateway route. Once the pin move is installed, run one again on the new pin, before the G2 sample.
3. **T-0020** is admitted from an issue and still `RECEIVED`: run it or cancel it.
4. **Before the G2 sample:** reset both fixture mirrors to the frozen release. `v0.15.0` changed both fixture bases. Use `node scripts/mirror-fixture.ts NAME --footprint --factory-ref TAG --push --reset --rulesets`.

## What comes next

1. **Mods and `AGENTS.md`** (a core release). It runs on the current pin.
   - **Keep mods out:**
     - the session sandbox denies writes to the session's config directory and the release's plugin;
     - a session, or a takeover, refuses a config directory whose `dev-mods/` holds anything;
     - the runner's managed settings set `allowManagedModsOnly` on the built-in guard.
   - **Turn the `AGENTS.md` loader off:** `instructionFiles: "managed-only"`, in session settings and the runner's managed settings.
   - **Show it in the runner conformance suite:** a target carrying canary instruction files and a mod, and a session mod planted in `dev-mods/`. No canary reaches the model and no mod runs.
2. **The pin move** (a core release of its own), built on or after Oct 27.
   - **Version:** the newest npm `stable` at or above 2.1.305 that is at least 7 days old (`minimumReleaseAge`), with the SDK whose `claudeCodeVersion` matches. 2.1.304 fails behind the gateway when ToolSearch is outside a session's tools. If `stable` is still 2.1.304 then, use 2.1.305 and log a deviation.
   - **Bump the pin in:** `config/factory.yaml`, `controller/package.json` and the lockfile, `runner/Dockerfile` (URLs and checksums), the CI workflows' `npx` lines, and the `verify-tools` test fixture.
   - **Adapt to:**
     - tool search through the gateway;
     - OTel's new `prompt_text`;
     - the SDK's `--flag=value` argv;
     - structured output on a refusal;
     - tighter Bash checks that become denials under `dontAsk`.
   - **Re-run:** every suite, then the eval suite on the release commit.
3. **Parallel items** that touch no core file, if time allows before the freeze. P2-14 comes first: dynamic workflows are GA, so it needs no fallback. Then P2-11, P2-13 and P2-10.
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
  - merge every PR, tag every release and run every live task;
  - run the operator-only commands, which refuse inside Claude Code: `release install` and `use`, `approve`, `unhalt`, `reject`, `takeover`, `replica init`, `restore`, and `drill kill-switch` and `serve-kill`.
- **Commands for the operator:** step by step. Their shell is zsh, where `#` starts no comment, so a command block carries no inline comments. Never ask them to paste or echo a token.
- **One PR at a time, from the session's branch:**
  1. Commit and push, open the PR, then push a STATUS commit with the PR's number. The cancelled CI run on the superseded commit is expected.
  2. Watch the PR until it merges.
  3. After the merge, restart the branch from `main`.
- **Every core PR** bumps the version in `plugin/.claude-plugin/plugin.json`, both profiles' `factory_release`, and a dated CHANGELOG section with its compare link. `pnpm check:release` checks them.
- **STATUS:** IDs, PR links, release tags, commit SHAs taken from git (never typed from memory) and aggregates. A plan change goes through an ADR; a fallback or deviation gets a row in the deviations log.
- **Before a push:** `pnpm check`, and `pnpm test:gates` for anything near the pipeline, gates or fixtures. Run the heavy suites one at a time: run alongside one another, they starve the kill-point suite's timing.

## Cloud-session notes

These apply to a Claude Code session in a cloud container:

- **Docker:** if Docker has stopped, restart it, then wait for `docker info` to answer:

  ```bash
  rm -f /var/run/docker/containerd/containerd.pid /var/run/docker.pid /var/run/docker.sock
  dockerd > /tmp/dockerd.log 2>&1 &
  ```

- **Container suites:** `pnpm test:gates` needs `FACTORY_GATES_CA_FILE` (the container's CA bundle) and `FACTORY_GATES_FETCH_NETWORK=host`. `pnpm test:runner` needs `FACTORY_EGRESS_UPSTREAM="$HTTPS_PROXY"`. The first runner run builds the image, which takes several minutes.
- **The plan:** Phase 2 revision 2 is summarised in STATUS's Current phase row and the deviations log, and its remaining steps are above. It lived in the earlier session's plan file, which is not in this repository.
