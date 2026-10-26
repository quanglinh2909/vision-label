"""HTTP layer của module GPU — server, cài môi trường, train. Chỉ quản trị viên."""

from __future__ import annotations

import json
import tempfile
import uuid
from pathlib import Path as FsPath
from typing import Annotated

from fastapi import Path, Query, status
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from fastapi_modular.core.controller import controller, delete, get, patch, post
from src.api.auth.guards import AdminOnly, Authenticated, caller
from src.api.gpu.dto.gpu_dto import (
    JobOut,
    ModelUpdate,
    SavedModelOut,
    SaveModelRequest,
    ServerCreate,
    ServerOut,
    ServerUpdate,
    SetupRequest,
    TrainCreate,
    UseModelRequest,
)
from src.api.gpu.gpu_service import GpuService

ServerId = Annotated[str, Path(description="ID của server GPU")]
JobId = Annotated[str, Path(description="ID của việc chạy trên server")]
ProjectId = Annotated[str, Path(description="ID của project")]
ModelId = Annotated[str, Path(description="ID của model đã lưu")]


@controller(tags=["gpu"], guards=[Authenticated, AdminOnly])
class GpuController:
    def __init__(self, service: GpuService) -> None:
        self._service = service

    # ------------------------------------------------------------ server
    @get("/gpu/servers", response_model=list[ServerOut], summary="Danh sách server GPU")
    async def list_servers(self) -> list[ServerOut]:
        return await self._service.list_servers()

    @post("/gpu/servers", response_model=ServerOut, status_code=status.HTTP_201_CREATED, summary="Thêm server GPU")
    async def create_server(self, payload: ServerCreate) -> ServerOut:
        return self._service.out(await self._service.create_server(payload))

    @patch("/gpu/servers/{server_id}", response_model=ServerOut, summary="Sửa server GPU")
    async def update_server(self, server_id: ServerId, payload: ServerUpdate) -> ServerOut:
        return self._service.out(await self._service.update_server(server_id, payload))

    @delete("/gpu/servers/{server_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Xoá server GPU")
    async def delete_server(self, server_id: ServerId) -> None:
        await self._service.delete_server(server_id)

    @post("/gpu/servers/{server_id}/test", response_model=ServerOut, summary="Kết nối thử, đọc GPU và môi trường Python")
    async def test_server(self, server_id: ServerId) -> ServerOut:
        return self._service.out(await self._service.test_server(server_id))

    @post("/gpu/servers/{server_id}/setup", response_model=JobOut, summary="Cài môi trường trên server (chạy nền)")
    async def setup(self, server_id: ServerId, payload: SetupRequest) -> JobOut:
        return await self._service.job_out(await self._service.start_setup(server_id, payload.locate, caller().username))

    @post("/gpu/servers/{server_id}/release", response_model=ServerOut, summary="Tắt agent, trả bộ nhớ GPU")
    async def release(self, server_id: ServerId) -> ServerOut:
        return self._service.out(await self._service.release(server_id))

    # ------------------------------------------------------------ việc chạy nền
    @get("/gpu/jobs", response_model=list[JobOut], summary="Các việc gần đây (cài đặt, train)")
    async def list_jobs(self, project_id: Annotated[str | None, Query()] = None) -> list[JobOut]:
        return await self._service.list_jobs(project_id)

    @get("/gpu/jobs/{job_id}", response_model=JobOut, summary="Chi tiết một việc, kèm log")
    async def get_job(self, job_id: JobId) -> JobOut:
        return await self._service.job_out(await self._service.get_job(job_id), detail=True)

    @post("/gpu/jobs/{job_id}/recheck", response_model=JobOut, summary="Đọc lại kết quả của việc trên server")
    async def recheck_job(self, job_id: JobId) -> JobOut:
        return await self._service.job_out(await self._service.recheck_job(job_id))

    @post("/gpu/jobs/{job_id}/stop", response_model=JobOut, summary="Dừng việc đang chạy")
    async def stop_job(self, job_id: JobId) -> JobOut:
        return await self._service.job_out(await self._service.stop_job(job_id))

    @delete("/gpu/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Xoá việc và thư mục của nó trên server")
    async def delete_job(self, job_id: JobId) -> None:
        await self._service.delete_job(job_id)

    @post("/projects/{project_id}/train", response_model=JobOut, summary="Train một phiên bản dataset trên server GPU")
    async def train(self, project_id: ProjectId, payload: TrainCreate) -> JobOut:
        return await self._service.job_out(await self._service.start_train(project_id, payload, caller().username))

    # ------------------------------------------------------------ model train xong
    @get("/gpu/jobs/{job_id}/weights", response_class=FileResponse, summary="Tải best.pt của một lần train (lấy từ server GPU)")
    async def download_weights(self, job_id: JobId) -> FileResponse:
        dest = FsPath(tempfile.gettempdir()) / f"visionlabel-{uuid.uuid4().hex}.pt"
        job = await self._service.fetch_weights(job_id, dest)
        name = self._service.weights_filename(json.loads(job.params or "{}"))
        return FileResponse(dest, filename=name, media_type="application/octet-stream",
                            background=BackgroundTask(dest.unlink, missing_ok=True))

    @post("/gpu/jobs/{job_id}/save", response_model=SavedModelOut, summary="Lưu model của một lần train về máy chạy app")
    async def save_model(self, job_id: JobId, payload: SaveModelRequest) -> SavedModelOut:
        return SavedModelOut.build(await self._service.save_model(job_id, payload, caller().username))

    @get("/projects/{project_id}/models", response_model=list[SavedModelOut], summary="Model đã lưu của project")
    async def list_models(self, project_id: ProjectId) -> list[SavedModelOut]:
        return await self._service.list_models(project_id)

    @patch("/gpu/models/{model_id}", response_model=SavedModelOut, summary="Sửa tên, ghi chú, đánh dấu model đã lưu")
    async def update_model(self, model_id: ModelId, payload: ModelUpdate) -> SavedModelOut:
        return SavedModelOut.build(await self._service.update_model(model_id, payload))

    @delete("/gpu/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Xoá model đã lưu (kèm file)")
    async def delete_model(self, model_id: ModelId) -> None:
        await self._service.delete_model(model_id)

    @post("/gpu/models/{model_id}/deploy", response_model=dict, summary="Đưa model đã lưu lên server GPU, trả đường dẫn trên server")
    async def deploy_model(self, model_id: ModelId, payload: UseModelRequest) -> dict:
        return {"path": await self._service.deploy_model(model_id, payload.server_id)}

    @get("/gpu/models/{model_id}/file", response_class=FileResponse, summary="Tải file .pt của model đã lưu")
    async def model_file(self, model_id: ModelId) -> FileResponse:
        path, name = await self._service.model_file(model_id)
        return FileResponse(path, filename=name, media_type="application/octet-stream")
