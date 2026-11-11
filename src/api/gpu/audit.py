"""Soát nhãn bằng model: so nhãn đang có của một ảnh với kết quả model (agent.py), tìm chỗ nghi sai.

Mỗi đối tượng quy về khung bao (x1, y1, x2, y2, chuẩn hoá 0..1) rồi ghép nhãn với phát hiện theo IoU.
Các loại nghi vấn, mỗi cái kèm khung để trình gán nhãn khoanh chỗ cần xem:

    missing    model thấy chắc chắn (conf >= `conf`) một đối tượng mà không có nhãn nào ở đó    -> thiếu nhãn
    wrong_cls  nhãn lớp A, model thấy chắc chắn lớp B đúng chỗ đó, và không thấy lớp A          -> sai lớp
    extra      có nhãn mà model không thấy gì ở đó                                              -> nhãn thừa / vẽ nhầm chỗ
    loose      đúng lớp nhưng khung lệch: IoU với khung của model < `loose_iou`                 -> khung chưa khít
    duplicate  hai nhãn gần trùng nhau (IoU >= DUP_IOU)                                         -> vẽ trùng / một vật hai lớp

Chỉ soát các lớp bật ở cấu hình tự gán nhãn: nhãn của lớp tắt không bị coi là thừa, model cũng không
được báo thiếu ở lớp đó. Model không bao giờ đúng tuyệt đối: đây là danh sách để người xem lại, không tự sửa nhãn.
"""

from __future__ import annotations

from typing import Any

from src.api.projects.classes import Shape

MATCH_IOU = 0.5  # nhãn và phát hiện chồng nhau từng này trở lên = cùng một đối tượng
NEAR_IOU = 0.3  # phát hiện chồng lên nhãn từng này thì không báo "thiếu nhãn" (đã có nhãn, chỉ lệch)
DUP_IOU = 0.7

KINDS = ("missing", "wrong_cls", "extra", "loose", "duplicate")


def iou(a: list[float], b: list[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _bbox(points: list) -> list[float] | None:
    pts = [p for p in points if p]
    if len(pts) < 2:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    box = [min(xs), min(ys), max(xs), max(ys)]
    return box if box[2] > box[0] and box[3] > box[1] else None


def label_box(obj: dict) -> list[float] | None:
    if "box" in obj:
        return list(obj["box"])
    return _bbox(obj.get("pts") or obj.get("poly") or [])


def det_box(det: dict, shape: str) -> list[float] | None:
    """Khung của phát hiện, tính cùng cách với nhãn: lớp pose so khung của các điểm, đa giác so khung của mask."""
    if shape == Shape.POSE.value and det.get("kpts"):
        return _bbox([[x, y] for x, y, conf in det["kpts"] if conf >= 0.5])
    if shape == Shape.POLYGON.value and det.get("poly"):
        return _bbox(det["poly"])
    b = det.get("box")
    return [min(b[0], b[2]), min(b[1], b[3]), max(b[0], b[2]), max(b[1], b[3])] if b else None


def _issue(kind: str, box: list[float], **extra: Any) -> dict:
    return {"kind": kind, "box": [round(v, 4) for v in box], **extra}


def compare(
    classes: list[dict],
    lookup: dict[str, int],
    labels: list[dict],
    dets: list[dict],
    *,
    conf: float,
    loose_iou: float,
    check_extra: bool = True,
) -> list[dict]:
    """Các chỗ nghi sai của một ảnh (rỗng = nhãn khớp với model)."""
    shapes = {c["id"]: c["shape"] for c in classes}
    audited = set(lookup.values())

    gt = [(o["cls"], b) for o in labels if o.get("cls") in audited and (b := label_box(o))]
    pred = []
    for d in dets:
        cid = lookup.get(str(d.get("label", "")).strip().lower())
        if cid is not None and (b := det_box(d, shapes[cid])):
            pred.append((cid, float(d.get("conf", 0)), b))

    issues: list[dict] = []
    dups: set[int] = set()  # bản vẽ trùng đã báo "duplicate" thì không báo thêm "extra"

    for i in range(len(gt)):
        for j in range(i + 1, len(gt)):
            if (v := iou(gt[i][1], gt[j][1])) >= DUP_IOU:
                dups.add(j)
                issues.append(_issue("duplicate", gt[j][1], cls=gt[i][0], other=gt[j][0], iou=round(v, 2)))

    # Ghép đúng lớp trước, cặp chồng nhiều nhất trước.
    pairs = sorted(
        ((iou(g[1], p[2]), gi, pi) for gi, g in enumerate(gt) for pi, p in enumerate(pred) if g[0] == p[0]),
        reverse=True,
    )
    used_g: set[int] = set()
    used_p: set[int] = set()
    for v, gi, pi in pairs:
        if v < MATCH_IOU:
            break
        if gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        if v < loose_iou:
            issues.append(_issue("loose", gt[gi][1], cls=gt[gi][0], iou=round(v, 2), pred_box=[round(x, 4) for x in pred[pi][2]]))

    # Nhãn không có phát hiện cùng lớp: model thấy lớp khác ở đó (sai lớp), hoặc không thấy gì (thừa).
    for gi, (cls, box) in enumerate(gt):
        if gi in used_g:
            continue
        best = max(
            ((iou(box, p[2]), pi) for pi, p in enumerate(pred) if pi not in used_p and p[1] >= conf),
            default=(0.0, -1),
        )
        if best[0] >= MATCH_IOU:
            used_p.add(best[1])
            p = pred[best[1]]
            issues.append(_issue("wrong_cls", box, cls=cls, pred=p[0], conf=round(p[1], 2)))
        elif check_extra and gi not in dups:
            issues.append(_issue("extra", box, cls=cls))

    # Phát hiện chắc chắn mà không nằm trên nhãn nào: thiếu nhãn.
    for pi, (cid, c, box) in enumerate(pred):
        if pi in used_p or c < conf:
            continue
        if any(iou(box, g[1]) >= NEAR_IOU for g in gt):
            continue
        issues.append(_issue("missing", box, pred=cid, conf=round(c, 2)))

    return issues
