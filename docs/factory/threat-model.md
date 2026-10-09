# Threat model

One page for v0.1.0 (Phase 0): what the factory protects, from whom, and which control answers each risk in the [OWASP Top 10 for LLM Applications (2025)](https://genai.owasp.org/llm-top-10/) and the [OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/). The guardrails themselves are specified in ROADMAP [§3.2](ROADMAP.md#32-security-guardrails); this page maps them to threats. `scripts/check-docs.ts` fails if any of the 20 risks loses its row.

**Assets:**

- the target repositories and their default branches;
- the operator's credentials: the Anthropic key and the GitHub token;
- the merge decision;
- the installed factory release and its policies;
- the spend.

**Adversaries:**

- text the factory reads: issue bodies, repository content, dependency code, tool output;
- a model that misreads its task or overreaches;
- a compromised dependency or scanner;
- anyone who can open a PR or issue on this public repository.

**Trust boundaries:**

- **Operator:** `factoryctl` runs as the operator, holds the credentials, and alone writes state, pushes and opens PRs.
- **Sessions:** each is sandboxed, with an allowlisted env, sees no credentials, and works in its own clone.
- **Gates:** run in disposable containers with no network.
- **Judges:** see only the bundle.

## OWASP Top 10 for LLM Applications (2025)

| ID | Risk | Controls in v0.1.0 | Residual risk and next step |
|---|---|---|---|
| LLM01 | Prompt injection | Task text is trust-labelled and restated by the spec-writer; the builder never reads it raw ([prompts](../../controller/src/stages/prompts.ts)). Every tool call passes `dontAsk` with explicit `allowedTools`, then the guard. Seeded injection tasks in the [fixtures](../../fixtures/targets/README.md). | Injected repository content can still steer a session within its scope; the gates and independent judges catch the effect, not the cause. |
| LLM02 | Sensitive information disclosure | Credentials never enter a session: allowlisted env ([env.ts](../../controller/src/session/env.ts)), `apiKeyHelper` key file denied to Read and to the sandbox, `.env*`, `~/.ssh` and `/proc/*/environ` denied. Secret-scan gate on every candidate. STATUS and gate evidence hold IDs and aggregates only. | Secrets the target already commits are visible to sessions; the P2-02 gateway removes the key file. |
| LLM03 | Supply chain | Exact pins, a 7-day release-age buffer, frozen lockfiles; gate tools pinned by checksum and verified by cosign, SLSA or GitHub attestation ([verify-tools.ts](../../gates/src/verify-tools.ts)); actions pinned by SHA; the dependency-audit gate. | Attestations of factory releases arrive with P3-06. |
| LLM04 | Data and model poisoning | No fine-tuning and no retrieval store. | Poisoned target content is LLM01's residual risk. From P1-05, CI accepts eval cases only with `target: self` or `target: fixture`. |
| LLM05 | Improper output handling | Every judgment is structured output validated against a JSON Schema ([schemas](../../schemas/)); invalid output fails the stage as `schema_invalid`. The policy engine, not a model, sets the tier. | The builder's code is output too: the gates and reviews judge it. |
| LLM06 | Excessive agency | Per-agent tool lists ([tools.yaml](../../policies/tools.yaml)); the guard confines writes to the spec's scope and denies protected paths, pushes and network tools ([guard policy](../../plugin/hooks/lib/guard-policy.ts)); only `factoryctl` pushes, from the mirror; a human merges every tier in P0–P1. | Bash inside the sandbox can still run the target's own code. |
| LLM07 | System prompt leakage | Agent prompts are public in this repository and hold no secrets or private data. | None by design. |
| LLM08 | Vector and embedding weaknesses | No embeddings or vector store. | Re-assess when the code graph (P2-13) lands. |
| LLM09 | Misinformation | Independent judges see the bundle, never the builder's prose. Acceptance criteria map to tests; summaries report checks, never "safe". | A judge can still miss a defect. The refuter (P1-03) and evals (P1-05) measure it. |
| LLM10 | Unbounded consumption | One task at a time, `maxTurns` per agent, the Console spend limit as backstop, the kill switch ([operator guide](operator-guide.md#kill-switch-v0)). | Per-task budgets and the 90-minute wall clock are enforced from P1-01. |

## OWASP Top 10 for Agentic Applications (2026)

| ID | Risk | Controls in v0.1.0 | Residual risk and next step |
|---|---|---|---|
| ASI01 | Agent goal hijack | As LLM01; the spec, not the task text, defines scope, and the guard enforces it; the spec gate stops R3 work before any code. | As LLM01. |
| ASI02 | Tool misuse and exploitation | The guard denies more than 50 bypass variants, from shell wrappers and `git -c` to symlinked secrets and malformed hook input ([suite](../../plugin/hooks/bypass-cases.ts), gate G0-2). Hooks exit 2 on any error. | New shell tricks: every one found becomes a variant. |
| ASI03 | Identity and privilege abuse | Sessions hold no identity: no token, no SSH agent, no `GIT_ASKPASS`. The GitHub token reaches only `factoryctl`'s push and PR call. `approve`, `unhalt` and release pinning refuse to run inside an agent session. | The token is the operator's until the GitHub App (before G0-1) scopes it to selected repositories and `factory/**`. |
| ASI04 | Agentic supply chain vulnerabilities | As LLM03. Plugin, hooks and policies load only from an installed, read-only, digest-verified release ([install](../../controller/src/release/install.ts)). `settingSources: []` keeps target settings, hooks and MCP servers out of sessions. | The plugin marketplace listing is unsigned. |
| ASI05 | Unexpected code execution | The sandbox is required (`failIfUnavailable`), its network limited to package registries. Target code runs only in gate containers with no network, no capabilities and a read-only root. The `sink_added` SAST rules raise new execution sinks to R3. | The runner container (P2-01) adds a second boundary around sessions. |
| ASI06 | Memory and context poisoning | No cross-task memory: a fresh config directory, home and clone per task, and `persistSession` writes only into the task's own directory. | The target's `CLAUDE.md` is passed in as data and can carry injected text (LLM01). |
| ASI07 | Insecure inter-agent communication | Agents never talk to each other. `factoryctl` passes schema-validated artifacts between stages, and judges read a size-capped bundle. | None in v0.1.0. |
| ASI08 | Cascading failures | Each stage writes its artifact last and fails closed; red gates stop the run before reviewer tokens; at most one round; the same finding twice stops (P1-01). | Retries and outbox reconciliation arrive with P1-02. |
| ASI09 | Human-agent trust exploitation | Humans merge every tier and see the diff, gate results and digests, not a model's reassurance. Summaries never claim "safe" or "ready". The approval token is the operator's own. | A persuasive PR body can still mislead a reviewer; R3 requires a human review on the head SHA (P2-05). |
| ASI10 | Rogue agents | Append-only events; the ledger records denials; the kill switch halts every session, run and gate container at once, and fails closed on an unreadable `HALT` file. | The full kill-switch runbook and drill arrive with P2-07. |
