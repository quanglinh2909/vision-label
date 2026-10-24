"""Cấu hình lớp của project, và luật đổi lớp khi đã có nhãn.

Project nhận diện đối tượng — mỗi lớp chọn một kiểu vẽ:

    {"id": 0, "name": "bien_so", "label": "Biển số", "shape": "pose",
     "keypoints": ["TL", "TR", "BR", "BL"], "flip": [1, 0, 3, 2], "auto_corners": true}
    {"id": 1, "name": "xe", "shape": "box"}
    {"id": 2, "name": "vach_ke", "shape": "polygon"}

Project phân loại — mỗi lớp là một câu hỏi cho cả ảnh, kèm các lựa chọn. "Không rõ"
(value = -1) luôn có sẵn và là mặc định, nên không nằm trong `options`:

    {"id": 0, "name": "deo_khau_trang", "label": "Đeo khẩu trang",
     "options": [{"id": 0, "name": "co", "label": "Có"}, {"id": 1, "name": "khong", "label": "Không"}]}

`id` của lớp và của lựa chọn được cấp một lần và không bao giờ đổi; nhãn lưu theo id.
"""

from __future__ import annotations

import json
from collections import Counter
from enum import Enum

from pydantic import BaseModel, Field

from fastapi_modular import BadRequestError
from src.api.projects.entities.project_model import TaskType

UNKNOWN = -1  # lựa chọn "Không rõ" của project phân loại
MAX_KEYPOINTS = 64


class Shape(str, Enum):
    BOX = "box"  # khung chữ nhật
    POSE = "pose"  # các điểm theo thứ tự; khung suy ra từ các điểm
    POLYGON = "polygon"  # đa giác bao viền vật (segment)


class OptionDef(BaseModel):
    id: int | None = Field(default=None, ge=0)
    name: str = Field(min_length=1, max_length=64)  # tên thư mục khi xuất dataset
    label: str = Field(default="", max_length=100)  # tên hiển thị; trống = dùng `name`


class ClassDef(BaseModel):
    # Bỏ trống = lớp mới, server cấp id.
    id: int | None = Field(default=None, ge=0)
    # Tên ghi vào dataset (names trong data.yaml, tên thư mục...). Nên không dấu, không cách.
    name: str = Field(min_length=1, max_length=64)
    # Tên hiển thị trong giao diện, VD "Biển số". Bỏ trống = dùng `name`.
    label: str = Field(default="", max_length=100)
    # --- nhận diện đối tượng
    shape: Shape = Shape.BOX
    keypoints: list[str] = Field(default_factory=list, max_length=MAX_KEYPOINTS)
    # flip[i] = điểm đổi chỗ với điểm i khi lật ngang ảnh. Trống = không điểm nào đổi chỗ.
    flip: list[int] = Field(default_factory=list, max_length=MAX_KEYPOINTS)
    # Pose 4 điểm: tự sắp thành TL, TR, BR, BL theo chiều kim đồng hồ (biển số, giấy tờ...).
    auto_corners: bool = False
    # --- phân loại
    options: list[OptionDef] = Field(default_factory=list, max_length=100)


def load(raw: str) -> list[dict]:
    return json.loads(raw or "[]")


def by_id(classes: list[dict]) -> dict[int, dict]:
    return {c["id"]: c for c in classes}


def usage(task: TaskType, annotations: list[str]) -> tuple[Counter, Counter]:
    """Đếm số nhãn đang dùng mỗi lớp, và (với phân loại) mỗi lựa chọn `(lớp, lựa chọn)`."""
    per_class: Counter = Counter()
    per_option: Counter = Counter()
    for raw in annotations:
        for obj in json.loads(raw or "[]"):
            if task is TaskType.CLASSIFY:
                if obj.get("value", UNKNOWN) != UNKNOWN:
                    per_class[obj["cls"]] += 1
                    per_option[(obj["cls"], obj["value"])] += 1
            else:
                per_class[obj["cls"]] += 1
    return per_class, per_option


def _clean_detect(c: ClassDef) -> dict:
    out: dict = {"id": c.id, "name": c.name, "label": c.label.strip() or c.name, "shape": c.shape.value}
    if c.shape is not Shape.POSE:
        return out
    names = [k.strip() for k in c.keypoints]
    if not names:
        raise BadRequestError(f"Lớp '{c.name}': pose cần ít nhất một điểm")
    if any(not k for k in names):
        raise BadRequestError(f"Lớp '{c.name}': tên điểm không được để trống")
    if len({k.lower() for k in names}) != len(names):
        raise BadRequestError(f"Lớp '{c.name}': tên điểm bị trùng")
    k = len(names)
    flip = c.flip or list(range(k))
    # Lật ngang hai lần phải về như cũ: flip là hoán vị và flip[flip[i]] == i.
    if len(flip) != k or sorted(flip) != list(range(k)) or any(flip[flip[i]] != i for i in range(k)):
        raise BadRequestError(f"Lớp '{c.name}': cặp đổi chỗ khi lật ngang không hợp lệ")
    out |= {"keypoints": names, "flip": flip, "auto_corners": c.auto_corners and k == 4}
    return out


def _clean_classify(c: ClassDef, old: dict | None) -> dict:
    names = [o.name.strip() for o in c.options]
    if len(names) < 2:
        raise BadRequestError(f"Lớp '{c.name}' cần ít nhất 2 lựa chọn (chưa tính 'Không rõ')")
    if any(not n for n in names) or len({n.lower() for n in names}) != len(names):
        raise BadRequestError(f"Lớp '{c.name}': lựa chọn bị trống hoặc trùng tên")
    labels = [o.label.strip() or n for o, n in zip(c.options, names)]
    if any(n.lower() in ("không rõ", "khong ro", "khong_ro", "unknown") for n in names + labels):
        raise BadRequestError(f"Lớp '{c.name}': 'Không rõ' đã có sẵn, không cần thêm")
    known = {o["id"] for o in (old or {}).get("options", [])}
    next_id = max(known | {o.id for o in c.options if o.id is not None}, default=-1) + 1
    options = []
    for o, name, label in zip(c.options, names, labels):
        if o.id is None or o.id not in known:
            o.id, next_id = next_id, next_id + 1
        options.append({"id": o.id, "name": name, "label": label})
    return {"id": c.id, "name": c.name, "label": c.label.strip() or c.name, "options": options}


def normalize(
    task: TaskType,
    new: list[ClassDef],
    old: list[dict],
    used: tuple[Counter, Counter] = (Counter(), Counter()),
) -> list[dict]:
    """Kiểm danh sách lớp mới, cấp id cho lớp mới, và chặn thay đổi làm hỏng nhãn đã có."""
    per_class, per_option = used
    names = [c.name.strip() for c in new]
    if len({n.lower() for n in names}) != len(names):
        raise BadRequestError("Tên lớp bị trùng")
    old_by_id = by_id(old)
    next_id = max(set(old_by_id) | {c.id for c in new if c.id is not None}, default=-1) + 1
    out = []
    for c, name in zip(new, names):
        c.name = name
        if c.id is None or c.id not in old_by_id:
            c.id, next_id = next_id, next_id + 1
        prev = old_by_id.get(c.id)
        item = _clean_classify(c, prev) if task is TaskType.CLASSIFY else _clean_detect(c)
        n = per_class.get(c.id, 0)
        if prev and task is TaskType.DETECT and n:
            if item["shape"] != prev["shape"]:
                raise BadRequestError(f"Lớp '{name}' đang có {n} đối tượng: không đổi kiểu vẽ được")
            if item["shape"] == Shape.POSE.value and len(item["keypoints"]) != len(prev["keypoints"]):
                raise BadRequestError(f"Lớp '{name}' đang có {n} đối tượng: không đổi số điểm được (chỉ đổi tên điểm)")
        if prev and task is TaskType.CLASSIFY:
            kept = {o["id"] for o in item["options"]}
            for o in prev["options"]:
                if o["id"] not in kept and per_option.get((c.id, o["id"])):
                    raise BadRequestError(f"Lựa chọn '{o['name']}' của lớp '{name}' đang được dùng: không xoá được")
        out.append(item)
    kept_ids = {c["id"] for c in out}
    for cid, prev in old_by_id.items():
        if cid not in kept_ids and per_class.get(cid):
            raise BadRequestError(f"Lớp '{prev['name']}' đang có {per_class[cid]} nhãn: không xoá được")
    return out
