import hashlib
import hmac


def _sign(payload: str, key: bytes) -> str:
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def issue_token(user: str, key: bytes, issued_at: int) -> str:
    payload = f"{user}.{issued_at}"
    return f"{payload}.{_sign(payload, key)}"


def verify_token(token: str, key: bytes) -> str | None:
    """The token's user when its signature is valid, else None."""
    parts = token.rsplit(".", 2)
    if len(parts) != 3:
        return None
    user, issued_at, signature = parts
    if not hmac.compare_digest(_sign(f"{user}.{issued_at}", key), signature):
        return None
    return user
