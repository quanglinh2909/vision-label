"""Module mẫu — xoá được, hoặc giữ lại làm endpoint kiểm tra sức khoẻ."""

from __future__ import annotations

from fastapi_modular import Settings, controller, get


@controller(prefix="/health", tags=["health"])
class HealthController:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @get("", summary="Tiến trình còn sống")
    async def live(self) -> dict[str, str]:
        return {"status": "ok", "service": self._settings.name}
