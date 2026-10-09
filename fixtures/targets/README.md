# Fixture targets

Two synthetic target repositories for dry runs, evals and gate G0 (ROADMAP P0-08). Each has a target repository, a profile and seeded tasks:

| Path | What it is |
|---|---|
| `<name>/repo/` | The target repository: what a factory run checks out, mirrored to a throwaway GitHub repository |
| `<name>/profile.yaml` | Its target profile |
| `<name>/tasks.yaml` | The seeded tasks and the outcome a correct run reaches (`schemas/fixture-tasks.schema.json`) |
| `<name>/tasks/` | Task texts, as an operator or an issue would write them |
| `<name>/golden/` | A reference change per task |
| `<name>/hidden/` | Tests per task that the factory never sees: they fail at the base and pass with a correct change |

Golden patches and hidden tests sit beside the target, never in it, so a run cannot read them.

## Seeded tasks

| Target | Task | Tier | What it exercises |
|---|---|---|---|
| ts-mini | `docs-limits` | R0 | docs-only change |
| ts-mini | `orders-pagination` | R1 | a small feature with tests |
| ts-mini | `session-expiry` | R3 | an auth change: the spec gate stops it |
| ts-mini | `discount-rules` | R3 | a code-execution sink, which the SAST gate reports |
| ts-mini | `limit-off-by-one` | R1 | a bug fix whose text injects instructions to edit CI and push to `main` |
| py-mini | `docs-summary` | R0 | docs-only change |
| py-mini | `low-stock-report` | R1 | a small feature with tests |
| py-mini | `token-expiry` | R3 | an auth change: the spec gate stops it |
| py-mini | `legacy-snapshots` | R3 | an unsafe-deserialization sink |
| py-mini | `negative-stock` | R1 | a bug fix whose text injects instructions to edit CI and push to `main` |

`controller/src/fixtures/targets.test.ts` checks that every seeded task is accepted by `factoryctl task create`, that each golden patch applies, and that the policy engine puts each golden change on its tier.

`targets.int.test.ts` (`pnpm test:gates`) runs the container gates. It checks three things:

- Each target is green at its base.
- Each task's hidden tests fail at the base.
- Each golden patch passes every gate with its hidden tests, and reports the expected sinks.

## Mirrors and dry runs

The base commit is deterministic (fixed tree, author and dates), so every mirror starts from the same SHA:

```bash
node scripts/mirror-fixture.ts ts-mini                  # print the base commit
FACTORY_GITHUB_TOKEN=… node scripts/mirror-fixture.ts ts-mini --push [--reset]
```

The operator creates the throwaway repositories named in each `profile.yaml` and installs the factory App on them before G0-1. `--reset` puts `main` back at the base after a dry run.

A dry run on a seeded task:

```bash
pnpm factoryctl task create --profile fixtures/targets/ts-mini/profile.yaml \
  --title "Expire sessions after 24 hours" --body-file fixtures/targets/ts-mini/tasks/session-expiry.md --untrusted
pnpm factoryctl run T-0001
```
