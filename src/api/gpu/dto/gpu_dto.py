"""DTO vào/ra của module GPU."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from fastapi_modular.core.schemas import InputSchema, OutputSchema
from src.api.gpu.entities.gpu_model import AutoLabelConfig, Engine, GpuJob, GpuServer, JobKind, JobStatus, SavedModel


# ---------------------------------------------------------------- server
class ServerCreate(InputSchema):
    name: str = Field(min_length=1, max_length=100)
    host: str = Field(min_length=1, max_length=255, description="IP hoặc tên máy")
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(default="", max_length=300)
    private_key: str = Field(default="", max_length=20_000, description="Nội dung khoá riêng OpenSSH, không passphrase")
    workdir: str = Field(default="~/visionlabel", min_length=1, max_length=255)
    python: str = Field(default="python3", min_length=1, max_length=255)
    note: str = Field(default="", max_length=1000)


class ServerUpdate(InputSchema):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    host: str | None = Field(default=None, min_length=1, max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = Field(default=None, min_length=1, max_length=64)
    # Trống / không gửi = giữ cái đã lưu (trang cấu hình không bao giờ hiện lại mật khẩu, khoá).
    password: str | None = Field(default=None, max_length=300)
    private_key: str | None = Field(default=None, max_length=20_000)
    clear_password: bool = False
    clear_key: bool = False
    workdir: str | None = Field(default=None, min_length=1, max_length=255)
    python: str | None = Field(default=None, min_length=1, max_length=255)
    note: str | None = Field(default=None, max_length=1000)


class GpuInfo(BaseModel):
    name: str
    mem_used: int = Field(description="MiB")
    mem_total: int = Field(description="MiB")
    util: int = Field(description="%")


class ServerOut(OutputSchema):
    id: str
    name: str
    host: str
    port: int
    username: str
    has_password: bool
    has_key: bool
    workdir: str
    python: str
    note: str
    checked_at: datetime | None
    check_ok: bool
    check_error: str
    os_info: str
    python_info: str
    gpus: list[GpuInfo]
    agent_running: bool = Field(description="Agent đang giữ model trong GPU")

    @classmethod
    def build(cls, s: GpuServer, agent_running: bool) -> ServerOut:
        return cls(
            id=s.id, name=s.name, host=s.host, port=s.port, username=s.username,
            has_password=bool(s.password), has_key=bool(s.private_key), workdir=s.workdir, python=s.python,
            note=s.note, checked_at=s.checked_at, check_ok=s.check_ok, check_error=s.check_error,
            os_info=s.os_info, python_info=s.python_info, gpus=json.loads(s.gpus or "[]"),
            agent_running=agent_running,
        )


class SetupRequest(InputSchema):
    # Cài thêm transformers... và tải sẵn nvidia/LocateAnything-3B (~7 GB).
    locate: bool = False


# ---------------------------------------------------------------- việc chạy trên server
class TrainCreate(InputSchema):
    dataset_id: str = Field(min_length=1, max_length=36)
    server_id: str = Field(min_length=1, max_length=36)
    # YOLO: yolo26n.pt / yolo26s-pose.pt... hoặc đường dẫn best.pt trên server. Trống = theo định dạng dataset.
    model: str = Field(default="", max_length=500)
    epochs: int = Field(default=50, ge=1, le=5000)
    imgsz: int = Field(default=640, ge=32, le=4096)
    batch: int = Field(default=16, ge=-1, le=1024, description="-1 = Ultralytics tự chọn theo bộ nhớ GPU")
    device: str = Field(default="", max_length=32, description="VD 0 hoặc 0,1. Trống = tự chọn")
    workers: int = Field(default=2, ge=0, le=32, description="Số tiến trình đọc dữ liệu; ít thì đỡ tốn RAM")


class JobOut(OutputSchema):
    id: str
    kind: JobKind
    server_id: str
    server_name: str = ""
    project_id: str
    dataset_id: str
    title: str
    params: dict[str, Any]
    status: JobStatus
    progress: float
    epoch: int
    epochs: int
    metrics: dict[str, Any] = Field(description="Chỉ số của epoch gần nhất (mọi cột results.csv)")
    history: dict[str, list[float | None]] | None = Field(None, description="Theo từng epoch; chỉ có khi xem một việc")
    log: str
    remote_dir: str
    weights: str
    gpu_stats: list[dict[str, Any]] = Field(default_factory=list, description="Mức dùng GPU lúc này (khi đang chạy)")
    error: str
    created_by: str
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime

    @classmethod
    def build(cls, j: GpuJob, server_name: str = "", detail: bool = False) -> JobOut:
        return cls(
            id=j.id, kind=j.kind, server_id=j.server_id, server_name=server_name, project_id=j.project_id,
            dataset_id=j.dataset_id, title=j.title, params=json.loads(j.params or "{}"), status=j.status,
            progress=j.progress, epoch=j.epoch, epochs=j.epochs, metrics=json.loads(j.metrics or "{}"),
            history=json.loads(j.history or "{}") if detail else None,
            log=j.log, remote_dir=j.remote_dir, weights=j.weights, gpu_stats=json.loads(j.gpu_stats or "[]"),
            error=j.error, created_by=j.created_by,
            started_at=j.started_at, finished_at=j.finished_at, created_at=j.created_at,
        )


# ---------------------------------------------------------------- tự gán nhãn
class ClassQuery(BaseModel):
    enabled: bool = True
    # YOLO: tên lớp trong model; LocateAnything: mô tả (nên viết tiếng Anh). Nhiều cái ngăn bằng dấu phẩy.
    query: str = Field(default="", max_length=500)


class AutoLabelUpdate(InputSchema):
    server_id: str = Field(default="", max_length=36)
    engine: Engine = Engine.YOLO
    model: str = Field(default="", max_length=500)
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.5, ge=0.0, le=1.0)
    imgsz: int = Field(default=640, ge=32, le=4096)
    mode: Literal["fast", "slow", "hybrid"] = "hybrid"
    max_new_tokens: int = Field(default=8192, ge=256, le=8192)
    on_open: bool = False
    on_open_review: bool = False
    classes: dict[int, ClassQuery] = Field(default_factory=dict)


class TrainedModel(OutputSchema):
    job_id: str
    server_id: str
    path: str
    title: str
    finished_at: datetime | None


class AutoLabelOut(OutputSchema):
    server_id: str
    engine: Engine
    model: str
    conf: float
    iou: float
    imgsz: int
    mode: str
    max_new_tokens: int
    on_open: bool
    on_open_review: bool
    classes: dict[int, ClassQuery]
    updated_by: str
    trained: list[TrainedModel] = Field(default_factory=list, description="Model YOLO đã train xong cho project này")
    loaded: bool = Field(False, description="Model đang nằm trên GPU của server")

    @classmethod
    def build(cls, c: AutoLabelConfig, trained: list[TrainedModel], loaded: bool = False) -> AutoLabelOut:
        return cls(
            server_id=c.server_id, engine=c.engine, model=c.model, conf=c.conf, iou=c.iou, imgsz=c.imgsz,
            mode=c.mode, max_new_tokens=c.max_new_tokens, on_open=c.on_open,
            on_open_review=c.on_open_review,
            classes={int(k): v for k, v in json.loads(c.classes or "{}").items()},
            updated_by=c.updated_by, trained=trained, loaded=loaded,
        )


class AutoLabelAvailable(OutputSchema):
    """Cho trình gán nhãn (mọi người dùng): có nút tự gán nhãn không."""

    enabled: bool
    on_open: bool = False
    on_open_review: bool = False
    engine: Engine | None = None
    server_name: str = ""


class AutoLabelResult(OutputSchema):
    # Chưa lưu: trình gán nhãn thêm vào ảnh để người gán xem lại, sửa rồi mới lưu.
    objects: list[dict[str, Any]]
    notes: list[str] = Field(default_factory=list)
    found: int = Field(description="Số đối tượng model tìm thấy (trước khi lọc theo lớp)")
    seconds: float
    engine: Engine
    model: str


class WarmupResult(OutputSchema):
    seconds: float
    info: dict[str, Any]


# ---------------------------------------------------------------- model đã lưu
class SaveModelRequest(InputSchema):
    name: str = Field(min_length=1, max_length=100)
    note: str = Field(default="", max_length=2000)
    starred: bool = False


class ModelUpdate(InputSchema):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    note: str | None = Field(default=None, max_length=2000)
    starred: bool | None = None


class UseModelRequest(InputSchema):
    server_id: str = Field(min_length=1, max_length=36)


class SavedModelOut(OutputSchema):
    id: str
    project_id: str
    job_id: str
    name: str
    note: str
    starred: bool
    task: str
    base_model: str
    dataset: str
    epochs: int
    metrics: dict[str, Any]
    params: dict[str, Any]
    size: int
    created_by: str
    created_at: datetime

    @classmethod
    def build(cls, m: SavedModel) -> SavedModelOut:
        return cls(
            id=m.id, project_id=m.project_id, job_id=m.job_id, name=m.name, note=m.note, starred=bool(m.starred),
            task=m.task, base_model=m.base_model, dataset=m.dataset, epochs=m.epochs or 0,
            metrics=json.loads(m.metrics or "{}"), params=json.loads(m.params or "{}"), size=m.size or 0,
            created_by=m.created_by, created_at=m.created_at,
        )
