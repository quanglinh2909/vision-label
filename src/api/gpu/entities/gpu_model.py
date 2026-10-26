"""Entity của module GPU — server GPU, việc chạy trên server (cài môi trường / train), cấu hình tự gán nhãn."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from fastapi_modular import Entity, column, entity
from fastapi_modular.core.clock import utcnow


@entity(unique=["name"])
@dataclass(slots=True)
class GpuServer(Entity):
    """Một máy Ubuntu có GPU NVIDIA, app kết nối qua SSH."""

    id: str
    name: str = field(default="", metadata=column(length=100))
    host: str = field(default="", metadata=column(length=255))
    port: int = 22
    username: str = field(default="", metadata=column(length=64))
    # Mật khẩu SSH, hoặc khoá riêng (nội dung file id_ed25519 / id_rsa, không đặt passphrase).
    # Cả hai trống = dùng khoá SSH có sẵn của máy chạy app (~/.ssh/id_*, ssh-agent).
    # Lưu trong database như secret của Google Drive: giữ file data/ như giữ mật khẩu.
    password: str = field(default="", metadata=column(text=True))
    private_key: str = field(default="", metadata=column(text=True))
    # Thư mục làm việc trên server: agent.py, venv/, jobs/<id>/ (dataset + kết quả train).
    workdir: str = field(default="~/visionlabel", metadata=column(length=255))
    # Python dùng để chạy agent / train. Cài môi trường xong thì thành <workdir>/venv/bin/python.
    python: str = field(default="python3", metadata=column(length=255))
    note: str = field(default="", metadata=column(text=True))

    # Lần kiểm tra kết nối gần nhất.
    checked_at: datetime | None = None
    check_ok: bool = False
    check_error: str = field(default="", metadata=column(text=True))
    os_info: str = field(default="", metadata=column(text=True))
    python_info: str = field(default="", metadata=column(text=True))
    # JSON list [{"name", "mem_used", "mem_total", "util"}] (MiB, %) từ nvidia-smi.
    gpus: str = field(default="[]", metadata=column(text=True))

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)


class JobKind(str, Enum):
    SETUP = "setup"  # cài venv + ultralytics (+ LocateAnything) trên server
    TRAIN = "train"  # train một phiên bản dataset


class JobStatus(str, Enum):
    UPLOADING = "uploading"  # đang gửi dataset lên server
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    STOPPED = "stopped"


# Không khai khoá ngoại tới project / dataset: xoá project không bị vướng việc train cũ,
# và kết quả train (trọng số trên server) vẫn còn dùng được.
@entity(indexes=["project_id", "server_id"])
@dataclass(slots=True)
class GpuJob(Entity):
    id: str
    kind: JobKind = JobKind.TRAIN
    server_id: str = field(default="", metadata=column(length=36))
    project_id: str = field(default="", metadata=column(length=36))
    dataset_id: str = field(default="", metadata=column(length=36))
    title: str = field(default="", metadata=column(length=255))
    # JSON: model, epochs, imgsz, batch, device (train); locate (setup).
    params: str = field(default="{}", metadata=column(text=True))
    status: JobStatus = JobStatus.UPLOADING
    progress: float = 0.0  # 0..1 — lúc UPLOADING là tiến độ gửi dataset, lúc RUNNING là tiến độ train
    epoch: int = 0
    epochs: int = 0
    # JSON: chỉ số của epoch gần nhất (results.csv của Ultralytics).
    metrics: str = field(default="{}", metadata=column(text=True))
    # JSON {"train/box_loss": [epoch 1, epoch 2, ...], ...}: cả quá trình, để vẽ xu hướng.
    history: str = field(default="{}", metadata=column(text=True))
    log: str = field(default="", metadata=column(text=True))  # đuôi log trên server
    remote_dir: str = field(default="", metadata=column(text=True))
    weights: str = field(default="", metadata=column(text=True))  # đường dẫn best.pt trên server
    # JSON: mức dùng GPU của server ở lần hỏi tiến độ gần nhất (nvidia-smi), xem gpu_service.parse_gpus.
    gpu_stats: str = field(default="[]", metadata=column(text=True))
    error: str = field(default="", metadata=column(text=True))
    created_by: str = field(default="", metadata=column(length=64))
    started_at: datetime | None = None
    finished_at: datetime | None = None

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)


class Engine(str, Enum):
    YOLO = "yolo"  # Ultralytics: model có sẵn (yolo26n.pt...) hoặc model vừa train
    LOCATE = "locate"  # nvidia/LocateAnything-3B: tìm theo mô tả chữ, chỉ trả khung


@entity()
@dataclass(slots=True)
class AutoLabelConfig(Entity):
    """Cấu hình tự gán nhãn của một project; `id` chính là id project."""

    id: str
    server_id: str = field(default="", metadata=column(length=36))
    engine: Engine = Engine.YOLO
    model: str = field(default="", metadata=column(text=True))
    conf: float = 0.25
    iou: float = 0.5  # YOLO
    imgsz: int = 640  # YOLO
    mode: str = field(default="hybrid", metadata=column(length=16))  # LocateAnything: fast | slow | hybrid
    max_new_tokens: int = 8192  # LocateAnything
    # Mở ảnh chưa có nhãn trong trình gán nhãn thì tự chạy luôn.
    on_open: bool = False
    # Mở ảnh trong Cần review (đã có nhãn) là tự chạy, chỉ thêm đối tượng còn thiếu.
    on_open_review: bool = False
    # JSON {"<id lớp>": {"enabled": bool, "query": "car, truck"}}. query trống = dùng tên lớp.
    classes: str = field(default="{}", metadata=column(text=True))
    updated_by: str = field(default="", metadata=column(length=64))

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)


# Không khai khoá ngoại: model đã lưu được giữ lại kể cả khi xoá việc train, server hay project.
@entity(indexes=["project_id"])
@dataclass(slots=True)
class SavedModel(Entity):
    """Một model train xong được chép về máy chạy app để lưu trữ (file ở Storage.model_path)."""

    id: str
    project_id: str = field(default="", metadata=column(length=36))
    job_id: str = field(default="", metadata=column(length=36))
    name: str = field(default="", metadata=column(length=100))
    note: str = field(default="", metadata=column(text=True))
    starred: bool = False  # đánh dấu (VD bản đang dùng chính thức)
    task: str = field(default="", metadata=column(length=16))  # detect | pose | segment | classify
    base_model: str = field(default="", metadata=column(length=255))
    dataset: str = field(default="", metadata=column(length=100))
    epochs: int = 0
    # JSON: chỉ số của epoch cuối lúc lưu (giống GpuJob.metrics), và tham số train.
    metrics: str = field(default="{}", metadata=column(text=True))
    params: str = field(default="{}", metadata=column(text=True))
    size: int = 0  # byte
    created_by: str = field(default="", metadata=column(length=64))

    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
