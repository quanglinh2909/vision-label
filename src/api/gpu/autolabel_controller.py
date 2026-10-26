"""HTTP layer của tự gán nhãn: cấu hình (quản trị viên), chạy cho một ảnh (ai mở được ảnh đều dùng được)."""

from __future__ import annotations

from typing import Annotated

from fastapi import Path

from fastapi_modular.core.controller import controller, get, post, put
from src.api.auth.guards import AdminOnly, Authenticated, caller
from src.api.gpu.autolabel_service import AutoLabelService
from src.api.gpu.dto.gpu_dto import (
    AutoLabelAvailable,
    AutoLabelOut,
    AutoLabelResult,
    AutoLabelUpdate,
    UseModelRequest,
    WarmupResult,
)

ProjectId = Annotated[str, Path(description="ID của project")]
ImageId = Annotated[str, Path(description="ID của ảnh")]


@controller(tags=["autolabel"], guards=[Authenticated])
class AutoLabelController:
    def __init__(self, service: AutoLabelService) -> None:
        self._service = service

    @get("/projects/{project_id}/autolabel", response_model=AutoLabelOut, guards=[AdminOnly], summary="Cấu hình tự gán nhãn")
    async def get_config(self, project_id: ProjectId) -> AutoLabelOut:
        return await self._service.out(project_id)

    @put("/projects/{project_id}/autolabel", response_model=AutoLabelOut, guards=[AdminOnly], summary="Lưu cấu hình tự gán nhãn")
    async def update_config(self, project_id: ProjectId, payload: AutoLabelUpdate) -> AutoLabelOut:
        return await self._service.update(project_id, payload, caller().username)

    @post(
        "/projects/{project_id}/autolabel/warmup",
        response_model=WarmupResult,
        guards=[AdminOnly],
        summary="Nạp model lên GPU trước (lần đầu có thể phải tải model)",
    )
    async def warmup(self, project_id: ProjectId) -> WarmupResult:
        return await self._service.warmup(project_id)

    @post(
        "/projects/{project_id}/autolabel/unload",
        response_model=AutoLabelOut,
        guards=[AdminOnly],
        summary="Gỡ model khỏi GPU (lần tự gán nhãn sau tự nạp lại)",
    )
    async def unload(self, project_id: ProjectId) -> AutoLabelOut:
        return await self._service.unload(project_id)

    @post("/gpu/models/{model_id}/use", response_model=AutoLabelOut, guards=[AdminOnly],
          summary="Dùng model đã lưu cho nút Tự gán nhãn (đẩy lên server GPU)")
    async def use_model(self, model_id: Annotated[str, Path(description="ID của model đã lưu")], payload: UseModelRequest) -> AutoLabelOut:
        return await self._service.use_saved(model_id, payload.server_id, caller().username)

    @get("/projects/{project_id}/autolabel/available", response_model=AutoLabelAvailable, summary="Project có bật tự gán nhãn không")
    async def available(self, project_id: ProjectId) -> AutoLabelAvailable:
        return await self._service.available(project_id)

    @post("/images/{image_id}/autolabel", response_model=AutoLabelResult, summary="Chạy model cho một ảnh (không lưu)")
    async def run(self, image_id: ImageId) -> AutoLabelResult:
        return await self._service.run(image_id, caller())
