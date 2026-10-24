"""Ghi một phiên bản dataset ra đĩa.

Nhận diện đối tượng — định dạng Ultralytics YOLO (detect / pose / segment):

    v3/
    ├── data.yaml
    ├── images/{train,val}/<ten>.<ext>
    └── labels/{train,val}/<ten>.txt

Phân loại — ImageFolder (torchvision), kèm train.py cho MobileNet / ResNet:

    v3/
    ├── train/<lua-chon>/<ten>.<ext>
    ├── val/<lua-chon>/<ten>.<ext>
    ├── classes.json
    └── train.py

Mỗi lớp có kiểu vẽ riêng nên không phải lớp nào cũng xuất được sang mọi định dạng:
`plan()` cho biết trước lớp nào xuất nguyên vẹn, lớp nào phải chuyển đổi, lớp nào không xuất được.
Chạy đồng bộ (copy file) — service gọi qua thread pool.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from src.api.projects.classes import UNKNOWN, Shape
from src.api.projects.entities.project_model import TaskType
from src.core.storage import slugify


class ExportFormat(str, Enum):
    YOLO_DETECT = "yolo-detect"
    YOLO_POSE = "yolo-pose"
    YOLO_SEGMENT = "yolo-segment"
    MOBILENET = "mobilenet"
    RESNET = "resnet"


FORMATS: dict[TaskType, list[ExportFormat]] = {
    TaskType.DETECT: [ExportFormat.YOLO_DETECT, ExportFormat.YOLO_POSE, ExportFormat.YOLO_SEGMENT],
    TaskType.CLASSIFY: [ExportFormat.MOBILENET, ExportFormat.RESNET],
}
# Biến thể model của torchvision cho từng định dạng phân loại; phần tử đầu là mặc định.
ARCHS: dict[ExportFormat, list[str]] = {
    ExportFormat.MOBILENET: ["mobilenet_v3_small", "mobilenet_v3_large"],
    ExportFormat.RESNET: ["resnet18", "resnet34", "resnet50"],
}

OK, CONVERT, NO = "ok", "convert", "no"
UNKNOWN_NAME = "Không rõ"


@dataclass(slots=True)
class ExportItem:
    image_id: str
    filename: str
    source: Path
    annotations: str
    object_count: int


@dataclass(slots=True)
class ExportStats:
    train: int = 0
    val: int = 0
    objects: int = 0
    background: int = 0
    # Đối tượng không ghi được (VD pose chỉ có 1 điểm -> khung rỗng), hoặc ảnh phân loại "Không rõ" bị bỏ.
    skipped: int = 0


@dataclass(slots=True)
class ClassPlan:
    id: int
    name: str
    shape: str
    status: str  # ok | convert | no
    note: str = ""


@dataclass(slots=True)
class PoseSpec:
    k: int
    flip: list[int]
    keypoints: list[str]
    source: str  # lớp quyết định số điểm


@dataclass(slots=True)
class Plan:
    classes: list[ClassPlan] = field(default_factory=list)
    pose: PoseSpec | None = None


# ------------------------------------------------------------------ kế hoạch xuất


def plan(classes: list[dict], fmt: ExportFormat) -> Plan:
    """Lớp nào xuất sang `fmt` được, và có phải chuyển đổi gì không."""
    out = Plan()
    pose_spec = None
    if fmt is ExportFormat.YOLO_POSE:
        # YOLO pose bắt buộc MỌI lớp cùng số điểm. Chọn số điểm có nhiều lớp pose nhất
        # (hoà thì lấy theo lớp đứng trước); lớp pose có số điểm khác không xuất được.
        poses = [c for c in classes if c["shape"] == Shape.POSE.value]
        if poses:
            counts = Counter(len(c["keypoints"]) for c in poses)
            best = max(counts.values())
            first = next(c for c in poses if counts[len(c["keypoints"])] == best)
            pose_spec = PoseSpec(len(first["keypoints"]), first["flip"], first["keypoints"], first["name"])
        out.pose = pose_spec

    for c in classes:
        shape = c["shape"]
        p = ClassPlan(c["id"], c["name"], shape, OK)
        if fmt is ExportFormat.YOLO_DETECT:
            if shape == Shape.POSE.value:
                p.status, p.note = CONVERT, "Chỉ lấy khung bao quanh các điểm, bỏ các điểm."
            elif shape == Shape.POLYGON.value:
                p.status, p.note = CONVERT, "Chỉ lấy khung bao quanh đa giác."
        elif fmt is ExportFormat.YOLO_SEGMENT:
            if shape == Shape.BOX.value:
                p.status, p.note = CONVERT, "Khung thành đa giác 4 đỉnh: mask là hình chữ nhật, kém chính xác hơn vẽ đa giác."
            elif shape == Shape.POSE.value:
                if len(c["keypoints"]) < 3:
                    p.status, p.note = NO, f"Chỉ có {len(c['keypoints'])} điểm, không tạo được đa giác (cần ít nhất 3)."
                else:
                    p.status, p.note = CONVERT, (
                        "Nối các điểm theo thứ tự thành đa giác. Chỉ đúng khi các điểm nằm trên viền vật "
                        "(VD 4 góc biển số), không đúng với khung xương."
                    )
        elif fmt is ExportFormat.YOLO_POSE:
            assert pose_spec is not None or shape != Shape.POSE.value
            if shape == Shape.POSE.value:
                k = len(c["keypoints"])
                if k != pose_spec.k:
                    p.status, p.note = NO, (
                        f"Có {k} điểm, khác {pose_spec.k} điểm của lớp '{pose_spec.source}'. "
                        "YOLO pose bắt buộc mọi lớp cùng số điểm."
                    )
                elif c["flip"] != pose_spec.flip:
                    p.note = f"Cách đổi điểm khi lật ngang khác lớp '{pose_spec.source}': dùng theo lớp đó."
            elif pose_spec is None:
                p.status, p.note = NO, "Project chưa có lớp pose nào để làm chuẩn số điểm."
            else:
                p.status, p.note = CONVERT, (
                    f"Chỉ có khung, {pose_spec.k} điểm ghi là không thấy (v=0). Train được, "
                    "nhưng mAP pose của lớp này luôn bằng 0: hãy xem mAP box."
                )
        out.classes.append(p)
    return out


# ------------------------------------------------------------------ dòng nhãn YOLO


def _f(v: float) -> str:
    return f"{min(max(v, 0.0), 1.0):.6f}"


def _points(obj: dict) -> list[list[float]]:
    """Các điểm thấy được của đối tượng — dùng để tính khung bao."""
    if "box" in obj:
        x1, y1, x2, y2 = obj["box"]
        return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
    if "pts" in obj:
        return [p for p in obj["pts"] if p is not None]
    return obj["poly"]


def _bbox(obj: dict) -> tuple[float, float, float, float] | None:
    pts = _points(obj)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
    if x2 - x1 <= 0 or y2 - y1 <= 0:
        return None
    return (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1


def yolo_line(obj: dict, index: int, fmt: ExportFormat, pose: PoseSpec | None) -> str | None:
    """Một dòng nhãn YOLO; None nếu đối tượng không ghi được ở định dạng này."""
    if fmt is ExportFormat.YOLO_SEGMENT:
        poly = _points(obj)
        if len(poly) < 3:
            return None
        return f"{index} " + " ".join(f"{_f(x)} {_f(y)}" for x, y in poly)
    box = _bbox(obj)
    if box is None:
        return None
    head = f"{index} " + " ".join(_f(v) for v in box)
    if fmt is ExportFormat.YOLO_DETECT:
        return head
    assert pose is not None
    if "pts" in obj:
        kpts = " ".join("0 0 0" if p is None else f"{_f(p[0])} {_f(p[1])} 2" for p in obj["pts"])
    else:
        kpts = " ".join(["0 0 0"] * pose.k)
    return f"{head} {kpts}"


# ------------------------------------------------------------------ ghi ra đĩa


def _is_val(image_id: str, ratio: float) -> bool:
    """Chia cố định theo id: cùng một ảnh luôn rơi vào cùng phía ở mọi phiên bản,
    nên kết quả val giữa các phiên bản so sánh được với nhau."""
    h = int(hashlib.md5(image_id.encode()).hexdigest()[:8], 16)
    return (h % 10_000) / 10_000 < ratio


def _splits(items: list[ExportItem], ratio: float) -> dict[str, str]:
    splits = {it.image_id: ("val" if _is_val(it.image_id, ratio) else "train") for it in items}
    # Có tỉ lệ val mà hash không chọn trúng ảnh nào (dataset nhỏ) -> lấy 1 ảnh cho val,
    # vì trình train cần tập val không rỗng.
    if ratio > 0 and len(items) >= 2 and "val" not in splits.values():
        splits[items[-1].image_id] = "val"
    return splits


def _unique_stems(items: list[ExportItem]) -> dict[str, str]:
    """a.jpg và a.png cùng project sẽ đè file nhãn a.txt — thêm hậu tố id cho bên sau."""
    seen: set[str] = set()
    out: dict[str, str] = {}
    for it in items:
        stem = Path(it.filename).stem
        if stem.lower() in seen:
            stem = f"{stem}_{it.image_id[:6]}"
        seen.add(stem.lower())
        out[it.image_id] = stem
    return out


def _yaml(names: list[str], has_val: bool, fmt: ExportFormat, pose: PoseSpec | None) -> str:
    lines = "\n".join(f"  {i}: {json.dumps(c, ensure_ascii=False)}" for i, c in enumerate(names))
    # Cố ý KHÔNG ghi `path:`. Thiếu nó, Ultralytics lấy thư mục chứa data.yaml làm gốc,
    # nên dataset giải nén ở máy nào, thư mục nào cũng train được ngay.
    head = (
        f"# Sinh bởi VisionLabel ({fmt.value}). Đường dẫn tính từ thư mục chứa file này.\n"
        "train: images/train\n"
        f"val: images/{'val' if has_val else 'train'}\n"
    )
    if fmt is ExportFormat.YOLO_POSE and pose:
        order = ", ".join(f"{i}={k}" for i, k in enumerate(pose.keypoints))
        head += (
            f"\n# {pose.k} điểm theo lớp '{pose.source}': {order}\n"
            f"kpt_shape: [{pose.k}, 3]\n"
            f"flip_idx: {pose.flip}\n"
        )
    return f"{head}\nnames:\n{lines}\n"


def export_yolo(
    root: Path,
    classes: list[dict],
    selected: list[int],
    items: list[ExportItem],
    fmt: ExportFormat,
    val_ratio: float,
    include_background: bool,
) -> tuple[ExportStats, list[str]]:
    """Xuất các lớp `selected` (giữ thứ tự cấu hình). Trả (thống kê, tên lớp theo class index)."""
    if root.exists():
        shutil.rmtree(root)
    pose = plan(classes, fmt).pose
    chosen = [c for c in classes if c["id"] in set(selected)]
    index = {c["id"]: i for i, c in enumerate(chosen)}

    stats = ExportStats()
    rows: list[tuple[ExportItem, list[str]]] = []
    for it in items:
        lines = []
        for obj in json.loads(it.annotations or "[]"):
            if obj["cls"] not in index:
                continue
            line = yolo_line(obj, index[obj["cls"]], fmt, pose)
            if line is None:
                stats.skipped += 1
            else:
                lines.append(line)
        if lines or include_background:
            rows.append((it, lines))

    kept = [it for it, _ in rows]
    splits = _splits(kept, val_ratio)
    stems = _unique_stems(kept)
    for it, lines in rows:
        split = splits[it.image_id]
        img_dir, lbl_dir = root / "images" / split, root / "labels" / split
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)
        stem = stems[it.image_id]
        shutil.copy2(it.source, img_dir / f"{stem}{it.source.suffix.lower()}")
        (lbl_dir / f"{stem}.txt").write_text("".join(f"{ln}\n" for ln in lines), encoding="utf-8")
        setattr(stats, split, getattr(stats, split) + 1)
        stats.objects += len(lines)
        stats.background += not lines

    names = [c["name"] for c in chosen]
    root.mkdir(parents=True, exist_ok=True)
    (root / "data.yaml").write_text(_yaml(names, stats.val > 0, fmt, pose), encoding="utf-8")
    return stats, names


def answer_of(annotations: str, class_id: int) -> int:
    for obj in json.loads(annotations or "[]"):
        if obj.get("cls") == class_id:
            return obj.get("value", UNKNOWN)
    return UNKNOWN  # lớp thêm sau khi ảnh đã gán -> coi như chưa trả lời


def export_imagefolder(
    root: Path,
    cls: dict,
    items: list[ExportItem],
    arch: str,
    val_ratio: float,
    include_unknown: bool,
) -> tuple[ExportStats, list[str]]:
    """Xuất một lớp phân loại thành ImageFolder: mỗi lựa chọn một thư mục.

    Ảnh "Không rõ": thành thư mục riêng nếu `include_unknown`, không thì bỏ khỏi dataset
    (coi như ảnh không thuộc lớp nào)."""
    if root.exists():
        shutil.rmtree(root)
    options = [(o["id"], o["name"], o.get("label") or o["name"]) for o in cls["options"]]
    if include_unknown:
        options.append((UNKNOWN, "khong_ro", UNKNOWN_NAME))
    folders: dict[int, str] = {}
    used: set[str] = set()
    for i, (oid, name, _) in enumerate(options):
        folder = slugify(name, f"class{i}")
        while folder in used:
            folder += "_"
        used.add(folder)
        folders[oid] = folder

    stats = ExportStats()
    rows = []
    for it in items:
        value = answer_of(it.annotations, cls["id"])
        if value not in folders:
            stats.skipped += 1
            continue
        rows.append((it, value))
    kept = [it for it, _ in rows]
    splits = _splits(kept, val_ratio)
    stems = _unique_stems(kept)
    for it, value in rows:
        split = splits[it.image_id]
        target = root / split / folders[value]
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(it.source, target / f"{stems[it.image_id]}{it.source.suffix.lower()}")
        setattr(stats, split, getattr(stats, split) + 1)
        stats.objects += 1

    # ImageFolder đánh số lớp theo tên thư mục sắp xếp a-z: ghi lại để đọc kết quả model.
    order = sorted(folders.values())
    names = {folders[oid]: name for oid, name, _ in options}
    labels = {folders[oid]: label for oid, _, label in options}
    root.mkdir(parents=True, exist_ok=True)
    (root / "classes.json").write_text(
        json.dumps(
            {
                "question": cls["name"],
                "label": cls.get("label") or cls["name"],
                "classes": [
                    {"index": i, "folder": f, "name": names[f], "label": labels[f]} for i, f in enumerate(order)
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (root / "train.py").write_text(TRAIN_SCRIPT.replace("__ARCH__", arch), encoding="utf-8")
    return stats, [labels[f] for f in order]


TRAIN_SCRIPT = '''"""Train __ARCH__ (torchvision) trên dataset ảnh trong thư mục này.

Cài:   pip install torch torchvision
Chạy:  python train.py --epochs 30
Kết quả: best.pt (trọng số + tên lớp) cạnh file này.
"""

import argparse
import json
from pathlib import Path

import torch
from torch import nn
from torchvision import datasets, models, transforms

ROOT = Path(__file__).resolve().parent
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]


def build(arch: str, n: int) -> nn.Module:
    model = getattr(models, arch)(weights="DEFAULT")  # trọng số pretrain ImageNet
    if arch.startswith("mobilenet"):
        model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, n)
    else:
        model.fc = nn.Linear(model.fc.in_features, n)
    return model


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="__ARCH__")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--imgsz", type=int, default=224)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    train_tf = transforms.Compose([
        transforms.RandomResizedCrop(args.imgsz, scale=(0.7, 1.0)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(0.2, 0.2, 0.2),
        transforms.ToTensor(),
        transforms.Normalize(MEAN, STD),
    ])
    val_tf = transforms.Compose([
        transforms.Resize(int(args.imgsz * 1.14)),
        transforms.CenterCrop(args.imgsz),
        transforms.ToTensor(),
        transforms.Normalize(MEAN, STD),
    ])
    train_ds = datasets.ImageFolder(ROOT / "train", train_tf)
    val_ds = datasets.ImageFolder(ROOT / "val", val_tf) if (ROOT / "val").is_dir() else None
    if val_ds is not None and val_ds.classes != train_ds.classes:
        # Lớp quá ít ảnh có thể chỉ nằm ở một phía -> đánh giá theo đúng danh sách lớp của train.
        val_ds.class_to_idx = train_ds.class_to_idx
        val_ds.samples = [(p, train_ds.class_to_idx[Path(p).parent.name]) for p, _ in val_ds.samples
                          if Path(p).parent.name in train_ds.class_to_idx]
    names = {c["folder"]: c["name"] for c in json.loads((ROOT / "classes.json").read_text("utf-8"))["classes"]}
    print("Lớp:", [names.get(c, c) for c in train_ds.classes], "| train:", len(train_ds), "| val:", len(val_ds or []))

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = build(args.arch, len(train_ds.classes)).to(device)
    loader = torch.utils.data.DataLoader(train_ds, args.batch, shuffle=True, num_workers=args.workers)
    val_loader = torch.utils.data.DataLoader(val_ds, args.batch, num_workers=args.workers) if val_ds else None
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, args.epochs)
    loss_fn = nn.CrossEntropyLoss()

    best = -1.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            opt.zero_grad()
            loss = loss_fn(model(x), y)
            loss.backward()
            opt.step()
            total += loss.item() * len(x)
        sched.step()
        acc = float("nan")
        if val_loader:
            model.eval()
            right = seen = 0
            with torch.no_grad():
                for x, y in val_loader:
                    right += (model(x.to(device)).argmax(1).cpu() == y).sum().item()
                    seen += len(y)
            acc = right / max(seen, 1)
        print(f"epoch {epoch}/{args.epochs}  loss {total / len(train_ds):.4f}  val_acc {acc:.3f}")
        score = acc if val_loader else -total
        if score > best:
            best = score
            torch.save({"arch": args.arch, "classes": [names.get(c, c) for c in train_ds.classes],
                        "imgsz": args.imgsz, "state_dict": model.state_dict()}, ROOT / "best.pt")
    print("Đã lưu", ROOT / "best.pt")


if __name__ == "__main__":
    main()
'''


def build_zip(root: Path, folder: str) -> Path:
    """Nén thư mục phiên bản thành <root>.zip, mọi file nằm trong một thư mục `folder/`.

    Tạo một lần, lần sau dùng lại.
    """
    target = root.with_suffix(".zip")
    if target.is_file():
        return target
    tmp = target.with_suffix(".zip.part")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(root.rglob("*")):
            if f.is_file():
                zf.write(f, f"{folder}/{f.relative_to(root).as_posix()}")
    tmp.replace(target)
    return target
