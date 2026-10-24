"""HTTP layer của module Image."""

from __future__ import annotations

import json
import mimetypes
from typing import Annotated, Any

from fastapi import File, Form, Path, Query, UploadFile, status
from fastapi.responses import FileResponse

from fastapi_modular import BadRequestError
from fastapi_modular.core.controller import controller, delete, get, post, put
from fastapi_modular.core.schemas import Page
from src.api.auth.guards import AdminOnly, Authenticated, caller
from src.api.images.dto.image_dto import (
    AnnotationsUpdate,
    ApproveRequest,
    AssignRequest,
    ClaimRequest,
    ImageOut,
    ImageRef,
    LockRequest,
    RejectManyRequest,
    RejectRequest,
    RevisionOut,
    RevokeRequest,
    UploadResult,
)
from src.api.images.image_service import ImageService, Queue

# Windows thường thiếu webp trong bảng MIME -> trình duyệt nhận octet-stream.
mimetypes.add_type("image/webp", ".webp")

ProjectId = Annotated[str, Path(description="ID của project")]
ImageId = Annotated[str, Path(description="ID của ảnh")]
QueueParam = Annotated[Queue, Query(description="Danh sách: unlabeled | todo | review | rejected | labeled")]
# Quản trị viên lọc theo người được giao (VD trang "Cần review" theo từng người).
Assignee = Annotated[str | None, Query(description="Chỉ ảnh giao cho người này (quản trị viên)")]


@controller(tags=["images"], guards=[Authenticated])
class ImageController:
    def __init__(self, service: ImageService) -> None:
        self._service = service

    # ------------------------------------------------------------ upload / danh sách
    @post(
        "/projects/{project_id}/images",
        response_model=UploadResult,
        status_code=status.HTTP_201_CREATED,
        guards=[AdminOnly],
        summary="Upload ảnh (nhiều file một lần)",
    )
    async def upload(
        self,
        project_id: ProjectId,
        files: Annotated[list[UploadFile], File()],
        annotations: Annotated[
            str | None,
            Form(description='Nhập từ dataset có sẵn: JSON {"tên file": [đối tượng, ...]} theo định dạng nhãn của app'),
        ] = None,
        approved: Annotated[bool, Form(description="Ảnh kèm nhãn vào thẳng Đã duyệt thay vì Cần review")] = False,
    ) -> UploadResult:
        self._service.ensure_files(files)
        try:
            labels = json.loads(annotations) if annotations else None
        except ValueError as e:
            raise BadRequestError("annotations không phải JSON hợp lệ") from e
        if labels is not None and not isinstance(labels, dict):
            raise BadRequestError("annotations phải là object {tên file: [đối tượng]}")
        payload = [(f.filename or "", await f.read()) for f in files]
        return await self._service.upload(project_id, payload, by=caller().username, annotations=labels, approved=approved)

    @get("/projects/{project_id}/images", response_model=Page[ImageOut], summary="Ảnh trong một danh sách")
    async def list_images(
        self,
        project_id: ProjectId,
        queue: QueueParam,
        assignee: Assignee = None,
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> Page[ImageOut]:
        items, total = await self._service.list_images(
            project_id, queue, caller(), assignee=assignee, limit=limit, offset=offset
        )
        return Page(items=[ImageOut.build(i) for i in items], total=total, limit=limit, offset=offset)

    @get(
        "/projects/{project_id}/image-refs",
        response_model=list[ImageRef],
        summary="Toàn bộ id + tên ảnh của một danh sách, để duyệt tuần tự",
    )
    async def list_refs(self, project_id: ProjectId, queue: QueueParam, assignee: Assignee = None) -> list[ImageRef]:
        rows = await self._service.list_refs(project_id, queue, caller(), assignee)
        return [ImageRef.model_validate(i) for i in rows]

    @post(
        "/projects/{project_id}/claim-next",
        response_model=ImageOut | None,
        summary="Nhận ảnh kế tiếp để gán (người gán: trong ảnh được giao; null nếu hết)",
    )
    async def claim_next(self, project_id: ProjectId, payload: ClaimRequest) -> ImageOut | None:
        item = await self._service.claim_next(project_id, caller(), set(payload.exclude))
        return ImageOut.build(item) if item else None

    # ------------------------------------------------------------ phân công / review
    @get(
        "/projects/{project_id}/assignments",
        response_model=dict[str, Any],
        guards=[AdminOnly],
        summary="Số ảnh theo người được giao và theo trạng thái",
    )
    async def assignment_stats(self, project_id: ProjectId) -> dict[str, Any]:
        return await self._service.assignment_stats(project_id)

    @post("/projects/{project_id}/assignments", response_model=dict[str, int], guards=[AdminOnly], summary="Giao N ảnh cho một người")
    async def assign(self, project_id: ProjectId, payload: AssignRequest) -> dict[str, int]:
        # Quản trị viên tự gán thẳng ảnh chưa giao ở "Chưa gán nhãn", không giao cho chính mình.
        if payload.username == caller().username:
            raise BadRequestError("Không giao ảnh cho chính mình. Ảnh chưa giao thì bạn tự gán ở mục Chưa gán nhãn.")
        return {"assigned": await self._service.assign(project_id, payload.username, payload.count, by=caller().username)}

    @post(
        "/projects/{project_id}/assignments/revoke",
        response_model=dict[str, int],
        guards=[AdminOnly],
        summary="Thu hồi các ảnh đã giao mà người đó chưa làm",
    )
    async def revoke(self, project_id: ProjectId, payload: RevokeRequest) -> dict[str, int]:
        return {"revoked": await self._service.revoke(project_id, payload.username, by=caller().username, scope=payload.scope)}

    @post("/projects/{project_id}/approve", response_model=dict[str, int], guards=[AdminOnly], summary="Duyệt nguyên trạng nhiều ảnh")
    async def approve(self, project_id: ProjectId, payload: ApproveRequest) -> dict[str, int]:
        return {"approved": await self._service.approve(project_id, payload.ids, caller())}

    @post("/projects/{project_id}/reject", response_model=dict[str, int], guards=[AdminOnly], summary="Trả lại nhiều ảnh, chung một ghi chú")
    async def reject_many(self, project_id: ProjectId, payload: RejectManyRequest) -> dict[str, int]:
        done, skipped = await self._service.reject_many(project_id, payload.ids, payload.note, caller())
        return {"rejected": done, "skipped": skipped}

    @post("/images/{image_id}/reject", response_model=ImageOut, guards=[AdminOnly], summary="Trả ảnh lại cho người gán")
    async def reject(self, image_id: ImageId, payload: RejectRequest) -> ImageOut:
        return ImageOut.build(await self._service.reject(image_id, payload.note, caller()))

    @get("/projects/{project_id}/labelers", response_model=dict[str, int], guards=[AdminOnly], summary="Số ảnh đã duyệt theo người gán")
    async def labeler_stats(self, project_id: ProjectId) -> dict[str, int]:
        return await self._service.labeler_stats(project_id)

    # ------------------------------------------------------------ một ảnh
    @get("/images/{image_id}", response_model=ImageOut, summary="Chi tiết ảnh + nhãn")
    async def get_image(self, image_id: ImageId) -> ImageOut:
        return ImageOut.build(await self._service.get_for(image_id, caller()))

    @get("/images/{image_id}/history", response_model=list[RevisionOut], summary="Lịch sử gán / sửa / duyệt, mới nhất trước")
    async def history(self, image_id: ImageId) -> list[RevisionOut]:
        return [RevisionOut.model_validate(r) for r in await self._service.history(image_id, caller())]

    @post("/images/{image_id}/lock", response_model=ImageOut, summary="Giữ / gia hạn giữ ảnh (409 nếu người khác đang giữ)")
    async def lock(self, image_id: ImageId, payload: LockRequest) -> ImageOut:
        return ImageOut.build(await self._service.lock(image_id, caller(), force=payload.force))

    @post("/images/{image_id}/unlock", status_code=status.HTTP_204_NO_CONTENT, summary="Trả ảnh")
    async def unlock(self, image_id: ImageId) -> None:
        await self._service.unlock(image_id, caller())

    @put(
        "/images/{image_id}/annotations",
        response_model=ImageOut,
        summary="Lưu nhãn -> chờ duyệt; approve=true (quản trị viên) -> duyệt luôn",
    )
    async def save_annotations(self, image_id: ImageId, payload: AnnotationsUpdate) -> ImageOut:
        return ImageOut.build(
            await self._service.save_annotations(image_id, payload.objects, caller(), approve=payload.approve)
        )

    @delete("/images/{image_id}/annotations", response_model=ImageOut, summary="Đưa về chưa gán nhãn")
    async def clear_annotations(self, image_id: ImageId) -> ImageOut:
        return ImageOut.build(await self._service.clear_annotations(image_id, caller()))

    @delete("/images/{image_id}", status_code=status.HTTP_204_NO_CONTENT, guards=[AdminOnly], summary="Xoá ảnh")
    async def delete_image(self, image_id: ImageId) -> None:
        await self._service.delete_image(image_id, by=caller().username)

    @get("/images/{image_id}/file", response_class=FileResponse, summary="File ảnh gốc")
    async def file(self, image_id: ImageId) -> FileResponse:
        return FileResponse(await self._service.file_path(image_id, caller(), thumb=False))

    @get("/images/{image_id}/thumb", response_class=FileResponse, summary="Ảnh thu nhỏ")
    async def thumb(self, image_id: ImageId) -> FileResponse:
        return FileResponse(
            await self._service.file_path(image_id, caller(), thumb=True),
            # private: ảnh chỉ người được giao xem được -> không cho proxy dùng chung cache.
            headers={"Cache-Control": "private, max-age=86400"},
        )
