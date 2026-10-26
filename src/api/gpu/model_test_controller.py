"""HTTP layer của trang Kiểm tra model — chỉ quản trị viên."""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path as FsPath
from typing import Annotated, Literal

from fastapi import File, Form, Query, UploadFile, status
from pydantic import Field

from fastapi_modular.core.schemas import InputSchema
from fastapi.responses import Response, StreamingResponse

from fastapi_modular import NotFoundError

from fastapi_modular.core.controller import controller, get, post
from src.api.auth.guards import AdminOnly, Authenticated, caller
from src.api.images.dto.image_dto import UploadResult
from src.api.gpu.model_test_service import ModelTestService

# Form / Query có mặc định "" hoặc số, không dùng None: trên Python 3.10, fastapi_modular làm mất Form()
# của tham số `= None` (xem images/image_controller.py).
ServerId = Annotated[str, Form(min_length=1, max_length=36)]
Session = Annotated[str, Query(min_length=8, max_length=64, description="Mã phiên do trang tự sinh")]


class VideoUrlRequest(InputSchema):
    server_id: str = Field(min_length=1, max_length=36)
    url: str = Field(min_length=8, max_length=2000)


class VideoDeleteRequest(InputSchema):
    server_id: str = Field(min_length=1, max_length=36)
    path: str = Field(min_length=1, max_length=1000)


class ImportShotsRequest(InputSchema):
    session: str = Field(min_length=8, max_length=64)
    project_id: str = Field(min_length=1, max_length=36)
    ids: list[int] = Field(min_length=1, max_length=1000)
    name: str = Field(default="", max_length=200, description="Tên video gốc, để đặt tên ảnh")


@controller(tags=["gpu"], guards=[Authenticated, AdminOnly])
class ModelTestController:
    def __init__(self, service: ModelTestService) -> None:
        self._service = service

    @post("/gpu/test/image", response_model=dict, summary="Chạy model với một ảnh, trả các đối tượng tìm được")
    async def image(
        self,
        file: Annotated[UploadFile, File()],
        server_id: ServerId,
        engine: Annotated[Literal["yolo", "locate"], Form()] = "yolo",
        model: Annotated[str, Form(max_length=500)] = "",
        conf: Annotated[float, Form(ge=0, le=1)] = 0.25,
        iou: Annotated[float, Form(ge=0, le=1)] = 0.5,
        imgsz: Annotated[int, Form(ge=32, le=4096)] = 640,
        prompts: Annotated[str, Form(max_length=2000, description="LocateAnything: mô tả, ngăn bằng dấu phẩy")] = "",
    ) -> dict:
        return await self._service.image(server_id, await file.read(), engine, model.strip(), conf, iou, imgsz, prompts)

    @post("/gpu/test/video", response_model=dict, summary="Gửi file video lên server GPU để chạy thử")
    async def video(self, file: Annotated[UploadFile, File()], server_id: ServerId) -> dict:
        tmp = FsPath(tempfile.gettempdir()) / f"visionlabel-{uuid.uuid4().hex}"
        try:
            with tmp.open("wb") as f:  # đọc từng khúc, video có thể vài trăm MB
                while chunk := await file.read(1 << 20):
                    f.write(chunk)
            return {"source": await self._service.upload_video(server_id, tmp, file.filename or "video.mp4", caller().username)}
        finally:
            tmp.unlink(missing_ok=True)

    @post("/gpu/test/video-url", response_model=dict, summary="Cho server GPU tải video từ một link http(s) để chạy thử")
    async def video_url(self, payload: VideoUrlRequest) -> dict:
        return {"source": await self._service.fetch_video(payload.server_id, payload.url.strip(), caller().username)}

    @get("/gpu/test/videos", response_model=list[dict], summary="Video thử đang có trên server GPU (để chạy lại, khỏi gửi lại)")
    async def list_videos(self, server_id: Annotated[str, Query(min_length=1, max_length=36)]) -> list[dict]:
        return await self._service.list_videos(server_id)

    @post("/gpu/test/videos/delete", status_code=status.HTTP_204_NO_CONTENT, summary="Xoá một video thử trên server GPU")
    async def delete_video(self, payload: VideoDeleteRequest) -> None:
        await self._service.delete_video(payload.server_id, payload.path)

    @get("/gpu/test/stream", summary="Hình đã vẽ kết quả của video / RTSP, dạng MJPEG (dùng cho thẻ <img>)")
    async def stream(
        self,
        session: Session,
        server_id: Annotated[str, Query(min_length=1, max_length=36)],
        source: Annotated[str, Query(min_length=1, max_length=2000, description="rtsp://... hoặc đường dẫn video trên server")],
        model: Annotated[str, Query(max_length=500)] = "",
        conf: Annotated[float, Query(ge=0, le=1)] = 0.25,
        iou: Annotated[float, Query(ge=0, le=1)] = 0.5,
        imgsz: Annotated[int, Query(ge=32, le=4096)] = 640,
        speed: Annotated[float, Query(ge=0, le=16, description="Video file: 1 = tốc độ thật, 0 = nhanh nhất")] = 1.0,
    ) -> StreamingResponse:
        frames = await self._service.stream(session, server_id, source, model.strip(), conf, iou, imgsz, speed)
        return StreamingResponse(
            frames, media_type="multipart/x-mixed-replace; boundary=frame",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},  # proxy không được gom hình lại
        )

    @get("/gpu/test/stats", response_model=dict, summary="FPS, số đối tượng mỗi lớp, lỗi của một phiên stream")
    async def stats(self, session: Session) -> dict:
        return self._service.stats(session)

    @get("/gpu/test/shots", response_model=dict, summary="Khung đã ghi lại của một phiên (có / không nhận dạng được)")
    async def shots(self, session: Session, after: Annotated[int, Query(ge=0)] = 0) -> dict:
        return self._service.shots(session, after)

    @get("/gpu/test/shot", response_class=Response, summary="Ảnh của một khung đã ghi lại")
    async def shot(
        self, session: Session, id: Annotated[int, Query(ge=1)],  # noqa: A002
        kind: Annotated[Literal["thumb", "full", "raw"], Query(description="thumb | full (đã vẽ kết quả) | raw (ảnh gốc)")] = "thumb",
    ) -> Response:
        data = self._service.shot_image(session, id, kind)
        if data is None:
            raise NotFoundError("Khung này không còn (phiên đã hết hạn hoặc bị bỏ vì quá nhiều)")
        return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})

    @post("/gpu/test/import", response_model=UploadResult, summary="Đưa ảnh gốc của các khung đã ghi lại vào Chưa gán nhãn")
    async def import_shots(self, payload: ImportShotsRequest) -> UploadResult:
        return await self._service.import_shots(payload.session, payload.ids, payload.project_id, caller().username, payload.name)

    @post("/gpu/test/stop", status_code=status.HTTP_204_NO_CONTENT, summary="Dừng một phiên stream")
    async def stop(self, session: Session) -> None:
        self._service.stop(session)
