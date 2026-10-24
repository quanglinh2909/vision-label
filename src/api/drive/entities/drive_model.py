"""Entity của module Drive — cấu hình kết nối Google Drive, chỉ một bản ghi cho cả app."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from fastapi_modular import Entity, column, entity
from fastapi_modular.core.clock import utcnow

CONFIG_ID = "google"


@entity()
@dataclass(slots=True)
class DriveConfig(Entity):
    id: str
    # OAuth client loại "Web application" tạo trong Google Cloud Console.
    client_id: str = field(default="", metadata=column(text=True))
    client_secret: str = field(default="", metadata=column(text=True))
    # Có refresh token = đã kết nối. Lưu trong database của app: ai đọc được file .db là dùng
    # được quyền này, nên giữ file data/ như giữ mật khẩu.
    refresh_token: str = field(default="", metadata=column(text=True))
    account_email: str = field(default="", metadata=column(length=255))
    connected_by: str = field(default="", metadata=column(length=64))
    connected_at: datetime | None = None
    # Thư mục gốc trên Drive do app tạo; mỗi project một thư mục con bên trong.
    folder_name: str = field(default="VisionLabel", metadata=column(length=255))
    folder_id: str = field(default="", metadata=column(length=128))
    # Tạo dataset xong tự đẩy lên Drive.
    auto_upload: bool = False

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
