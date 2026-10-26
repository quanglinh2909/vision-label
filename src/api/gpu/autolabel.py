"""Đổi kết quả model (agent.py) thành nhãn của app, theo đúng các lớp đã cấu hình trong project.

Mỗi lớp có một "query": tên lớp của model YOLO, hoặc mô tả bằng chữ cho LocateAnything. Nhiều
query ngăn bằng dấu phẩy cùng về một lớp (VD lớp "Xe" = "car, truck, bus"). Đối tượng model tìm ra
mà không khớp lớp nào thì bỏ, nên app chỉ nhận đúng các lớp của project.

Kiểu vẽ của lớp quyết định cách đổi:
    box      khung của model
    polygon  viền mask (YOLO segment); model chỉ có khung thì lấy hình chữ nhật
    pose     điểm của model (YOLO pose, phải đúng số điểm); model chỉ có khung thì không đổi được
"""

from __future__ import annotations

import math
from collections import Counter

from fastapi_modular import BadRequestError
from src.api.gpu.entities.gpu_model import Engine
from src.api.images.annotations import validate_objects
from src.api.projects.classes import Shape
from src.api.projects.entities.project_model import TaskType

MAX_POLY = 200  # đỉnh tối đa của một đa giác lấy từ mask (mask YOLO có thể vài trăm điểm)
KPT_CONF = 0.5  # điểm pose có độ tin cậy thấp hơn = "không thấy"


def default_query(cls: dict, engine: Engine) -> str:
    # YOLO so với tên lớp trong model (thường tiếng Anh, không dấu) -> dùng `name`.
    # LocateAnything hiểu câu mô tả -> dùng tên hiển thị.
    return cls["name"] if engine is Engine.YOLO else (cls.get("label") or cls["name"])


def queries(classes: list[dict], settings: dict, engine: Engine) -> tuple[dict[str, int], list[str]]:
    """({query viết thường: id lớp}, ghi chú về lớp bị bỏ qua)."""
    lookup: dict[str, int] = {}
    notes: list[str] = []
    for c in classes:
        entry = settings.get(str(c["id"]), {})
        if entry.get("enabled", True) is False:
            continue
        if engine is Engine.LOCATE and c["shape"] == Shape.POSE.value:
            notes.append(f"Lớp '{c.get('label') or c['name']}' vẽ kiểu pose: LocateAnything chỉ trả khung nên bỏ qua")
            continue
        text = (entry.get("query") or "").strip() or default_query(c, engine)
        for term in (t.strip() for t in text.split(",")):
            if term:
                lookup.setdefault(term.lower(), c["id"])
    return lookup, notes


def _clamp(v: float) -> float:
    return min(1.0, max(0.0, float(v)))


def _box(b: list[float]) -> list[float] | None:
    x1, y1, x2, y2 = (_clamp(v) for v in b)
    x1, x2 = min(x1, x2), max(x1, x2)
    y1, y2 = min(y1, y2), max(y1, y2)
    return [x1, y1, x2, y2] if x2 - x1 > 1e-4 and y2 - y1 > 1e-4 else None


def order_corners(p: list[list[float]]) -> list[list[float]]:
    """Sắp 4 điểm theo chiều kim đồng hồ từ góc trên-trái (giống orderCorners của object-tool.js)."""
    cx, cy = sum(x for x, _ in p) / 4, sum(y for _, y in p) / 4
    s = sorted(p, key=lambda q: math.atan2(q[1] - cy, q[0] - cx))
    k = min(range(4), key=lambda i: s[i][0] + s[i][1])
    return s[k:] + s[:k]


def _convert(c: dict, det: dict) -> dict | None:
    box = _box(det.get("box") or [0, 0, 0, 0])
    if c["shape"] == Shape.BOX.value:
        return {"cls": c["id"], "box": box} if box else None
    if c["shape"] == Shape.POLYGON.value:
        poly = det.get("poly") or []
        if len(poly) >= 3:
            step = math.ceil(len(poly) / MAX_POLY)
            return {"cls": c["id"], "poly": [[_clamp(x), _clamp(y)] for x, y in poly[::step]]}
        if box:
            x1, y1, x2, y2 = box
            return {"cls": c["id"], "poly": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]}
        return None
    kpts = det.get("kpts") or []
    if len(kpts) != len(c["keypoints"]):
        return None
    pts = [[_clamp(x), _clamp(y)] if conf >= KPT_CONF and (x or y) else None for x, y, conf in kpts]
    if all(p is None for p in pts):
        return None
    if c.get("auto_corners") and len(pts) == 4 and all(pts):
        pts = order_corners(pts)
    return {"cls": c["id"], "pts": pts}


def to_objects(classes: list[dict], lookup: dict[str, int], dets: list[dict]) -> tuple[list[dict], list[str]]:
    """Đổi các phát hiện của model thành nhãn hợp lệ; trả (nhãn, ghi chú)."""
    defs = {c["id"]: c for c in classes}
    objects: list[dict] = []
    unmatched: Counter = Counter()
    failed: Counter = Counter()
    for det in dets:
        cid = lookup.get(str(det.get("label", "")).strip().lower())
        if cid is None:
            unmatched[det.get("label", "?")] += 1
            continue
        obj = _convert(defs[cid], det)
        try:
            if obj is not None:
                objects += validate_objects(TaskType.DETECT, classes, [obj])
                continue
        except BadRequestError:
            pass
        failed[defs[cid].get("label") or defs[cid]["name"]] += 1
    notes = [f"Lớp '{name}': bỏ {n} đối tượng không đổi được sang kiểu vẽ của lớp" for name, n in failed.items()]
    if unmatched:
        top = ", ".join(f"{k} ({n})" for k, n in unmatched.most_common(6))
        notes.append(f"Bỏ đối tượng không thuộc lớp nào của project: {top}")
    return objects, notes
