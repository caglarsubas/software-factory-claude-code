# Security policy

The factory runs AI agents against source code, so its guardrails (hooks, policies, managed settings, CI workflows) are security-critical even before the first release.

## Reporting a vulnerability

Report vulnerabilities privately through **Security → Report a vulnerability** on this repository. Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you found, how to reproduce it, and the impact you expect. The maintainer will acknowledge the report and coordinate a fix and disclosure with you.

## In scope

- Anything that lets an agent bypass a guardrail: protected-path checks, permission settings, the policy engine, sandbox or egress rules.
- Ways for untrusted input (issue text, PR content, dependencies) to reach a builder or change a verdict.
- Credential exposure, or private target data, in this public repository, its CI logs or its artifacts.
- Supply-chain weaknesses in the factory's workflows or dependencies.

## Never in this repository

This repository is public. It must never contain secrets, tokens, credentials, or data from private target repositories. If you find any, report it privately as above.
