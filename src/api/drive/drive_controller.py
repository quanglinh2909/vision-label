"""HTTP layer của module Drive — chỉ quản trị viên."""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path as FsPath
from typing import Annotated
from urllib.parse import quote

from fastapi import Header, Path, Query
from fastapi.responses import FileResponse, RedirectResponse
from starlette.background import BackgroundTask

from fastapi_modular import BadRequestError
from fastapi_modular.core.controller import controller, get, post, put
from src.api.auth.guards import AdminOnly, Authenticated, caller
from src.api.datasets.dataset_controller import DOWNLOAD
from src.api.datasets.dto.dataset_dto import DatasetOut
from src.api.drive.drive_service import DriveService
from src.api.drive.dto.drive_dto import ConnectOut, DriveConfigOut, DriveConfigUpdate, DriveFileOut
from src.api.drive.google_client import DriveError
from src.core.security import TokenSigner

DatasetId = Annotated[str, Path(description="ID của phiên bản dataset")]
Host = Annotated[str, Header()]
# Chạy sau proxy HTTPS (nginx, cloudflare...) thì proxy gửi kèm giao thức gốc ở header này.
Proto = Annotated[str, Header(alias="x-forwarded-proto")]


def _base(host: str, proto: str) -> str:
    """Địa chỉ gốc người dùng đang mở web, để dựng redirect URI cho Google."""
    return f"{(proto or 'http').split(',')[0].strip()}://{host}"


@controller(tags=["drive"], guards=[Authenticated, AdminOnly])
class DriveController:
    def __init__(self, service: DriveService, signer: TokenSigner) -> None:
        self._service = service
        self._signer = signer

    @get("/drive", response_model=DriveConfigOut, summary="Cấu hình kết nối Google Drive")
    async def get_config(self, host: Host, proto: Proto = "") -> DriveConfigOut:
        return self._service.out(await self._service.config(), _base(host, proto))

    @put("/drive", response_model=DriveConfigOut, summary="Lưu Client ID / secret, thư mục, tự tải lên")
    async def update_config(self, payload: DriveConfigUpdate, host: Host, proto: Proto = "") -> DriveConfigOut:
        return self._service.out(await self._service.update(payload), _base(host, proto))

    @post("/drive/connect", response_model=ConnectOut, summary="Lấy link đăng nhập Google để cấp quyền")
    async def connect(self, host: Host, proto: Proto = "") -> ConnectOut:
        return ConnectOut(auth_url=await self._service.connect_url(caller().username, _base(host, proto)))

    @get("/drive/callback", summary="Google gọi về sau khi người dùng cho phép (không gọi tay)")
    async def callback(
        self,
        state: Annotated[str, Query()] = "",
        code: Annotated[str, Query()] = "",
        error: Annotated[str, Query()] = "",
    ) -> RedirectResponse:
        # Trả người dùng về trang Google Drive của app, kèm kết quả để hiện thông báo.
        try:
            if error:
                raise BadRequestError("Bạn đã huỷ cấp quyền" if error == "access_denied" else f"Google báo lỗi: {error}")
            await self._service.finish_connect(code, state, caller().username)
            return RedirectResponse("/#/drive?connected=1", status_code=303)
        except (BadRequestError, DriveError) as e:
            return RedirectResponse(f"/#/drive?error={quote(e.message)}", status_code=303)

    @post("/drive/disconnect", response_model=DriveConfigOut, summary="Ngắt kết nối (thu hồi quyền)")
    async def disconnect(self, host: Host, proto: Proto = "") -> DriveConfigOut:
        return self._service.out(await self._service.disconnect(), _base(host, proto))

    @get("/drive/files", response_model=list[DriveFileOut], summary="Các bản zip dataset đã đẩy lên Drive")
    async def list_files(self) -> list[DriveFileOut]:
        return await self._service.list_files()

    @get("/drive/files/{file_id}/download", response_class=FileResponse, summary="Tải một bản zip từ Drive về (để khôi phục)")
    async def download(self, file_id: Annotated[str, Path(description="ID file trên Drive")]) -> FileResponse:
        dest = FsPath(tempfile.gettempdir()) / f"visionlabel-{uuid.uuid4().hex}.zip"
        await self._service.download(file_id, dest)
        return FileResponse(dest, media_type="application/zip", background=BackgroundTask(dest.unlink, missing_ok=True))

    @post("/datasets/{dataset_id}/drive", response_model=DatasetOut, summary="Đẩy bản zip lên Google Drive (chạy nền)")
    async def upload(self, dataset_id: DatasetId) -> DatasetOut:
        item = await self._service.start_upload(dataset_id, by=caller().username)
        return DatasetOut.build(item, self._signer.sign(DOWNLOAD, {"ds": item.id}))
