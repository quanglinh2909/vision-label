"""WebSocket `/ws/live`: kênh realtime cho giao diện.

Bắt tay dùng chính cookie đăng nhập (guard Authenticated) — trình duyệt tự gửi cookie
khi mở WebSocket cùng tên miền. Client gửi `project.watch` khi mở một project:

    -> {"event": "project.watch", "data": {"project_id": "..."}, "id": "1"}
    <- {"event": "project.watch", "data": {"project_id": "...", "scope": "project"}, "ack": "1"}

Quản trị viên vào phòng của project (nhận `project.changed`). Người gán nhãn không vào phòng
nào — họ chỉ nhận `me.changed` gửi thẳng cho mình, về ảnh được giao cho họ.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from fastapi_modular.core.websocket import Socket, gateway, subscribe
from src.api.auth.guards import Authenticated
from src.api.live.live_events import project_room


class WatchIn(BaseModel):
    project_id: str = Field(min_length=1, max_length=64)


@gateway(path="/ws/live", guards=[Authenticated])
class LiveGateway:
    @subscribe("project.watch")
    async def watch(self, socket: Socket, payload: WatchIn) -> dict:
        # Mỗi kết nối chỉ theo dõi một project: rời phòng cũ trước.
        for room in [r for r in socket.rooms if r.startswith("project:")]:
            socket.leave(room)
        if "admin" in socket.roles:
            socket.join(project_room(payload.project_id))
            return {"project_id": payload.project_id, "scope": "project"}
        return {"project_id": payload.project_id, "scope": "mine"}
