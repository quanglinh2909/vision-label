"""Tìm ảnh trùng trong một project, để giữ 1 ảnh mỗi nhóm và xoá phần thừa.

Hai cách gom (dùng một hoặc cả hai):
- Theo tên gốc Roboflow: "ndata59_jpg.rf.aae7ca....jpg" và "ndata59_jpg.rf.cbebc5....jpg" là các bản tăng cường
  (augmentation) của cùng ảnh gốc "ndata59_jpg" -> cùng nhóm.
- Theo hình giống nhau: dHash 64 bit của ảnh thu nhỏ; hai ảnh lệch không quá `threshold` bit, VÀ có cùng bộ nhãn
  (cùng các lớp, cùng số lượng), là trùng. Bắt được ảnh trùng nhưng khác tên. Điều kiện cùng nhãn là bắt buộc: ảnh
  nhỏ như crop biển số thu về 9x8 điểm rất dễ trùng dấu vân tay dù là hai biển khác nhau (VD 61-D1 079.11 và
  63-B9 579.26), nhưng bộ ký tự thì khác.
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

from PIL import Image

RF_SUFFIX = re.compile(r"\.rf\.[0-9a-f]{8,}", re.I)
# Thứ tự ưu tiên khi chọn ảnh giữ lại trong một nhóm: đã duyệt > chờ duyệt > bị trả lại > chưa gán.
STATUS_RANK = {"labeled": 3, "in_review": 2, "rejected": 1, "unlabeled": 0}


def base_name(filename: str) -> str:
    """Tên gốc trước khi Roboflow thêm ".rf.<mã>"; tên không có phần đó thì giữ nguyên (bỏ đuôi file)."""
    stem = Path(filename).stem
    return RF_SUFFIX.split(stem)[0].lower()


def dhash(path: Path) -> str:
    """dHash 64 bit (16 ký tự hex): so độ sáng từng điểm với điểm bên phải trên ảnh xám 9x8."""
    with Image.open(path) as im:
        px = list(im.convert("L").resize((9, 8), Image.BILINEAR).getdata())
    bits = 0
    for r in range(8):
        for c in range(8):
            bits = (bits << 1) | (px[r * 9 + c] > px[r * 9 + c + 1])
    return f"{bits:016x}"


def group(items: list[dict], by_name: bool, by_image: bool, threshold: int) -> list[list[dict]]:
    """Các nhóm trùng (≥ 2 ảnh). items: [{id, filename, phash, ...}]. Ảnh đầu mỗi nhóm là ảnh nên giữ."""
    parent = list(range(len(items)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    if by_name:
        seen: dict[str, int] = {}
        for i, it in enumerate(items):
            key = base_name(it["filename"])
            if key in seen:
                union(seen[key], i)
            else:
                seen[key] = i
    if by_image:
        hashes = [int(it["phash"], 16) if it.get("phash") else None for it in items]
        labels = [tuple(sorted(it.get("classes", []))) for it in items]  # bộ nhãn: id lớp của từng đối tượng
        # Chia 64 bit thành (threshold + 1) dải: hai ảnh lệch ≤ threshold bit chắc chắn trùng ít nhất một dải
        # (nguyên lý chuồng bồ câu) -> chỉ cần so các ảnh chung dải, khỏi so mọi cặp.
        bands = max(1, min(threshold + 1, 16))
        width = 64 // bands
        buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
        for i, h in enumerate(hashes):
            if h is None:
                continue
            for b in range(bands):
                buckets[(b, (h >> (b * width)) & ((1 << width) - 1))].append(i)
        checked: set[tuple[int, int]] = set()
        for members in buckets.values():
            if len(members) < 2 or len(members) > 2000:  # dải quá đông (ảnh trơn, toàn đen...) bỏ qua cho nhanh
                continue
            for x in range(len(members)):
                for y in range(x + 1, len(members)):
                    a, b = members[x], members[y]
                    if (a, b) in checked:
                        continue
                    checked.add((a, b))
                    if bin(hashes[a] ^ hashes[b]).count("1") <= threshold and labels[a] == labels[b]:
                        union(a, b)

    groups: dict[int, list[dict]] = defaultdict(list)
    for i, it in enumerate(items):
        groups[find(i)].append(it)
    out = [g for g in groups.values() if len(g) > 1]
    for g in out:
        g.sort(key=lambda it: (-STATUS_RANK.get(it["status"], 0), -it["object_count"], it["created"], it["filename"]))
    out.sort(key=lambda g: g[0]["filename"])
    return out
