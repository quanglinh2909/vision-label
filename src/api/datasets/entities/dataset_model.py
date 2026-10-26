"""Entity của module Dataset — một phiên bản dataset đã xuất ra đĩa."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from fastapi_modular import Entity, column, entity, reference
from fastapi_modular.core.clock import utcnow
from src.api.projects.entities.project_model import Project


@entity(unique=[("project_id", "version")])
@dataclass(slots=True)
class DatasetVersion(Entity):
    id: str
    project_id: str = field(default="", metadata=reference(Project) | column(length=36))
    version: int = 0
    name: str = field(default="", metadata=column(length=100))
    note: str = field(default="", metadata=column(text=True))
    val_ratio: float = 0.2
    include_background: bool = True
    # Lấy cả ảnh đang chờ duyệt (nhãn chưa được xác nhận), và số ảnh chờ duyệt được đưa vào xét.
    include_review: bool = False
    review_count: int = 0
    train_count: int = 0
    val_count: int = 0
    object_count: int = 0
    background_count: int = 0
    # Đối tượng không ghi được ở định dạng này, hoặc ảnh "Không rõ" bị bỏ (phân loại).
    skipped_count: int = 0
    # yolo-detect | yolo-pose | yolo-segment | mobilenet | resnet — xem datasets/exporter.py
    format: str = field(default="", metadata=column(length=32))
    # Phân loại: biến thể model trong train.py (VD mobilenet_v3_small).
    arch: str = field(default="", metadata=column(length=64))
    # Tên lớp theo class index của dataset (JSON list).
    class_names: str = field(default="[]", metadata=column(text=True))
    # Phân loại: lớp (câu hỏi) được xuất.
    question: str = field(default="", metadata=column(length=64))
    # Thư mục tuyệt đối chứa data.yaml.
    path: str = field(default="", metadata=column(text=True))

    # Bản zip trên Google Drive (xem module drive). status: "" | uploading | done | error
    drive_status: str = field(default="", metadata=column(length=16))
    drive_progress: float = 0.0  # 0..1
    drive_file_id: str = field(default="", metadata=column(length=128))
    drive_link: str = field(default="", metadata=column(text=True))
    drive_error: str = field(default="", metadata=column(text=True))
    drive_uploaded_at: datetime | None = None

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
