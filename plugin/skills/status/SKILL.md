---
name: status
description: Shows the software factory's task board, read-only. Use when the operator asks what the factory is doing or for one task's state.
disable-model-invocation: true
argument-hint: "[task-id]"
allowed-tools: Bash(factoryctl status *)
---
Run `factoryctl status $ARGUMENTS` and show the result as it is: one line per task with its state, tier and next step, or the full timeline for one task ID.

This skill only reads. Never approve, cancel or change a task from here: approvals go through `factoryctl approve` in the operator's own terminal.

If `factoryctl` is not installed yet (it arrives with roadmap deliverable P0-07), say so and stop.
