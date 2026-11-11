"""Soát nhãn bằng model: chạy một model trên các ảnh đã duyệt, so với nhãn đang có (gpu/audit.py), ghi chỗ
nghi sai vào ảnh và đưa ảnh đó lại vào Cần review để người xem sửa.

Model: một model đã lưu của project (đưa lên server GPU được chọn), hoặc model của cấu hình tự gán nhãn.

Chạy nền, mỗi project một lần tại một thời điểm. Tiến độ giữ trong bộ nhớ (trang Model AI hỏi lại định kỳ);
kết quả nằm ở từng ảnh, nên app khởi động lại giữa chừng thì chỉ mất phần chưa soát, chạy lại là xong.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
from collections import Counter

from fastapi_modular import BadRequestError, injectable
from fastapi_modular.core.clock import utcnow
from fastapi_modular.core.logging import get_logger
from fastapi_modular.infrastructure.database import Repository
from src.api.gpu.audit import compare
from src.api.gpu.autolabel import queries
from src.api.gpu.autolabel_service import AutoLabelService, model_of
from src.api.gpu.dto.gpu_dto import AuditStart, AuditState
from src.api.gpu.entities.gpu_model import AutoLabelConfig, Engine
from src.api.gpu.gpu_service import GpuService
from src.api.images.entities.image_model import ImageItem, ImageStatus
from src.api.images.image_service import ImageService
from src.api.live.live_events import LiveEvents
from src.api.projects.classes import load as load_classes
from src.api.projects.entities.project_model import TaskType
from src.api.projects.project_service import ProjectService
from src.core.storage import Storage

log = get_logger(__name__)

DETECT_CONF = 0.1  # lấy cả phát hiện yếu để ghép với nhãn: model thấy mờ mờ thì không báo "nhãn thừa"
MAX_FAILS = 3  # lỗi server liên tiếp từng này lần thì dừng hẳn (mất kết nối, model hỏng...)
NOTIFY_EVERY = 100  # cứ chừng này ảnh thì báo realtime một lần để số đếm ở menu / Cần review cập nhật


@injectable
class AuditService:
    def __init__(
        self,
        images: Repository[ImageItem],
        image_service: ImageService,
        auto: AutoLabelService,
        gpu: GpuService,
        projects: ProjectService,
        live: LiveEvents,
        storage: Storage,
    ) -> None:
        self._images = images
        self._image_service = image_service
        self._auto = auto
        self._gpu = gpu
        self._projects = projects
        self._live = live
        self._storage = storage
        self._states: dict[str, AuditState] = {}
        self._stop: set[str] = set()
        self._tasks: set[asyncio.Task] = set()  # giữ tham chiếu để việc nền không bị dọn mất

    def state(self, project_id: str) -> AuditState:
        return self._states.get(project_id) or AuditState()

    async def start(self, project_id: str, payload: AuditStart, by: str) -> AuditState:
        if self.state(project_id).running:
            raise BadRequestError("Đang soát nhãn project này rồi")
        project = await self._projects.get_entity(project_id)
        if project.task is not TaskType.DETECT:
            raise BadRequestError("Soát nhãn bằng model chỉ dùng cho project nhận diện đối tượng")
        statuses = [ImageStatus.LABELED] + ([ImageStatus.IN_REVIEW] if payload.include_review else [])
        ids = [r.id for r in await self._images.query().where(project_id=project_id, status__in=[s.value for s in statuses])
               .order_by_asc("filename").all()]
        if not ids:
            raise BadRequestError("Không có ảnh nào để soát")
        cfg, lookup, name = await self._model(project_id, payload)
        state = AuditState(running=True, total=len(ids), params=payload.model_dump(), model=name, by=by,
                           started_at=utcnow())
        self._states[project_id] = state
        self._stop.discard(project_id)
        # Context trống: việc nền không mang theo phiên database / người gọi của request này.
        task = contextvars.Context().run(asyncio.create_task, self._run(project_id, ids, cfg, lookup, payload, by))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return state

    async def _model(self, project_id: str, p: AuditStart) -> tuple[AutoLabelConfig, dict[str, int], str]:
        """(cấu hình để gọi agent, {tên lớp của model: id lớp}, tên model để hiện)."""
        project = await self._projects.get_entity(project_id)
        classes = load_classes(project.classes)
        auto = await self._auto.config(project_id)
        if not p.model_id:
            cfg = await self._auto.ready(project_id)
            lookup, _ = queries(classes, json.loads(cfg.classes or "{}"), cfg.engine)
            if not lookup:
                raise BadRequestError("Không có lớp nào bật ở cấu hình tự gán nhãn (mục Model AI)")
            return cfg, lookup, model_of(cfg)
        m = await self._gpu.get_model(p.model_id)
        if m.project_id != project_id or m.task == "classify":
            raise BadRequestError("Chỉ soát được bằng model YOLO detect / pose / segment của chính project này")
        server_id = p.server_id or auto.server_id
        if not server_id:
            raise BadRequestError("Chọn server GPU để chạy model")
        # Model train từ dataset của app: tên lớp trong model trùng tên lớp của project, không cần ghép tay.
        # Chạy ở đúng kích thước ảnh lúc train.
        imgsz = int(json.loads(m.params or "{}").get("imgsz") or 640)
        cfg = AutoLabelConfig(id=project_id, server_id=server_id, engine=Engine.YOLO,
                              model=await self._gpu.deploy_model(m.id, server_id), imgsz=imgsz)
        lookup, _ = queries(classes, {}, Engine.YOLO)
        return cfg, lookup, m.name

    def stop(self, project_id: str) -> AuditState:
        if self.state(project_id).running:
            self._stop.add(project_id)
        return self.state(project_id)

    async def _run(self, project_id: str, ids: list[str], cfg: AutoLabelConfig, lookup: dict[str, int], p: AuditStart,
                   by: str) -> None:
        state = self._states[project_id]
        kinds: Counter = Counter()
        fails = 0
        notified = 0
        try:
            project = await self._projects.get_entity(project_id)
            classes = load_classes(project.classes)
            for image_id in ids:
                if project_id in self._stop:
                    state.stopped = True
                    break
                item = await self._images.get(image_id)
                if item is None or not self._storage.image_path(project_id, item.stored_name).is_file():
                    state.skipped += 1
                    state.done += 1
                    continue
                seen = item.annotations
                was_labeled = item.status is ImageStatus.LABELED
                try:
                    resp = await self._auto.detect(cfg, lookup, project_id, item, conf=DETECT_CONF)
                    fails = 0
                except BadRequestError as e:
                    fails += 1
                    if fails >= MAX_FAILS:
                        raise
                    log.warning("audit.image_failed", image=image_id, error=e.message)
                    state.skipped += 1
                    state.done += 1
                    continue
                issues = compare(classes, lookup, json.loads(seen or "[]"), resp.get("dets", []),
                                 conf=p.conf, loose_iou=p.loose_iou, check_extra=p.check_extra)
                if await self._image_service.set_audit(image_id, issues, seen, move=p.move, by=by):
                    if issues:
                        state.flagged += 1
                        kinds.update(i["kind"] for i in issues)
                        state.kinds = dict(kinds)
                        if p.move and was_labeled:
                            state.moved += 1
                else:
                    state.skipped += 1
                state.done += 1
                if state.moved - notified >= NOTIFY_EVERY:
                    notified = state.moved
                    await self._live.project(project_id, "audited", by, count=state.moved)
        except BadRequestError as e:
            state.error = e.message
        except Exception as e:  # noqa: BLE001 - việc nền: ghi lỗi để trang Model AI hiện ra, không làm sập app
            log.exception("audit.failed", project=project_id)
            state.error = str(e)
        finally:
            state.running = False
            state.finished_at = utcnow()
            self._stop.discard(project_id)
            log.info("audit.done", project=project_id, done=state.done, flagged=state.flagged, moved=state.moved,
                     error=state.error or None)
            await self._live.project(project_id, "audited", by, count=state.moved)
