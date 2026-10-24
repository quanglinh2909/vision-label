"""HTTP layer quản lý thành viên — chỉ quản trị viên."""

from __future__ import annotations

from typing import Annotated

from fastapi import Path, status

from fastapi_modular.core.controller import controller, delete, get, patch, post
from src.api.auth.auth_service import AuthService
from src.api.auth.dto.auth_dto import UserCreate, UserOut, UserUpdate
from src.api.auth.guards import AdminOnly, Authenticated

UserId = Annotated[str, Path(description="ID tài khoản")]


@controller(prefix="/users", tags=["users"], guards=[Authenticated, AdminOnly])
class UserController:
    def __init__(self, auth: AuthService) -> None:
        self._auth = auth

    @get("", response_model=list[UserOut], summary="Danh sách thành viên")
    async def list_users(self) -> list[UserOut]:
        return [UserOut.model_validate(u) for u in await self._auth.list_users()]

    @post("", response_model=UserOut, status_code=status.HTTP_201_CREATED, summary="Thêm thành viên")
    async def create_user(self, payload: UserCreate) -> UserOut:
        return UserOut.model_validate(await self._auth.create_user(payload))

    @patch("/{user_id}", response_model=UserOut, summary="Đổi vai trò, khoá/mở, đặt lại mật khẩu")
    async def update_user(self, user_id: UserId, payload: UserUpdate) -> UserOut:
        return UserOut.model_validate(await self._auth.update_user(user_id, payload))

    @delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Xoá thành viên")
    async def delete_user(self, user_id: UserId) -> None:
        await self._auth.delete_user(user_id)
