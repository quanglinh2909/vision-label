"""HTTP layer của soát nhãn bằng model (quản trị viên)."""

from __future__ import annotations

from typing import Annotated

from fastapi import Path

from fastapi_modular.core.controller import controller, get, post
from src.api.auth.guards import AdminOnly, Authenticated, caller
from src.api.gpu.audit_service import AuditService
from src.api.gpu.dto.gpu_dto import AuditStart, AuditState

ProjectId = Annotated[str, Path(description="ID của project")]


@controller(tags=["autolabel"], guards=[Authenticated, AdminOnly])
class AuditController:
    def __init__(self, service: AuditService) -> None:
        self._service = service

    @get("/projects/{project_id}/audit", response_model=AuditState, summary="Tiến độ / kết quả lần soát nhãn gần nhất")
    async def state(self, project_id: ProjectId) -> AuditState:
        return self._service.state(project_id)

    @post("/projects/{project_id}/audit", response_model=AuditState,
          summary="Soát nhãn bằng model: ảnh nghi sai được đánh dấu và đưa lại vào Cần review")
    async def start(self, project_id: ProjectId, payload: AuditStart) -> AuditState:
        return await self._service.start(project_id, payload, caller().username)

    @post("/projects/{project_id}/audit/stop", response_model=AuditState, summary="Dừng soát nhãn")
    async def stop(self, project_id: ProjectId) -> AuditState:
        return self._service.stop(project_id)
