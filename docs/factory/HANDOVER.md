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
- **`v0.18.0` (#61):** keeps mods out of sessions' config directories and turns the `AGENTS.md` loader off.
- **P2-14 (`v0.19.0`, #63):** the plugin's `factory-review` workflow, for interactive use only.
- **Parallel items:** P2-13 is in progress (next section); P2-10 is todo. P2-12 stays stopped until a written egress policy exists (Appendix A).
- **P2-11 (done, 2026-10-22):** four PRs, each a release, following [ADR 0003](adr/0003-onboarding-retention-and-purge.md), the operator's decisions of 2026-10-22: purge by record with tombstones, and the App added and removed by hand, verified by factoryctl.
  - #65 (`v0.20.0`): deleting by record (store schema 4, purge journals, the replica).
  - #66 (`v0.21.0`): retention per profile, `prune`, and old-bundle migration tests.
  - #67 (`v0.22.0`): `onboard`, and the fix for the kill-point suite's "fetch failed" flake (the stub GitHub's keep-alive).
  - #68 (`v0.23.0`): `offboard` and the round-trip test (the done-when). The round trip ran offline only; a live one is for P3-08.
- **The pin move** to 2.1.306 / 0.3.306 is built on `claude/epic-cannon-akxfwy` and opens on Oct 28, when pnpm's age gate accepts it. P2-11 took `v0.20.0` to `v0.23.0`, so the pin move merges `main` first and takes the next free version (P2-13's first PR may take `v0.24.0` before it).
- **Freeze:** the core freezes on Nov 27 (§5); the G2 sample runs on the frozen system.

## In flight: P2-13, the code graph in shadow mode (2026-10-23)

The work moved to another session at a checkpoint. It continues on the branch `claude/epic-cannon-akxfwy-p2-13`, cut from `main` at the merge of #68. No PR is open yet.

**The operator's decisions (2026-10-23):**

- The four tree-sitter wheels publish no PyPI attestations. They are pinned by SHA-256 alone, and STATUS's deviations log records it.
- Two PRs, each a release. The first to merge takes the next free version; the pin move takes the one after main's newest CHANGELOG section.
- The branch above, for both PRs: restart it from `main` after the first merges.

**Facts checked on 2026-10-23:**

- graphifyy has no `extract` subcommand. `graphify update PATH --no-cluster` extracts code with no LLM and writes node-link JSON (`nodes`, then `links`) to `$GRAPHIFY_OUT/graph.json`. Nodes carry `source_file`, which is empty for an external module; links carry `relation`. It writes nothing into the scanned tree. STATUS records "`update`, not `extract --code-only`" as a deviation.
- The pins: graphifyy 0.9.91 (0.9.92 was under 7 days old), networkx 3.7, numpy 2.5.4, rapidfuzz 3.14.6, tree-sitter 0.25.2, tree-sitter-python 0.25.0, tree-sitter-javascript 0.25.0 and tree-sitter-typescript 0.23.2. The first four carry PEP 740 provenance.
- `verify-tools` turns a wheel's PyPI provenance into a Sigstore bundle and checks it with `cosign verify-blob-attestation`. All 14 wheel pins verified locally, with `--trusted-root` because the TUF CDN is blocked in a cloud container; CI reaches TUF.

**PR 1: graphifyy in the gate image, and each round's graph.** Committed on the branch so far:

- `gates/image/Dockerfile`: the wheels pinned per architecture, an offline install into `/opt/graphify` with `--no-deps --no-index`, and a build-time smoke check. `docker build --target graphify gates/image` builds in a cloud container; the full image does not, because `deb.debian.org` is blocked there.
- `gates/src/run.ts`: a fourth scan, `graph`, offline on the read-only candidate tree. It is advisory: never in `gates[]`, it never fails the gates, and its record stamps the candidate commit as the freshness anchor. `RunOptions.graphOut` keeps the graph file. `graphifyTool()` in `image.ts` names the pinned release.
- `schemas/gates.schema.json`: the optional `graph` record, with fixtures.
- `gates/src/verify-tools.ts`: the PyPI branch, with its publisher table and its unattested table, and tests on a real provenance file in `gates/src/testdata/`.
- `gates/src/run.test.ts`, and the integration suite's graph checks. The clean-change cases expect exactly one file edge each: `test/cart.test.ts` to `src/cart.ts`, and `tests/test_cart.py` to `src/cart.py`. The real stage image produces them.

PR 1 still needs:

1. **`controller/src/stages/pipeline.ts`:**
   - The gates step passes `graphOut` (a file under `workDir(label)`, removed first). When the record says `built`, it commits the file as `roundPath("graph.json", n)` beside `gates.json`.
   - Drift re-verification does the same as `driftPath("graph.json", k)`, in every `record` it makes.
   - Replayed gates (`session/injection.ts`) carry no graph: an absent graph means missing.
   - A pipeline test whose `runGates` stub writes `graphOut` shows the artifact committed.
2. **Docs:**
   - STATUS: the two deviation rows, then the PR row.
   - The threat model: the supply-chain note (provenance, and the unattested grammars), and LLM08 (graph content is untrusted data, parsed only by `factoryctl` and shown to no agent in P2).
   - The dated CHANGELOG section, `plugin.json`, both profiles' `factory_release`, and this file.
3. **Checks:** `pnpm check`. CI's `gates` job is the first run of the integration suite on the full image.

**PR 2: the blast radius, freshness, `blast.json` and the report.**

- **`controller/src/graph/blast.ts`:**
  - `parseGraph`: accepts `links` or `edges`, caps size, and maps nodes to `source_file`; labels are never used.
  - Two files are one hop apart when a node of one has a dependency edge to a node of the other. The relations follow graphify's `DEFAULT_AFFECTED_RELATIONS`: calls, indirect_call, references, imports, imports_from, dynamic_import, re_exports, inherits, extends, implements, uses, mixes_in, embeds, defines, requires.
  - `blastRadius`: a reverse walk from the changed files, renames' old paths included, up to 4 hops. It returns `hops` (0 when a changed file is itself protected, `null` when nothing protected is in reach), `nearest`, and the number of files reached.
  - `graphFacts`: `fresh` when the graph's commit is the commit judged; otherwise `stale`, `missing` or `error`, and only `fresh` gives a hop count.
- **`protectedGlobs(risk)`:** moves from `target/layer.ts`'s private `guarded()` into `policy/load.ts`.
- **Wiring:**
  - `diffFacts(n)` and drift re-verification fill `graphHopsToProtected`. The policy step's inputs gain the graph artifact.
  - The provisional tier and `governance/policy-check.ts` stay `null`.
- **`blast.json`:** per round and per drift, with `schemas/blast.schema.json`: the task, the candidate, the graph's status, `hops`, `nearest`, and the rule (`within`, `matched`, the shadow tier against the enforced tier). It is the per-task log of the shadow decision, which the done-when asks for.
- **The report:** a "code graph (shadow)" line in `report T`, and counts in `report --week`.
- **Docs:** an operator-guide section, STATUS's P2-13 row done, and the release.

## Waiting on the operator

Every release up to `v0.19.0` is tagged, and `v0.19.0` is installed and pinned (STATUS's Factory release row). Each later release is tagged on its PR's merge commit, then installed with `factoryctl release install`, `release use` and `factoryctl doctor`, and recorded in that row.

1. **One live task in the runner.** This bills the operator's account. Run one `ts-mini` R0 task with `factoryctl run T-… --runner container --attach`, then check `$FACTORY_HOME/runs/T-…/egress/proxy.ndjson` for its requests on the gateway route. Once the pin move is installed, run one again on the new pin, before the G2 sample.
2. **T-0020** is admitted from an issue and still `RECEIVED`: run it or cancel it.
3. **One attended host run** (`factoryctl run T-… --attach`, without `--runner container`) is the first check, on macOS, of `v0.18.0`'s sandbox rule that keeps a session's commands out of its config directory.
4. **Before the G2 sample:** reset both fixture mirrors to the frozen release. `v0.15.0` changed both fixture bases. Use `node scripts/mirror-fixture.ts NAME --footprint --factory-ref TAG --push --reset --rulesets`.

## What comes next

1. **The pin move** (a core release of its own, taking the next free version), built on or after Oct 27. The branch `claude/epic-cannon-akxfwy` holds it: merge `main` into it before the PR.
   - **Version:** the newest npm `stable` at or above 2.1.305 that is at least 7 days old (`minimumReleaseAge`), with the SDK whose `claudeCodeVersion` matches. 2.1.304 fails behind the gateway when ToolSearch is outside a session's tools. If `stable` is still 2.1.304 then, use 2.1.305 and log a deviation.
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
     1. Merge `main` into the branch with a merge commit, since the branch is pushed. Resolve the lockfile with pnpm, never by hand.
     2. Re-check npm's dist-tags and that 0.3.306 is still the SDK for 2.1.306. Re-run the advisory check for anything newer than STATUS's pre-freeze row.
     3. Run a plain `pnpm install --frozen-lockfile` with the gate on: it must pass. Then run `pnpm check` and `pnpm exec vitest run --config vitest.gates.config.ts controller/src/plugin/workflow.int.test.ts controller/src/session/models.int.test.ts`.
     4. Release it:
        - CHANGELOG: the pin move and the flagged-request rule;
        - STATUS: the pin row, the platform log's action, and the release;
        - the threat model: the ASI02 and ASI05 residuals that cite fixes missing from 2.1.286 now say 2.1.306 carries them, plus the model-fallback control;
        - HANDOVER: the operator's steps (the eval suite passes on the release commit before the tag; then tag, install and use the release, run `doctor`, put their own `claude` at 2.1.306 for takeover, and run one live `ts-mini` R0 runner task and one attended host run).
     5. Open the PR with the probe results in its body. CI's runner jobs and gates job are the first container runs of 2.1.306.
2. **Parallel items** that touch no core file, if time allows before the freeze: P2-13 and P2-10 (P2-11 is done).
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
  - merge every PR, tag every release and run every live task;
  - run the operator-only commands, which refuse inside Claude Code: `release install` and `use`, `approve`, `unhalt`, `reject`, `takeover`, `replica init`, `restore`, `prune`, `onboard`, `offboard`, and `drill kill-switch` and `serve-kill`.
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
