import secrets

from inventory.auth.tokens import issue_token, verify_token


def test_a_signed_token_verifies() -> None:
    key = secrets.token_bytes(32)
    assert verify_token(issue_token("ada", key, 1_760_000_000), key) == "ada"


def test_a_tampered_or_foreign_token_does_not() -> None:
    key = secrets.token_bytes(32)
    token = issue_token("ada", key, 1_760_000_000)
    assert verify_token(token + "0", key) is None
    assert verify_token(token, secrets.token_bytes(32)) is None
    assert verify_token("garbage", key) is None
