"""Định dạng nhãn lưu trong database, và cách kiểm nhãn client gửi lên.

Toạ độ luôn chuẩn hoá về 0..1 theo kích thước ảnh, nên không phụ thuộc ảnh hiển thị to hay nhỏ.
Kiểu của mỗi đối tượng do kiểu vẽ của lớp quyết định (xem projects/classes.py):

    box     {"cls": 1, "box": [x1, y1, x2, y2]}
    pose    {"cls": 0, "pts": [[x, y], null, ...]}     đúng số điểm của lớp; null = điểm không thấy
    polygon {"cls": 2, "poly": [[x, y], ...]}          ít nhất 3 đỉnh

Project phân loại lưu một câu trả lời cho mỗi lớp, đủ mọi lớp theo thứ tự cấu hình:

    {"cls": 0, "value": 1}        value = id lựa chọn, -1 = Không rõ
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, Field, TypeAdapter, ValidationError, model_validator

from fastapi_modular import BadRequestError
from src.api.projects.classes import UNKNOWN, Shape, by_id
from src.api.projects.entities.project_model import TaskType

Unit = Annotated[float, Field(ge=0.0, le=1.0)]
Point = tuple[Unit, Unit]


class BoxObject(BaseModel):
    cls: int
    box: tuple[Unit, Unit, Unit, Unit]

    @model_validator(mode="after")
    def _ordered(self) -> BoxObject:
        x1, y1, x2, y2 = self.box
        if x2 <= x1 or y2 <= y1:
            raise ValueError("box phải có x2 > x1 và y2 > y1")
        return self


class PoseObject(BaseModel):
    cls: int
    pts: list[Point | None] = Field(min_length=1)

    @model_validator(mode="after")
    def _visible(self) -> PoseObject:
        if all(p is None for p in self.pts):
            raise ValueError("pose cần ít nhất một điểm thấy được")
        return self


class PolygonObject(BaseModel):
    cls: int
    poly: list[Point] = Field(min_length=3, max_length=2000)


_SHAPES: dict[str, TypeAdapter] = {
    Shape.BOX.value: TypeAdapter(BoxObject),
    Shape.POSE.value: TypeAdapter(PoseObject),
    Shape.POLYGON.value: TypeAdapter(PolygonObject),
}

# Trường toạ độ bắt buộc của từng kiểu vẽ, và tên hiển thị.
_KEYS = {Shape.BOX.value: ("box", "detect"), Shape.POSE.value: ("pts", "pose"), Shape.POLYGON.value: ("poly", "segment")}


def _detect(classes: list[dict], objects: list[Any]) -> list[dict]:
    defs = by_id(classes)
    clean = []
    for n, obj in enumerate(objects, 1):
        cfg = defs.get(obj.get("cls") if isinstance(obj, dict) else None)
        if cfg is None:
            raise BadRequestError(f"Đối tượng #{n}: lớp không tồn tại trong project")
        key, label = _KEYS[cfg["shape"]]
        if key not in obj:
            raise BadRequestError(f"Đối tượng #{n}: lớp '{cfg['name']}' vẽ kiểu {label}, cần trường '{key}'")
        try:
            parsed = _SHAPES[cfg["shape"]].validate_python(obj)
        except ValidationError as e:
            raise BadRequestError(f"Đối tượng #{n} ({cfg['name']}): {e.errors()[0]['msg']}") from e
        if cfg["shape"] == Shape.POSE.value and len(parsed.pts) != len(cfg["keypoints"]):
            raise BadRequestError(f"Đối tượng #{n} ({cfg['name']}): cần đúng {len(cfg['keypoints'])} điểm")
        clean.append(parsed.model_dump(mode="json"))
    return clean


def _classify(classes: list[dict], objects: list[Any]) -> list[dict]:
    given = {o.get("cls"): o.get("value", UNKNOWN) for o in objects if isinstance(o, dict)}
    clean = []
    for c in classes:
        value = given.get(c["id"], UNKNOWN)
        if value != UNKNOWN and value not in {o["id"] for o in c["options"]}:
            raise BadRequestError(f"Lớp '{c['name']}': lựa chọn không tồn tại")
        clean.append({"cls": c["id"], "value": value})
    return clean


def validate_objects(task: TaskType, classes: list[dict], objects: list[Any]) -> list[dict]:
    """Kiểm nhãn client gửi lên theo cấu hình lớp; trả về list dict sạch để lưu."""
    if task is TaskType.CLASSIFY:
        return _classify(classes, objects)
    return _detect(classes, objects)


def count_objects(task: TaskType, clean: list[dict]) -> int:
    """Số đối tượng (nhận diện), hoặc số câu đã trả lời khác "Không rõ" (phân loại)."""
    if task is TaskType.CLASSIFY:
        return sum(o["value"] != UNKNOWN for o in clean)
    return len(clean)
