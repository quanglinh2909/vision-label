"""DTO vào/ra của module Dataset."""

from __future__ import annotations

import json
from datetime import datetime

from pydantic import Field

from fastapi_modular.core.schemas import InputSchema, OutputSchema
from src.api.datasets.entities.dataset_model import DatasetVersion
from src.api.datasets.exporter import ExportFormat


class DatasetCreate(InputSchema):
    name: str = Field(default="", max_length=100)
    note: str = ""
    val_ratio: float = Field(default=0.2, ge=0.0, le=0.9)
    format: ExportFormat
    # --- nhận diện đối tượng
    # Id các lớp được xuất. Bỏ trống = mọi lớp xuất được sang định dạng này.
    classes: list[int] | None = None
    # Ảnh đã duyệt nhưng không có đối tượng nào — giúp giảm nhận nhầm.
    include_background: bool = True
    # --- phân loại
    question: int | None = Field(default=None, description="Id lớp (câu hỏi) cần xuất")
    # True: "Không rõ" thành một lớp riêng. False: ảnh "Không rõ" bị bỏ khỏi dataset.
    include_unknown: bool = False
    # --- chung
    # Lấy cả ảnh đang chờ duyệt (Cần review), không chỉ ảnh đã duyệt. Nhãn của chúng chưa được xác nhận.
    include_review: bool = False
    arch: str = Field(default="", description="Biến thể model, VD mobilenet_v3_small, resnet50")


class ClassPlanOut(OutputSchema):
    id: int
    name: str
    shape: str = ""
    status: str = Field(description="ok = xuất nguyên vẹn | convert = phải chuyển đổi | no = không xuất được")
    note: str = ""
    objects: int = Field(0, description="Số đối tượng của lớp trong các ảnh đã duyệt")


class OptionCount(OutputSchema):
    id: int
    name: str
    images: int


class QuestionPlanOut(OutputSchema):
    id: int
    name: str
    options: list[OptionCount]
    unknown: int = Field(description="Số ảnh đã duyệt trả lời 'Không rõ'")


class PlanOut(OutputSchema):
    format: ExportFormat
    labeled: int = Field(description="Số ảnh sẽ được xét (đã duyệt, cộng chờ duyệt nếu include_review)")
    in_review: int = Field(0, description="Số ảnh đang chờ duyệt trong project")
    classes: list[ClassPlanOut] = Field(default_factory=list)
    pose_k: int | None = Field(default=None, description="YOLO pose: số điểm dùng chung")
    pose_from: str = ""
    questions: list[QuestionPlanOut] = Field(default_factory=list)
    archs: list[str] = Field(default_factory=list)


class DatasetOut(OutputSchema):
    id: str
    project_id: str
    version: int
    name: str
    note: str
    format: str
    arch: str
    question: str
    class_names: list[str]
    val_ratio: float
    include_background: bool
    include_review: bool = False
    review_count: int = 0
    train_count: int
    val_count: int
    object_count: int
    background_count: int
    skipped_count: int
    path: str
    created_at: datetime
    drive_status: str = ""
    drive_progress: float = 0.0
    drive_link: str = ""
    drive_error: str = ""
    drive_uploaded_at: datetime | None = None
    # Ghép vào link tải (?key=...) để tải không cần đăng nhập — xem DownloadAccess.
    download_key: str = ""

    @classmethod
    def build(cls, item: DatasetVersion, download_key: str) -> DatasetOut:
        data = {k: getattr(item, k) for k in cls.model_fields if k not in ("class_names", "download_key")}
        # Phiên bản tạo trước khi có cột này mang NULL dưới database.
        data["include_review"], data["review_count"] = bool(item.include_review), item.review_count or 0
        return cls(**data, class_names=json.loads(item.class_names or "[]"), download_key=download_key)
