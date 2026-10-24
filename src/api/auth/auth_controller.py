"""HTTP layer đăng nhập: trạng thái, tạo quản trị viên đầu tiên, đăng nhập/đăng xuất."""

from __future__ import annotations

from fastapi import Request, Response, status

from fastapi_modular.core.controller import controller, get, post
from src.api.auth.auth_service import AuthService
from src.api.auth.dto.auth_dto import AuthStatus, Credentials, PasswordChange, SetupRequest, UserOut
from src.api.auth.entities.user_model import User
from src.api.auth.guards import COOKIE, Authenticated, me
from src.core.config import AppSettings


@controller(prefix="/auth", tags=["auth"])
class AuthController:
    def __init__(self, auth: AuthService, settings: AppSettings) -> None:
        self._auth = auth
        self._secure = settings.auth.cookie_secure

    def _start_session(self, response: Response, user: User) -> UserOut:
        response.set_cookie(
            COOKIE,
            self._auth.session_token(user),
            max_age=self._auth.session_seconds,
            httponly=True,  # JavaScript không đọc được -> XSS không lấy cắp được phiên
            samesite="lax",  # trang khác không gửi kèm cookie khi POST sang đây
            secure=self._secure,
            path="/",
        )
        return UserOut.model_validate(user)

    @get("/status", response_model=AuthStatus, summary="Đã đăng nhập chưa / cần tạo quản trị viên không")
    async def auth_status(self, request: Request) -> AuthStatus:
        token = request.cookies.get(COOKIE)
        user = await self._auth.user_from_session(token) if token else None
        return AuthStatus(
            needs_setup=await self._auth.needs_setup(),
            user=UserOut.model_validate(user) if user else None,
        )

    @post("/setup", response_model=UserOut, status_code=status.HTTP_201_CREATED, summary="Tạo quản trị viên đầu tiên")
    async def setup(self, payload: SetupRequest, response: Response) -> UserOut:
        return self._start_session(response, await self._auth.setup(payload.username, payload.password))

    @post("/login", response_model=UserOut, summary="Đăng nhập")
    async def login(self, payload: Credentials, response: Response) -> UserOut:
        return self._start_session(response, await self._auth.authenticate(payload.username, payload.password))

    @post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="Đăng xuất")
    async def logout(self, response: Response) -> None:
        response.delete_cookie(COOKIE, path="/")

    @post(
        "/password",
        response_model=UserOut,
        guards=[Authenticated],
        summary="Đổi mật khẩu của mình (đăng xuất các phiên khác)",
    )
    async def change_password(self, payload: PasswordChange, response: Response) -> UserOut:
        user = await self._auth.get_by_username(me())
        user = await self._auth.change_password(user, payload.current_password, payload.new_password)
        # Phiên hiện tại vẫn giữ: cấp cookie mới theo session_version mới.
        return self._start_session(response, user)
