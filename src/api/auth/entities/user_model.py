"""Entity tài khoản người dùng."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from fastapi_modular import Entity, column, entity
from fastapi_modular.core.clock import utcnow


class Role(str, Enum):
    ADMIN = "admin"  # tạo/xoá project, tải ảnh, tạo dataset, quản lý thành viên
    LABELER = "labeler"  # xem project, gán nhãn, tải dataset


@entity(unique=["username"])
@dataclass(slots=True)
class User(Entity):
    id: str
    username: str = field(default="", metadata=column(length=64))
    password_hash: str = field(default="", metadata=column(length=200))
    role: Role = Role.LABELER
    active: bool = True
    # Tăng mỗi khi đổi mật khẩu / khoá tài khoản -> mọi cookie phiên cũ mất hiệu lực.
    session_version: int = 0
    last_login_at: datetime | None = None

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
