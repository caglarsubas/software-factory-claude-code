# software-factory-claude-code

A target-agnostic software factory built on Claude Code. A Claude Code plugin (agents, skills, hooks) and a TypeScript control plane, `factoryctl`, run one isolated session per task. Deterministic gates and independent reviewers judge every change, and a policy engine, not a model, decides what may merge.

**Status:** Phase 0 (Foundation) in progress. The repository holds the plan, the toolchain and CI; the factory itself is not runnable yet.

- [Development roadmap](docs/factory/ROADMAP.md): architecture, guardrails, phases, gates and decisions.
- [Build status](docs/factory/STATUS.md): progress per deliverable and gate.

Product repositories onboard through a profile; private target data never lives in this public repository.
