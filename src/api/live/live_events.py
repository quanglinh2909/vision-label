"""Phát sự kiện realtime qua WebSocket (gateway ở live_gateway.py).

Hai kênh:
- `project.changed` -> phòng `project:<id>`: chỉ quản trị viên vào được, nhận mọi thay đổi.
- `me.changed`      -> gửi thẳng cho một người (mọi tab của họ): chỉ những gì về ảnh của họ.
  Người gán nhãn không bao giờ nhận thông tin về ảnh của người khác.

Phát tin là "tiện thì báo": lỗi ở đây chỉ ghi log, không bao giờ làm hỏng thao tác chính.
"""

from __future__ import annotations

from typing import Any

from fastapi_modular import injectable
from fastapi_modular.core.logging import get_logger
from fastapi_modular.core.websocket import WebSocketServer

log = get_logger(__name__)

NAMESPACE = "/ws/live"


def project_room(project_id: str) -> str:
    return f"project:{project_id}"


@injectable
class LiveEvents:
    def __init__(self, ws: WebSocketServer) -> None:
        self._ws = ws

    async def project(self, project_id: str, kind: str, by: str, **data: Any) -> None:
        """Báo cho quản trị viên đang xem project."""
        payload = {"project_id": project_id, "kind": kind, "by": by, **data}
        try:
            await self._ws.to_room(project_room(project_id), "project.changed", payload, namespace=NAMESPACE)
        except Exception as e:  # noqa: BLE001 - realtime không được làm hỏng thao tác chính
            log.warning("live.emit_failed", kind=kind, error=str(e))

    async def user(self, username: str, project_id: str, kind: str, by: str, **data: Any) -> None:
        """Báo riêng cho một người (VD người gán: được giao ảnh, ảnh bị trả lại...)."""
        if not username or username == by:
            return
        payload = {"project_id": project_id, "kind": kind, "by": by, **data}
        try:
            await self._ws.to_user(username, "me.changed", payload, namespace=NAMESPACE)
        except Exception as e:  # noqa: BLE001
            log.warning("live.emit_failed", kind=kind, error=str(e))
