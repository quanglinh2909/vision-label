"""DTO vào/ra của module Auth."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from fastapi_modular.core.schemas import InputSchema, OutputSchema
from src.api.auth.entities.user_model import Role

# Tên đăng nhập: chữ thường không dấu, số, dấu chấm, gạch — dễ gõ, không lẫn hoa/thường.
Username = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9._-]+$")
Password = Field(min_length=8, max_length=128)


class Credentials(InputSchema):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class SetupRequest(InputSchema):
    username: str = Username
    password: str = Password


class UserCreate(InputSchema):
    username: str = Username
    password: str = Password
    role: Role = Role.LABELER


class UserUpdate(InputSchema):
    role: Role | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)


class PasswordChange(InputSchema):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Password


class UserOut(OutputSchema):
    id: str
    username: str
    role: Role
    active: bool
    last_login_at: datetime | None
    created_at: datetime


class AuthStatus(OutputSchema):
    # Chưa có tài khoản nào -> trang web hiện màn tạo quản trị viên đầu tiên.
    needs_setup: bool
    user: UserOut | None
