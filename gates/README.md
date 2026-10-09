# Gate runner

Deterministic gates for one candidate commit (ROADMAP P0-06): build, types, lint, tests, invariant checks, SAST, secrets and dependency audit, each in a disposable container. The result is `gates.json` ([`schemas/gates.schema.json`](../schemas/gates.schema.json)): a status per gate and the risk signals the policy engine reads (`sink_added`, `secret_material`).

```bash
node gates/src/cli.ts run --worktree DIR --base REV --task T-0042 --profile profile.yaml --out gates.json
node gates/src/cli.ts image   # build the gate image if missing, print its tag
```

Exit 0 means every gate passed, 1 means one did not, and 2 means the run itself failed. The worktree must have no uncommitted changes, because the gates judge the commit that gets reviewed and pushed.

## What runs where

| Step | Network | Mounts | Notes |
|---|---|---|---|
| load | none | run volume | The committed tree, streamed from the object database. `git archive` is not used, because a change's own `export-ignore` would hide files from every gate. |
| `sast`, `secret-scan`, `dependency-audit` | none | run volume (read-only), OSV databases (read-only) | Run on the pristine tree, before any target code. Suppression comments (`nosemgrep`, `trufflehog:ignore`), ignore files and size limits do not apply. |
| OSV refresh | fetch | OSV databases | Sees only the image's seed lockfiles, never target content. Runs only when a database is older than 12 hours. |
| `setup` | fetch | run volume, target cache | The profile's setup command. Lifecycle scripts and source builds are off. |
| `build`, `typecheck`, `lint`, `test`, `invariant-*` | none | run volume, target cache (read-only) | One container per gate. The host reads the exit codes, so code under test cannot forge a result. |

Every container runs with:

- `--cap-drop ALL`, `no-new-privileges` and a read-only root filesystem;
- a non-root user, with pid, memory and CPU limits;
- `--rm`.

The run volume is removed after the run. The target cache is per target repository, so caches never cross targets. Command gates mount it read-only, so a test cannot poison it for a later task.

Findings count only on lines the change added. SAST and secret matches on untouched lines never fail a task, and the dependency audit fails only on advisories the change introduced.

- `default` rule findings fail `sast`.
- `sink_added` findings (code execution, process execution, unsafe deserialization) become signals, which policies/risk.yaml raises to R3 with a security review.
- A changed file the engine could not scan is an error, not a pass.

The fetch network defaults to `bridge`. For a host behind a TLS-inspecting proxy, two environment variables apply:

- `FACTORY_GATES_FETCH_NETWORK` sets the network.
- `FACTORY_GATES_CA_FILE` mounts a CA bundle into the fetch containers only.

Proxy variables pass to those containers by name.

## Adapters

| Adapter | Lockfiles audited | Setup | Command gates |
|---|---|---|---|
| `typescript` | pnpm, npm, yarn, bun | `pnpm_config_ignore_scripts` and its npm and yarn equivalents | corepack, pnpm and npm offline |
| `python` | uv, poetry, pdm, Pipfile, `requirements*.txt` | `UV_NO_BUILD` and `PIP_ONLY_BINARY` | uv offline, with a throwaway uv cache |

Because source builds are off during setup, a uv project that is itself a package needs `[tool.uv] package = false`, or a setup command with `--no-install-project`.

## Pins

[`image/Dockerfile`](image/Dockerfile) pins:

- base images by digest;
- each download (trufflehog, osv-scanner, opengrep, uv, for amd64 and arm64) by SHA-256, which BuildKit checks.

The image tag is a hash of the build inputs. CI's `gates` job runs [`src/verify-tools.ts`](src/verify-tools.ts) before building. It reads the pins from the Dockerfile and checks each against its publisher's signature or provenance:

- trufflehog and opengrep: cosign;
- osv-scanner: SLSA;
- uv: GitHub attestations.

A download with no defined check fails the unit tests. To bump a tool:

1. Change its URL and hashes.
2. Run `node gates/src/verify-tools.ts`.
3. Keep releases at least 7 days old.

## Tests

- `pnpm test`: unit tests for the plan, diff parsing, scanner judgements, tar streaming, container arguments and pin coverage.
- `pnpm test:gates` (Docker): the rule packs' annotated tests, plus the seeded-defect suite. The suite runs a TypeScript and a Python fixture through real containers, and each seeded defect must fail exactly the gate it targets. It covers type, lint and test failures, insecure TLS, added sinks, a secret, a vulnerable dependency and a stale lockfile. It also covers three bypass attempts: `export-ignore`, `nosemgrep` and `trufflehog:ignore`.
