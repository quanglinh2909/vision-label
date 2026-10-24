"""Nghiệp vụ đăng nhập và quản lý thành viên."""

from __future__ import annotations

import time

from fastapi_modular import BadRequestError, ConflictError, NotFoundError, UnauthorizedError, injectable
from fastapi_modular.core.clock import utcnow
from fastapi_modular.core.exceptions import TooManyRequestsError
from fastapi_modular.core.logging import get_logger
from fastapi_modular.infrastructure.database import Repository
from src.api.auth.dto.auth_dto import UserCreate, UserUpdate
from src.api.auth.entities.user_model import Role, User
from src.core.config import AppSettings
from src.core.security import TokenSigner, hash_password, verify_password

log = get_logger(__name__)

SESSION = "session"
MAX_FAILURES = 5
LOCKOUT_SECONDS = 60


@injectable
class AuthService:
    def __init__(self, repo: Repository[User], signer: TokenSigner, settings: AppSettings) -> None:
        self._repo = repo
        self._signer = signer
        self.session_seconds = settings.auth.session_days * 86_400
        # Chặn dò mật khẩu: {tên đăng nhập: [thời điểm sai...]} trong bộ nhớ tiến trình.
        self._failures: dict[str, list[float]] = {}

    # ------------------------------------------------------------ phiên
    async def needs_setup(self) -> bool:
        return await self._repo.count() == 0

    def session_token(self, user: User) -> str:
        return self._signer.sign(SESSION, {"uid": user.id, "sv": user.session_version}, self.session_seconds)

    async def user_from_session(self, token: str) -> User | None:
        payload = self._signer.verify(SESSION, token)
        if not payload:
            return None
        user = await self._repo.get(payload["uid"])
        if user is None or not user.active or user.session_version != payload.get("sv"):
            return None
        return user

    def _check_throttle(self, username: str) -> None:
        now = time.monotonic()
        recent = [t for t in self._failures.get(username, []) if now - t < LOCKOUT_SECONDS]
        self._failures[username] = recent
        if len(recent) >= MAX_FAILURES:
            raise TooManyRequestsError(f"Sai mật khẩu quá {MAX_FAILURES} lần. Thử lại sau {LOCKOUT_SECONDS} giây.")

    async def authenticate(self, username: str, password: str) -> User:
        username = username.strip().lower()
        self._check_throttle(username)
        user = await self._repo.find_one(username=username)
        if user is None or not user.active or not verify_password(password, user.password_hash):
            self._failures.setdefault(username, []).append(time.monotonic())
            log.warning("auth.login_failed", username=username)
            # Cùng một thông báo cho mọi trường hợp: không lộ tài khoản nào tồn tại.
            raise UnauthorizedError("Sai tên đăng nhập hoặc mật khẩu")
        self._failures.pop(username, None)
        user.last_login_at = utcnow()
        return await self._repo.save(user)

    async def setup(self, username: str, password: str) -> User:
        if not await self.needs_setup():
            raise ConflictError("Đã có quản trị viên. Hãy đăng nhập.")
        user = await self._repo.save(
            User(id="", username=username, password_hash=hash_password(password), role=Role.ADMIN)
        )
        log.info("auth.setup_admin", username=username)
        return user

    async def change_password(self, user: User, current: str, new: str) -> User:
        if not verify_password(current, user.password_hash):
            raise BadRequestError("Mật khẩu hiện tại không đúng")
        user.password_hash = hash_password(new)
        user.session_version += 1
        return await self._repo.save(user)

    # ------------------------------------------------------------ thành viên
    async def get_user(self, user_id: str) -> User:
        user = await self._repo.get(user_id)
        if user is None:
            raise NotFoundError(f"Không tìm thấy tài khoản {user_id}")
        return user

    async def get_by_username(self, username: str) -> User | None:
        return await self._repo.find_one(username=username)

    async def list_users(self) -> list[User]:
        return await self._repo.find(order_by="username")

    async def create_user(self, payload: UserCreate) -> User:
        if await self._repo.exists(username=payload.username):
            raise ConflictError(f"Đã có tài khoản '{payload.username}'")
        return await self._repo.save(
            User(id="", username=payload.username, password_hash=hash_password(payload.password), role=payload.role)
        )

    async def _ensure_other_admin(self, user: User) -> None:
        """Không để hệ thống mất quản trị viên cuối cùng."""
        admins = await self._repo.count(role=Role.ADMIN, active=True)
        if user.role is Role.ADMIN and user.active and admins <= 1:
            raise BadRequestError("Đây là quản trị viên cuối cùng. Hãy tạo quản trị viên khác trước.")

    async def update_user(self, user_id: str, payload: UserUpdate) -> User:
        user = await self.get_user(user_id)
        if (payload.role is not None and payload.role is not Role.ADMIN) or payload.active is False:
            await self._ensure_other_admin(user)
        if payload.role is not None:
            user.role = payload.role
        if payload.active is not None and payload.active != user.active:
            user.active = payload.active
            user.session_version += 1
        if payload.password:
            user.password_hash = hash_password(payload.password)
            user.session_version += 1
        return await self._repo.save(user)

    async def delete_user(self, user_id: str) -> None:
        user = await self.get_user(user_id)
        await self._ensure_other_admin(user)
        await self._repo.delete(user_id)
