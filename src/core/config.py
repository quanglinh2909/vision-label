"""Cấu hình của ứng dụng — thêm biến `.env` của riêng bạn ở đây.

`Settings` mang sẵn phần của khung (database, log, CORS...). Kế thừa nó là đủ để
pydantic-settings đọc thêm biến của bạn: biến môi trường thắng .env, .env thắng
giá trị mặc định, nhóm lồng nhau ngăn bằng hai gạch dưới.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from fastapi_modular import Settings


class StorageSettings(BaseModel):
    """Nơi để file trên đĩa -> APP_STORAGE__DIR, APP_STORAGE__DATASETS_DIR..."""

    # Ảnh gốc + ảnh thu nhỏ đã upload, chia theo project.
    dir: Path = Path("storage")
    # Các phiên bản dataset xuất ra (định dạng YOLO), chia theo project.
    datasets_dir: Path = Path("dataset")
    # Cạnh dài của ảnh thu nhỏ dùng cho trang xem tổng quan.
    thumb_size: int = 384


class AuthSettings(BaseModel):
    """Đăng nhập -> APP_AUTH__SECRET, APP_AUTH__SESSION_DAYS, APP_AUTH__COOKIE_SECURE."""

    # Khoá ký cookie phiên và link tải dataset. Để trống thì tự sinh một lần vào
    # secret_file. Đổi khoá = đăng xuất mọi người và vô hiệu mọi link tải cũ.
    secret: str = ""
    secret_file: Path = Path("data/secret.key")
    session_days: int = 7
    # Bật khi chạy sau HTTPS (public lên internet): cookie chỉ gửi qua kết nối mã hoá.
    cookie_secure: bool = False


class DriveSettings(BaseModel):
    """Google Drive -> APP_DRIVE__REDIRECT_URI... Client ID / secret thì nhập ở trang Google Drive của app."""

    # Địa chỉ Google gọi về sau khi người dùng cho phép. Bỏ trống = tự tính từ địa chỉ đang mở web
    # (http://<host>:<port>/api/drive/callback). Đặt tay khi chạy sau proxy HTTPS hoặc tên miền riêng.
    redirect_uri: str = ""
    # Mỗi lần gửi bao nhiêu KB khi upload; Google yêu cầu bội của 256.
    chunk_kb: int = 8192
    # Địa chỉ dịch vụ Google — chỉ đổi khi chạy thử với server giả.
    auth_url: str = "https://accounts.google.com/o/oauth2/v2/auth"
    token_url: str = "https://oauth2.googleapis.com/token"
    revoke_url: str = "https://oauth2.googleapis.com/revoke"
    api_url: str = "https://www.googleapis.com/drive/v3"
    upload_url: str = "https://www.googleapis.com/upload/drive/v3"


class AppSettings(Settings):
    """Settings của khung, cộng thêm phần của ứng dụng."""

    storage: StorageSettings = Field(default_factory=StorageSettings, alias="APP_STORAGE")
    auth: AuthSettings = Field(default_factory=AuthSettings, alias="APP_AUTH")
    drive: DriveSettings = Field(default_factory=DriveSettings, alias="APP_DRIVE")
