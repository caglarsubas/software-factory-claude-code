# factoryctl

The factory's control plane (ROADMAP §2). Version 0 (P0-07) runs one task at a time, attended:

```bash
pnpm factoryctl task create --profile profile.yaml --title "…" --body-file task.md [--untrusted] [--remote URL]
pnpm factoryctl run T-0001          # until the task needs a human or ends
pnpm factoryctl resume T-0001       # the same, after a stop, an approval or a crash
pnpm factoryctl approve T-0001 --gate spec --reason "…"
pnpm factoryctl status [T-0001]
pnpm factoryctl cancel T-0001
pnpm factoryctl doctor
```

A run goes triage → spec → build → gates → review (code and security) → approve → summarize → publish, and stops at `NEEDS_HUMAN`. It stops at the spec gate when the spec or the provisional tier calls for a human. It always stops at the merge gate: in Phase 0 and Phase 1 a human merges every tier.

- **State:** `factory.db` is SQLite with append-only events, guarded by triggers and validated against `schemas/event.schema.json`. A task's state is a fold over its events, and only `factoryctl` writes `state_changed`.
- **Artifacts:** each stage writes its artifact last, into `runs/<id>/`. A stage whose artifact exists is done, so `resume` continues from the first missing one.
- **Manifest:** `manifest.json` records:
  - every artifact's digest;
  - the base and candidate commits;
  - the release, policy, CLI and SDK versions;
  - per-stage resolved model IDs and costs, taken from the event store.

## Sessions

Every model session gets explicit SDK options; nothing is left to a default:

- **Permissions and settings:**
  - `permissionMode: "dontAsk"`;
  - `allowedTools` and `tools` from `policies/tools.yaml`;
  - `settingSources: []`;
  - flag settings: `apiKeyHelper` reading `$FACTORY_HOME/secrets/anthropic.key`, deny rules, `disableBypassPermissionsMode`, and workflows off.
- **Sandbox:** required, with `failIfUnavailable`.
- **Env:** an exact allowlist (`session/env.ts`): no API key, SSH agent or token ever reaches a session.
- **Isolation:** each task gets its own `CLAUDE_CONFIG_DIR`, `HOME` and `TMPDIR`.
- **Agent:** the plugin's own agent file, passed as the session's agent definition.
- **Hooks:** the plugin's hooks, plus the in-process guard (the plugin guard's policy as an SDK `PreToolUse` hook).
- **Output:** every judgment stage returns structured output (`stages/outputs.ts`). Its schema is the artifact schema minus the fields `factoryctl` owns.

Each session has its own working directory under `runs/<id>/work/`. Only the builder writes, and only `build-report.md` or `build-failure.json`. The builder never reads the raw task text, and the judges read only the bundle (`runs/<id>/bundle/`), never the builder's report.

## Git

Each target has a bare mirror (`mirrors/`), and each task its own `git clone --shared` in `worktrees/<id>`. Every git write the builder makes therefore stays inside its sandboxed working directory.

`factoryctl` alone fetches the task branch into the mirror and pushes from there, with hooks off. The token (`FACTORY_GITHUB_TOKEN`) reaches only that git process and the PR call.

## Replay

`session/replay.ts` replays recorded SDK transcripts instead of calling a model. Each live session records its stream as `runs/<id>/transcripts/<stage>.ndjson`, so recorded transcripts are replayable.

Replayed tool calls go through the same rules as live ones: `allowedTools` under `dontAsk`, then the in-process guard. The file edits that pass are applied to the working directory.

- `run --replay DIR` drives a task from a transcript directory with zero tokens.
- `stages/pipeline.test.ts` covers the pipeline (in `pnpm test`).
- `cli/factoryctl.int.test.ts` runs it end to end with the container gates (`pnpm test:gates`).
