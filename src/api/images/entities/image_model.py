"""Entity của module Image — một ảnh trong project cùng nhãn của nó."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from fastapi_modular import Entity, column, entity, reference
from fastapi_modular.core.clock import utcnow
from src.api.projects.entities.project_model import Project


class ImageStatus(str, Enum):
    """Vòng đời: unlabeled -> (người gán lưu) in_review -> (quản trị viên duyệt) labeled.
    Bị trả lại thì về rejected, người được giao sửa xong lại thành in_review."""

    UNLABELED = "unlabeled"
    IN_REVIEW = "in_review"  # người gán đã nộp, chờ quản trị viên duyệt
    REJECTED = "rejected"  # quản trị viên trả lại kèm ghi chú
    # Đã duyệt — kể cả khi không có đối tượng nào (ảnh nền). Chỉ trạng thái này vào dataset.
    LABELED = "labeled"


@entity(
    unique=[("project_id", "filename")],
    indexes=[("project_id", "status", "filename"), ("project_id", "assigned_to", "status")],
)
@dataclass(slots=True)
class ImageItem(Entity):
    id: str
    project_id: str = field(default="", metadata=reference(Project) | column(length=36))
    # Tên file gốc lúc upload; duy nhất trong một project.
    filename: str = field(default="", metadata=column(length=255))
    # Tên file trên đĩa: <id>.<ext>, tránh trùng và ký tự lạ.
    stored_name: str = field(default="", metadata=column(length=64))
    width: int = 0
    height: int = 0
    status: ImageStatus = ImageStatus.UNLABELED
    # JSON list đối tượng, toạ độ chuẩn hoá 0..1 — xem images/annotations.py.
    annotations: str = field(default="[]", metadata=column(text=True))
    object_count: int = 0
    # Người gán đầu tiên (lúc ảnh chuyển chưa gán -> đã gán) và người lưu gần nhất.
    labeled_by: str = field(default="", metadata=column(length=64))
    labeled_at: datetime | None = None
    edited_by: str = field(default="", metadata=column(length=64))
    edited_at: datetime | None = None

    # Phân công: ảnh chỉ thuộc về MỘT người gán; "" = chưa giao cho ai.
    assigned_to: str = field(default="", metadata=column(length=64))
    assigned_at: datetime | None = None
    # Review của quản trị viên.
    reviewed_by: str = field(default="", metadata=column(length=64))
    reviewed_at: datetime | None = None
    review_note: str = field(default="", metadata=column(text=True))

    # Giữ chỗ khi nhiều người cùng gán: ai đang mở ảnh, giữ tới lúc nào. Hết hạn thì
    # coi như trống (đóng tab, mất mạng không làm kẹt ảnh). `lock_token` đổi mỗi lần
    # giữ chỗ để giành ảnh bằng compare-and-set dưới database.
    locked_by: str = field(default="", metadata=column(length=64))
    locked_until: datetime | None = None
    lock_token: str = field(default="", metadata=column(length=36))

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
