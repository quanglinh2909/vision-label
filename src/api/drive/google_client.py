"""Gọi Google OAuth + Drive API v3 bằng thư viện chuẩn (urllib), không cần cài thêm gì.

Chỉ xin quyền `drive.file`: app chỉ thấy và sửa được file / thư mục do chính nó tạo, không đọc
được phần còn lại trong Drive của người dùng.

Các hàm ở đây chạy đồng bộ (chặn) — service gọi qua thread pool.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from src.core.config import DriveSettings

SCOPE = "https://www.googleapis.com/auth/drive.file"
FOLDER_MIME = "application/vnd.google-apps.folder"
TIMEOUT = 60


class DriveError(Exception):
    """Lỗi từ Google. `auth=True`: kết nối hết hiệu lực (bị thu hồi quyền...), phải kết nối lại."""

    def __init__(self, message: str, status: int = 0, auth: bool = False) -> None:
        super().__init__(message)
        self.message, self.status, self.auth = message, status, auth


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # Upload nhiều phần: Google trả 308 nghĩa là "đã nhận tới đây, gửi tiếp" — không phải chuyển hướng.
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _call(method: str, url: str, *, body: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict, Any]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with _opener.open(req, timeout=TIMEOUT) as r:
            raw = r.read()
            return r.status, dict(r.headers), json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        if e.code == 308:
            return 308, dict(e.headers), {}
        try:
            err = json.loads(raw)
        except ValueError:
            err = {}
        detail = err.get("error")
        if isinstance(detail, dict):  # Drive API: {"error": {"message": ...}}
            message = detail.get("message") or str(e)
        else:  # OAuth: {"error": "invalid_grant", "error_description": ...}
            message = err.get("error_description") or detail or str(e)
        raise DriveError(message, e.code, auth=e.code == 401 or detail == "invalid_grant") from e
    except urllib.error.URLError as e:
        raise DriveError(f"Không kết nối được tới Google: {e.reason}") from e


def _form(data: dict[str, str]) -> tuple[bytes, dict[str, str]]:
    return urllib.parse.urlencode(data).encode(), {"Content-Type": "application/x-www-form-urlencoded"}


def _bearer(token: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", **(extra or {})}


class GoogleDrive:
    def __init__(self, settings: DriveSettings) -> None:
        self.s = settings

    # ---------------------------------------------------------------- OAuth
    def auth_url(self, client_id: str, redirect_uri: str, state: str) -> str:
        q = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPE,
            # offline + consent: luôn nhận refresh token, kể cả khi người dùng đã từng cho phép.
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
        }
        return f"{self.s.auth_url}?{urllib.parse.urlencode(q)}"

    def exchange_code(self, client_id: str, secret: str, code: str, redirect_uri: str) -> dict:
        body, headers = _form({
            "code": code, "client_id": client_id, "client_secret": secret,
            "redirect_uri": redirect_uri, "grant_type": "authorization_code",
        })
        return _call("POST", self.s.token_url, body=body, headers=headers)[2]

    def refresh(self, client_id: str, secret: str, refresh_token: str) -> dict:
        body, headers = _form({
            "client_id": client_id, "client_secret": secret,
            "refresh_token": refresh_token, "grant_type": "refresh_token",
        })
        return _call("POST", self.s.token_url, body=body, headers=headers)[2]

    def revoke(self, token: str) -> None:
        body, headers = _form({"token": token})
        _call("POST", self.s.revoke_url, body=body, headers=headers)

    # ---------------------------------------------------------------- Drive
    def account_email(self, token: str) -> str:
        data = _call("GET", f"{self.s.api_url}/about?fields=user(emailAddress)", headers=_bearer(token))[2]
        return data.get("user", {}).get("emailAddress", "")

    def folder_alive(self, token: str, folder_id: str) -> bool:
        """Thư mục còn đó (chưa xoá, chưa bỏ vào thùng rác)."""
        try:
            data = _call("GET", f"{self.s.api_url}/files/{folder_id}?fields=id,trashed", headers=_bearer(token))[2]
        except DriveError as e:
            if e.status == 404:
                return False
            raise
        return not data.get("trashed")

    def find_folder(self, token: str, name: str, parent: str | None) -> str | None:
        esc = name.replace("\\", "\\\\").replace("'", "\\'")
        q = f"name = '{esc}' and mimeType = '{FOLDER_MIME}' and trashed = false"
        q += f" and '{parent}' in parents" if parent else " and 'root' in parents"
        url = f"{self.s.api_url}/files?{urllib.parse.urlencode({'q': q, 'fields': 'files(id)', 'pageSize': 1})}"
        files = _call("GET", url, headers=_bearer(token))[2].get("files", [])
        return files[0]["id"] if files else None

    def create_folder(self, token: str, name: str, parent: str | None) -> str:
        meta = {"name": name, "mimeType": FOLDER_MIME, **({"parents": [parent]} if parent else {})}
        headers = _bearer(token, {"Content-Type": "application/json; charset=UTF-8"})
        return _call("POST", f"{self.s.api_url}/files?fields=id", body=json.dumps(meta).encode(), headers=headers)[2]["id"]

    def ensure_folder(self, token: str, name: str, parent: str | None) -> str:
        return self.find_folder(token, name, parent) or self.create_folder(token, name, parent)

    def start_upload(self, token: str, name: str, parent: str, size: int, mime: str) -> str:
        """Mở phiên upload nhiều phần; trả địa chỉ để gửi từng phần."""
        meta = {"name": name, "parents": [parent]}
        headers = _bearer(token, {
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": mime,
            "X-Upload-Content-Length": str(size),
        })
        url = f"{self.s.upload_url}/files?uploadType=resumable&fields=id,webViewLink"
        _, resp_headers, _ = _call("POST", url, body=json.dumps(meta).encode(), headers=headers)
        location = {k.lower(): v for k, v in resp_headers.items()}.get("location")
        if not location:
            raise DriveError("Google không trả địa chỉ upload")
        return location

    def put_chunk(self, session: str, data: bytes, start: int, total: int) -> dict | None:
        """Gửi một phần. None = Google đã nhận, gửi phần tiếp; dict = xong, thông tin file."""
        end = start + len(data) - 1
        headers = {"Content-Length": str(len(data)), "Content-Range": f"bytes {start}-{end}/{total}"}
        status, _, body = _call("PUT", session, body=data, headers=headers)
        return None if status == 308 else body
