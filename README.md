# software-factory-claude-code

A target-agnostic software factory built on Claude Code. A Claude Code plugin (agents, skills, hooks) and a TypeScript control plane, `factoryctl`, run one isolated session per task. Deterministic gates and independent reviewers judge every change, and a policy engine, not a model, decides what may merge.

**Status:** Phase 0 (Foundation) in progress. The repository holds the plan, the toolchain, CI, the schemas and policy engine, plugin v0.1, the [gate runner](gates/README.md) and [`factoryctl` v0](controller/README.md). [Fixture targets](fixtures/targets/README.md) with seeded tasks, the [operator guide](docs/factory/operator-guide.md) and the [threat model](docs/factory/threat-model.md) are in place; the first live run is part of gate G0, on release `v0.1.0`.

The plugin can already be installed for interactive use: its agents and the `/software-factory:status` skill work by hand, and its hooks only keep secret files out of the context until `factoryctl` starts a factory session. The hooks run TypeScript directly and need Node 22.18 or later on `PATH`; with an older Node they fail closed and block every tool call.

```text
/plugin marketplace add caglarsubas/software-factory-claude-code
/plugin install software-factory@software-factory
```

- [Development roadmap](docs/factory/ROADMAP.md): architecture, guardrails, phases, gates and decisions.
- [Build status](docs/factory/STATUS.md): progress per deliverable and gate.

Product repositories onboard through a profile; private target data never lives in this public repository.
