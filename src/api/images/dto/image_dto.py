"""DTO vào/ra của module Image."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from fastapi_modular.core.schemas import InputSchema, OutputSchema
from src.api.images.entities.image_model import ImageItem, ImageStatus
from src.api.images.entities.revision_model import RevisionAction
from src.api.images.locks import holder


class AnnotationsUpdate(InputSchema):
    # Hình dạng từng phần tử tuỳ loại project — kiểm ở images/annotations.py.
    objects: list[dict[str, Any]] = Field(default_factory=list)
    # True = lưu và duyệt luôn (chỉ quản trị viên, nút "Duyệt"). False = lưu, chờ duyệt.
    approve: bool = False


class ClaimRequest(InputSchema):
    # Ảnh đã đi qua trong phiên này — không phát lại (VD người gán vừa bấm bỏ qua).
    exclude: list[str] = Field(default_factory=list, max_length=5000)


class AssignRequest(InputSchema):
    username: str = Field(min_length=1, max_length=64)
    count: int = Field(ge=1, le=100_000)


class RevokeRequest(InputSchema):
    username: str = Field(min_length=1, max_length=64)
    # unlabeled = ảnh chưa làm; rejected = ảnh bị trả lại chưa sửa (giữ nhãn cũ, về kho chưa giao)
    scope: Literal["unlabeled", "rejected"] = "unlabeled"


class ApproveRequest(InputSchema):
    ids: list[str] = Field(min_length=1, max_length=5000)


class RejectManyRequest(InputSchema):
    ids: list[str] = Field(min_length=1, max_length=5000)
    note: str = Field(min_length=1, max_length=1000, description="Cần sửa gì (chung cho các ảnh)")


class RejectRequest(InputSchema):
    note: str = Field(min_length=1, max_length=1000, description="Cần sửa gì")


class LockRequest(InputSchema):
    # Giành quyền từ người đang giữ (VD họ quên đóng tab).
    force: bool = False


class ImageOut(OutputSchema):
    id: str
    project_id: str
    filename: str
    width: int
    height: int
    status: ImageStatus
    object_count: int
    annotations: list[dict[str, Any]]
    labeled_by: str = Field(description="Người gán đầu tiên")
    labeled_at: datetime | None
    edited_by: str = Field(description="Người lưu gần nhất")
    edited_at: datetime | None
    locked_by: str = Field(description="Người đang giữ ảnh; rỗng nếu ảnh trống")
    assigned_to: str = Field(description="Người được giao; rỗng nếu chưa giao")
    reviewed_by: str
    reviewed_at: datetime | None
    review_note: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def build(cls, item: ImageItem) -> ImageOut:
        return cls(
            id=item.id,
            project_id=item.project_id,
            filename=item.filename,
            width=item.width,
            height=item.height,
            status=item.status,
            object_count=item.object_count,
            annotations=json.loads(item.annotations or "[]"),
            labeled_by=item.labeled_by,
            labeled_at=item.labeled_at,
            edited_by=item.edited_by,
            edited_at=item.edited_at,
            locked_by=holder(item),
            assigned_to=item.assigned_to,
            reviewed_by=item.reviewed_by,
            reviewed_at=item.reviewed_at,
            review_note=item.review_note,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )


class ImageRef(OutputSchema):
    """Bản rút gọn để duyệt tuần tự trong trình gán nhãn."""

    id: str
    filename: str
    status: ImageStatus


class RevisionOut(OutputSchema):
    id: str
    user: str
    action: RevisionAction
    object_count: int
    created_at: datetime


class UploadResult(OutputSchema):
    added: int
    imported: int = Field(0, description="Số ảnh nhập kèm nhãn (vào Cần review, hoặc Đã duyệt nếu approved)")
    skipped: list[str] = Field(default_factory=list, description="Tên đã có trong project")
    errors: list[str] = Field(default_factory=list, description="File không đọc được")
