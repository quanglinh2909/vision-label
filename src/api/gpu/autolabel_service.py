"""Tự gán nhãn: cấu hình theo project, và chạy model trên server GPU cho một ảnh.

Kết quả KHÔNG được lưu: trình gán nhãn thêm vào ảnh đang mở để người gán xem lại, sửa, rồi
lưu như bình thường (vẫn qua Cần review).
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

from PIL import Image, ImageOps
from starlette.concurrency import run_in_threadpool

from fastapi_modular import BadRequestError, NotFoundError, injectable
from fastapi_modular.core.logging import get_logger
from fastapi_modular.infrastructure.database import Repository
from src.api.auth.guards import Caller
from src.api.gpu.agent import LOCATE_DEFAULT
from src.api.gpu.autolabel import queries, to_objects
from src.api.gpu.dto.gpu_dto import AutoLabelAvailable, AutoLabelOut, AutoLabelResult, AutoLabelUpdate, WarmupResult
from src.api.gpu.entities.gpu_model import AutoLabelConfig, Engine
from src.api.gpu.gpu_service import BASE_MODEL, GpuService
from src.api.images.image_service import ImageService
from src.api.projects.classes import load as load_classes
from src.api.projects.entities.project_model import TaskType
from src.api.projects.project_service import ProjectService
from src.core.storage import Storage

log = get_logger(__name__)

MAX_SIDE = 2560  # LocateAnything nhận tới ~2.5K; toạ độ chuẩn hoá nên thu nhỏ không làm lệch nhãn


def _encode(path: Path) -> str:
    """Ảnh gửi đi: đã xoay theo EXIF (đúng ảnh người gán nhìn thấy), JPEG, base64."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if max(im.size) > MAX_SIDE:
            im.thumbnail((MAX_SIDE, MAX_SIDE))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


def model_of(cfg: AutoLabelConfig) -> str:
    if cfg.model.strip():
        return cfg.model.strip()
    return LOCATE_DEFAULT if cfg.engine is Engine.LOCATE else BASE_MODEL["detect"]


@injectable
class AutoLabelService:
    def __init__(
        self,
        repo: Repository[AutoLabelConfig],
        gpu: GpuService,
        projects: ProjectService,
        images: ImageService,
        storage: Storage,
    ) -> None:
        self._repo = repo
        self._gpu = gpu
        self._projects = projects
        self._images = images
        self._storage = storage

    async def config(self, project_id: str) -> AutoLabelConfig:
        await self._projects.get_entity(project_id)
        return await self._repo.get(project_id) or AutoLabelConfig(id=project_id)

    async def out(self, project_id: str) -> AutoLabelOut:
        cfg = await self.config(project_id)
        return AutoLabelOut.build(cfg, await self._gpu.trained_models(project_id), await self._loaded(cfg))

    async def _loaded(self, cfg: AutoLabelConfig) -> bool:
        """Model của project đang nằm trên GPU chưa (hỏi agent nếu nó đang chạy)."""
        if not cfg.server_id:
            return False
        try:
            info = await self._gpu.call_if_running(cfg.server_id, {"op": "ping"}, timeout=30)
        except (BadRequestError, NotFoundError):
            return False
        return bool(info) and f"{cfg.engine.value}:{model_of(cfg)}" in info.get("loaded", [])

    async def unload(self, project_id: str) -> AutoLabelOut:
        """Gỡ model của project khỏi GPU. Lần tự gán nhãn sau sẽ tự nạp lại."""
        cfg = await self._ready(project_id)
        await self._gpu.call_if_running(cfg.server_id, {"op": "unload", "engine": cfg.engine.value, "model": model_of(cfg)})
        return await self.out(project_id)

    async def update(self, project_id: str, payload: AutoLabelUpdate, by: str) -> AutoLabelOut:
        project = await self._projects.get_entity(project_id)
        if payload.server_id:
            await self._gpu.get_server(payload.server_id)
        known = {c["id"] for c in load_classes(project.classes)}
        cfg = await self.config(project_id)
        for key in ("server_id", "engine", "conf", "iou", "imgsz", "mode", "max_new_tokens", "on_open", "on_open_review"):
            setattr(cfg, key, getattr(payload, key))
        cfg.model = payload.model.strip()
        cfg.classes = json.dumps(
            {str(k): v.model_dump() for k, v in payload.classes.items() if k in known}, ensure_ascii=False
        )
        cfg.updated_by = by
        await self._repo.save(cfg)
        return await self.out(project_id)

    async def use_saved(self, model_id: str, server_id: str, by: str) -> AutoLabelOut:
        """Dùng một model đã lưu cho nút Tự gán nhãn: đẩy file lên server GPU rồi cấu hình luôn."""
        m = await self._gpu.get_model(model_id)
        project = await self._projects.get_entity(m.project_id)
        if project.task is not TaskType.DETECT or m.task == "classify":
            raise BadRequestError("Tự gán nhãn chỉ dùng được model YOLO detect / pose / segment")
        remote = await self._gpu.deploy_model(model_id, server_id)
        cfg = await self.config(m.project_id)
        cfg.server_id, cfg.engine, cfg.model, cfg.updated_by = server_id, Engine.YOLO, remote, by
        await self._repo.save(cfg)
        return await self.out(m.project_id)

    async def available(self, project_id: str) -> AutoLabelAvailable:
        project = await self._projects.get_entity(project_id)
        cfg = await self._repo.get(project_id)
        if project.task is not TaskType.DETECT or cfg is None or not cfg.server_id:
            return AutoLabelAvailable(enabled=False)
        try:
            server = await self._gpu.get_server(cfg.server_id)
        except NotFoundError:  # server đã bị xoá
            return AutoLabelAvailable(enabled=False)
        return AutoLabelAvailable(enabled=True, on_open=cfg.on_open, on_open_review=cfg.on_open_review, engine=cfg.engine, server_name=server.name)

    async def _ready(self, project_id: str) -> AutoLabelConfig:
        cfg = await self._repo.get(project_id)
        if cfg is None or not cfg.server_id:
            raise BadRequestError(
                "Project chưa cấu hình tự gán nhãn. Quản trị viên vào mục Model AI để chọn server GPU và model."
            )
        return cfg

    async def warmup(self, project_id: str) -> WarmupResult:
        """Nạp model lên GPU trước (lần đầu có thể phải tải model về server), để người gán khỏi chờ."""
        cfg = await self._ready(project_id)
        resp = await self._gpu.agent_call(cfg.server_id, {"op": "load", "engine": cfg.engine.value, "model": model_of(cfg)})
        if not resp.get("ok"):
            raise BadRequestError(f"Không nạp được model: {resp.get('error')}")
        info = await self._gpu.agent_call(cfg.server_id, {"op": "ping"}, timeout=120)
        return WarmupResult(seconds=resp.get("seconds", 0), info={k: v for k, v in info.items() if k not in ("ok", "seconds")})

    async def run(self, image_id: str, who: Caller) -> AutoLabelResult:
        item = await self._images.get_for(image_id, who)
        project = await self._projects.get_entity(item.project_id)
        if project.task is not TaskType.DETECT:
            raise BadRequestError("Tự gán nhãn chỉ dùng cho project nhận diện đối tượng")
        cfg = await self._ready(project.id)
        classes = load_classes(project.classes)
        lookup, notes = queries(classes, json.loads(cfg.classes or "{}"), cfg.engine)
        if not lookup:
            raise BadRequestError("Không có lớp nào bật tự gán nhãn (xem mục Model AI)")
        path = self._storage.image_path(project.id, item.stored_name)
        if not path.is_file():
            raise BadRequestError(f"Mất file ảnh trên đĩa: {item.filename}")
        model = model_of(cfg)
        msg = {
            "op": "detect", "engine": cfg.engine.value, "model": model, "image": await run_in_threadpool(_encode, path),
            "conf": cfg.conf, "iou": cfg.iou, "imgsz": cfg.imgsz,
            "prompts": list(lookup), "mode": cfg.mode, "max_new_tokens": cfg.max_new_tokens,
        }
        resp = await self._gpu.agent_call(cfg.server_id, msg)
        if not resp.get("ok"):
            raise BadRequestError(f"Server GPU báo lỗi: {resp.get('error')}")
        dets = resp.get("dets", [])
        objects, more = to_objects(classes, lookup, dets)
        log.info("autolabel.done", image=image_id, engine=cfg.engine.value, found=len(dets), kept=len(objects),
                 seconds=resp.get("seconds"))
        return AutoLabelResult(objects=objects, notes=notes + more, found=len(dets), seconds=resp.get("seconds", 0),
                               engine=cfg.engine, model=model)
