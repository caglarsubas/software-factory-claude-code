import secrets
import time

from inventory.auth.tokens import issue_token, verify_token


def test_tokens_expire_after_one_hour_and_not_before() -> None:
    key = secrets.token_bytes(32)
    now = int(time.time())
    assert verify_token(issue_token("u", key, now - 600), key) == "u"
    assert verify_token(issue_token("u", key, now - 7200), key) is None
