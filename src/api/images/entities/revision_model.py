"""Lịch sử nhãn: mỗi lần gán / sửa / bỏ nhãn một ảnh là một bản ghi."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from fastapi_modular import Entity, column, entity
from fastapi_modular.core.clock import utcnow


class RevisionAction(str, Enum):
    LABEL = "label"  # gán lần đầu (chưa gán -> đã gán)
    EDIT = "edit"  # lưu lại một ảnh đã gán
    CLEAR = "clear"  # đưa về chưa gán
    APPROVE = "approve"  # quản trị viên duyệt -> vào dataset
    REJECT = "reject"  # quản trị viên trả lại cho người gán
    IMPORT = "import"  # nhập kèm nhãn từ một dataset có sẵn (vào thẳng chờ duyệt)


# Không khai khoá ngoại: lịch sử bị xoá chủ động cùng ảnh / project (xem ImageService,
# ProjectService), để việc xoá không vướng thứ tự giữa các bảng.
@entity(indexes=[("image_id", "created_at"), "project_id"])
@dataclass(slots=True)
class ImageRevision(Entity):
    id: str
    image_id: str = field(default="", metadata=column(length=36))
    project_id: str = field(default="", metadata=column(length=36))
    user: str = field(default="", metadata=column(length=64))
    action: RevisionAction = RevisionAction.EDIT
    object_count: int = 0
    # Bản chụp nhãn sau thao tác (JSON, toạ độ 0..1) — đủ để xem lại hay khôi phục.
    annotations: str = field(default="[]", metadata=column(text=True))

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
