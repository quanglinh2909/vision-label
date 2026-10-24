"""HTTP layer của module Dataset."""

from __future__ import annotations

from typing import Annotated

from fastapi import Path, Query, status
from fastapi.responses import FileResponse
from starlette.requests import HTTPConnection

from fastapi_modular import UnauthorizedError, injectable
from fastapi_modular.core.controller import controller, delete, get, post
from src.api.auth.auth_service import AuthService
from src.api.auth.guards import AdminOnly, Authenticated, identify
from src.api.datasets.dataset_service import DatasetService
from src.api.datasets.dto.dataset_dto import DatasetCreate, DatasetOut, PlanOut
from src.api.datasets.exporter import ExportFormat
from src.api.datasets.entities.dataset_model import DatasetVersion
from src.core.security import TokenSigner

ProjectId = Annotated[str, Path(description="ID của project")]
DatasetId = Annotated[str, Path(description="ID của phiên bản dataset")]

DOWNLOAD = "download"


@injectable
class DownloadAccess:
    """Cho tải nếu đã đăng nhập, HOẶC có `?key=` đúng của phiên bản này.

    Key là chữ ký HMAC trên id phiên bản — giống link tải của Roboflow: curl/Colab tải
    được mà không cần đăng nhập, nhưng chỉ ai được đưa link mới tải được.
    """

    def __init__(self, auth: AuthService, signer: TokenSigner) -> None:
        self._auth = auth
        self._signer = signer

    async def check(self, connection: HTTPConnection) -> None:
        if await identify(self._auth, connection):
            return
        payload = self._signer.verify(DOWNLOAD, connection.query_params.get("key", ""))
        if not payload or payload.get("ds") != connection.path_params.get("dataset_id"):
            raise UnauthorizedError("Cần đăng nhập, hoặc link tải có key hợp lệ")


@controller(tags=["datasets"])
class DatasetController:
    def __init__(self, service: DatasetService, signer: TokenSigner) -> None:
        self._service = service
        self._signer = signer

    def _out(self, item: DatasetVersion) -> DatasetOut:
        return DatasetOut.build(item, self._signer.sign(DOWNLOAD, {"ds": item.id}))

    @get(
        "/projects/{project_id}/datasets",
        response_model=list[DatasetOut],
        guards=[Authenticated, AdminOnly],
        summary="Các phiên bản",
    )
    async def list_versions(self, project_id: ProjectId) -> list[DatasetOut]:
        return [self._out(d) for d in await self._service.list_versions(project_id)]

    @get(
        "/projects/{project_id}/datasets/plan",
        response_model=PlanOut,
        guards=[Authenticated, AdminOnly],
        summary="Xem trước: lớp nào xuất được sang định dạng này",
    )
    async def plan(self, project_id: ProjectId, format: Annotated[ExportFormat, Query()]) -> PlanOut:  # noqa: A002
        return await self._service.plan(project_id, format)

    @post(
        "/projects/{project_id}/datasets",
        response_model=DatasetOut,
        status_code=status.HTTP_201_CREATED,
        guards=[Authenticated, AdminOnly],
        summary="Tạo phiên bản mới từ các ảnh đã gán nhãn",
    )
    async def create_version(self, project_id: ProjectId, payload: DatasetCreate) -> DatasetOut:
        return self._out(await self._service.create_version(project_id, payload))

    @get(
        "/datasets/{dataset_id}/download",
        response_class=FileResponse,
        guards=[DownloadAccess],
        summary="Tải về dạng zip (đăng nhập, hoặc ?key=)",
    )
    async def download(self, dataset_id: DatasetId) -> FileResponse:
        path, filename = await self._service.zip_path(dataset_id)
        return FileResponse(path, filename=filename, media_type="application/zip")

    @delete(
        "/datasets/{dataset_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        guards=[Authenticated, AdminOnly],
        summary="Xoá phiên bản",
    )
    async def delete_version(self, dataset_id: DatasetId) -> None:
        await self._service.delete_version(dataset_id)
