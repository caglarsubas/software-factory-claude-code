# py-mini conventions

- Python 3.14, typed: `mypy --strict` must pass.
- Tests use pytest and live in `tests/`.
- No new runtime dependencies.
- `src/inventory/auth/` issues and verifies API tokens: changes there need a security review.
