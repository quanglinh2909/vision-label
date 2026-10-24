"""Entity của module Project — biểu diễn nội bộ, không trả thẳng ra HTTP."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from fastapi_modular import Entity, column, entity
from fastapi_modular.core.clock import utcnow


class TaskType(str, Enum):
    """Loại bài toán — chọn lúc tạo project, quyết định cách gán nhãn và các định dạng xuất."""

    # Khoanh đối tượng trong ảnh. Mỗi lớp tự chọn kiểu vẽ: khung, pose (điểm) hoặc đa giác.
    DETECT = "detect"
    # Phân loại cả ảnh. Mỗi lớp là một câu hỏi (VD "Đeo khẩu trang") có các lựa chọn.
    CLASSIFY = "classify"


@entity(unique=["name"])
@dataclass(slots=True)
class Project(Entity):
    id: str
    name: str = field(default="", metadata=column(length=100))
    task: TaskType = TaskType.DETECT
    # Danh sách lớp, JSON list — cấu trúc ở projects/classes.py. Nhãn trỏ tới lớp bằng `id`
    # cố định (không phải vị trí), nên đổi thứ tự hay thêm lớp không làm hỏng nhãn cũ.
    classes: str = field(default="[]", metadata=column(text=True))
    description: str = field(default="", metadata=column(text=True))

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
