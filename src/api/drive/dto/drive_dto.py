"""DTO vào/ra của module Drive."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from fastapi_modular.core.schemas import InputSchema, OutputSchema


class DriveConfigUpdate(InputSchema):
    client_id: str | None = Field(default=None, max_length=300)
    # Bỏ trống / không gửi = giữ secret cũ (trang cấu hình không bao giờ hiện lại secret).
    client_secret: str | None = Field(default=None, max_length=300)
    folder_name: str | None = Field(default=None, min_length=1, max_length=200)
    auto_upload: bool | None = None


class DriveConfigOut(OutputSchema):
    client_id: str
    has_secret: bool
    connected: bool
    account_email: str
    connected_by: str
    connected_at: datetime | None
    folder_name: str
    folder_link: str = Field(description="Link thư mục gốc trên Drive (sau lần upload đầu tiên)")
    auto_upload: bool
    redirect_uri: str = Field(description="Dán địa chỉ này vào 'Authorized redirect URIs' của OAuth client")


class ConnectOut(OutputSchema):
    auth_url: str
