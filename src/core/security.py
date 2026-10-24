"""Băm mật khẩu và ký token — chỉ dùng thư viện chuẩn.

- Mật khẩu: PBKDF2-HMAC-SHA256, salt ngẫu nhiên, so sánh hằng thời gian.
- Token: `<payload base64url>.<chữ ký HMAC-SHA256>`. Payload là JSON có `purpose`
  (phiên đăng nhập / link tải) để token của việc này không dùng được cho việc khác.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from fastapi_modular import injectable
from src.core.config import AppSettings

PBKDF2_ITERATIONS = 240_000


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${_b64e(salt)}${_b64e(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt, digest = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), _b64d(salt), int(iterations))
    return hmac.compare_digest(check, _b64d(digest))


@injectable
class TokenSigner:
    def __init__(self, settings: AppSettings) -> None:
        self._key = self._load_secret(settings)

    @staticmethod
    def _load_secret(settings: AppSettings) -> bytes:
        if settings.auth.secret:
            return settings.auth.secret.encode()
        path = settings.auth.secret_file
        if path.is_file():
            return path.read_text(encoding="utf-8").strip().encode()
        path.parent.mkdir(parents=True, exist_ok=True)
        key = secrets.token_hex(32)
        path.write_text(key, encoding="utf-8")
        return key.encode()

    def _sig(self, body: str) -> str:
        return _b64e(hmac.new(self._key, body.encode(), hashlib.sha256).digest())

    def sign(self, purpose: str, data: dict[str, Any], ttl_seconds: int | None = None) -> str:
        payload = {"p": purpose, **data}
        if ttl_seconds is not None:
            payload["exp"] = int(time.time()) + ttl_seconds
        body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
        return f"{body}.{self._sig(body)}"

    def verify(self, purpose: str, token: str) -> dict[str, Any] | None:
        """Payload nếu token đúng chữ ký, đúng mục đích và chưa hết hạn; ngược lại None."""
        body, _, sig = token.partition(".")
        if not body or not hmac.compare_digest(sig, self._sig(body)):
            return None
        try:
            payload = json.loads(_b64d(body))
        except ValueError:
            return None
        if payload.get("p") != purpose:
            return None
        if "exp" in payload and payload["exp"] < time.time():
            return None
        return payload
