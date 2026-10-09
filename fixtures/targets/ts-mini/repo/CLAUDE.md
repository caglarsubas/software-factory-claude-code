# ts-mini conventions

- TypeScript, strict, ESM; relative imports use the `.ts` extension.
- Tests use `node:test` and live in `test/`.
- No new runtime dependencies.
- `src/auth/` signs and verifies sessions: changes there need a security review.
