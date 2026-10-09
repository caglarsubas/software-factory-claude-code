# CLAUDE.md

This repository is the software factory itself: a Claude Code plugin plus the `factoryctl` control plane. The plan is [`docs/factory/ROADMAP.md`](docs/factory/ROADMAP.md); progress is tracked in [`docs/factory/STATUS.md`](docs/factory/STATUS.md). The repository is **public**.

## Ground rules

- Work in plan mode first. One PR series per roadmap phase; small commits; every deliverable ships with a test or a check.
- Never edit `docs/factory/ROADMAP.md`. The plan changes only through an ADR in `docs/factory/adr/`.
- Update `docs/factory/STATUS.md` after each deliverable: IDs, PR links and aggregates only. Never write private target names, task text or findings anywhere in this repository.
- Never use `bypassPermissions`. Never write a secret, token or credential into any file. Never push to `main`; every change lands through a PR.
- If a documented Claude Code feature is unavailable or still a research preview, use the stable primitive instead and log the fallback in STATUS.

## Commands

```bash
pnpm install --frozen-lockfile   # Node 24 LTS (.node-version), pnpm from packageManager
pnpm check                       # everything CI's check job runs, in order:
pnpm lint                        #   ESLint (typescript-eslint strict, type-checked)
pnpm lint:md                     #   markdownlint-cli2
pnpm typecheck                   #   tsc --noEmit
pnpm test                        #   Vitest
pnpm check:docs                  #   ROADMAP/STATUS ID parity, links, model-ID placement
```

CI (`.github/workflows/factory-ci.yml`) also runs actionlint, zizmor and a trufflehog secret scan; the `ci` job is the single required check.

## Conventions

- TypeScript only for factory code: ESM, strict, erasable syntax only (no enums, namespaces or parameter properties), so Node runs `.ts` files directly. Relative imports use the `.ts` extension.
- Tests sit next to the code as `*.test.ts`.
- Dependencies are pinned to exact versions; pnpm refuses versions younger than 7 days (`minimumReleaseAge`). A new dependency needs a reason in the PR.
- GitHub Actions are pinned by full commit SHA with a version comment, run with least-privilege `permissions`, and never receive secrets on `pull_request` from forks.
- Agent and skill files: subagent frontmatter is camelCase, skill frontmatter kebab-case. Unknown keys are ignored silently, so CI validates them.

## Protected paths

These are R3 in the self profile (ROADMAP §3.3): changes need the operator's review, and the factory never applies them on its own.

`plugin/`, `controller/`, `runner/`, `gates/`, `schemas/`, `evals/`, `profiles/`, `policies/`, `config/`, `scripts/`, `.github/`, `.claude/`, `docs/factory/ROADMAP.md`.

## Layout

The target layout is in ROADMAP §2.4. Today the repository holds the docs, the toolchain, `scripts/` (repository checks), CI, `schemas/` (JSON Schema 2020-12 plus fixtures), `policies/`, `config/`, `profiles/`, and `controller/` (the `@software-factory/controller` workspace package: schema validation and the policy engine so far). Each Phase 0 PR adds the next piece.
