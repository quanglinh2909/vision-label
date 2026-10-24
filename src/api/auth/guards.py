"""Guard xác thực — gắn vào controller/route của các module khác.

    @controller(prefix="/projects", guards=[Authenticated])
    class ProjectController:
        @post("", guards=[AdminOnly])        # chạy SAU Authenticated
        async def create(...): ...

Sau Authenticated, `current_principal().id` là tên đăng nhập của người gọi.
"""

from __future__ import annotations

from dataclasses import dataclass

from starlette.requests import HTTPConnection

from fastapi_modular import UnauthorizedError, injectable
from fastapi_modular.core.guards import current_principal
from src.api.auth.auth_service import AuthService

COOKIE = "plate_session"


async def identify(auth: AuthService, connection: HTTPConnection) -> bool:
    """Đọc cookie phiên; hợp lệ thì điền Principal và trả True."""
    token = connection.cookies.get(COOKIE)
    user = await auth.user_from_session(token) if token else None
    if user is None:
        return False
    current_principal().assume(id=user.username, roles={user.role.value})
    return True


@injectable
class Authenticated:
    def __init__(self, auth: AuthService) -> None:
        self._auth = auth

    async def check(self, connection: HTTPConnection) -> None:
        if not await identify(self._auth, connection):
            raise UnauthorizedError("Cần đăng nhập")


@injectable
class AdminOnly:
    async def check(self, connection: HTTPConnection) -> None:
        current_principal().require_role("admin")


def me() -> str:
    """Tên đăng nhập của người đang gọi (sau guard Authenticated)."""
    user = current_principal().id
    if user is None:
        raise UnauthorizedError("Cần đăng nhập")
    return user


@dataclass(frozen=True, slots=True)
class Caller:
    """Ai đang gọi — truyền xuống service để kiểm quyền theo từng ảnh / project."""

    username: str
    admin: bool


def caller() -> Caller:
    return Caller(username=me(), admin="admin" in current_principal().roles)
