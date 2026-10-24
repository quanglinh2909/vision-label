"""DTO vào/ra của module Project."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from pydantic import Field

from fastapi_modular.core.schemas import InputSchema, OutputSchema
from src.api.projects.classes import ClassDef
from src.api.projects.entities.project_model import Project, TaskType


class ProjectCreate(InputSchema):
    name: str = Field(min_length=1, max_length=100)
    # Chỉ đặt lúc tạo — đổi loại bài toán sau khi đã có nhãn là phá dữ liệu.
    task: TaskType
    description: str = ""
    # Thường để trống: tạo project xong mới vào mục Lớp để cấu hình.
    classes: list[ClassDef] = Field(default_factory=list)


class ProjectUpdate(InputSchema):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    # Gửi cả danh sách. Lớp có `id` là lớp cũ (sửa), không có là lớp mới; lớp cũ vắng mặt là xoá.
    classes: list[ClassDef] | None = None


class ClassUsage(OutputSchema):
    # {id lớp: số nhãn}. Phân loại: chỉ đếm câu trả lời khác "Không rõ".
    classes: dict[int, int]
    # Phân loại: {"<id lớp>:<id lựa chọn>": số ảnh}.
    options: dict[str, int]


class ProjectOut(OutputSchema):
    id: str
    name: str
    task: TaskType
    classes: list[dict[str, Any]]
    description: str
    # Quản trị viên: đếm trên cả project. Người gán: chỉ đếm ảnh được giao cho mình.
    image_count: int = 0
    unlabeled_count: int = 0
    review_count: int = 0  # chờ duyệt
    rejected_count: int = 0  # bị trả lại, chờ người gán sửa
    labeled_count: int = 0  # đã duyệt
    unassigned_count: int = 0  # chưa gán và chưa giao cho ai (chỉ quản trị viên)
    dataset_count: int = 0
    created_at: datetime
    updated_at: datetime

    @classmethod
    def build(cls, item: Project, **counts: int) -> ProjectOut:
        return cls(
            id=item.id,
            name=item.name,
            task=item.task,
            classes=json.loads(item.classes or "[]"),
            description=item.description,
            created_at=item.created_at,
            updated_at=item.updated_at,
            **counts,
        )
