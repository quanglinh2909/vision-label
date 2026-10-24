"""Nghiệp vụ của module Dataset: tạo / liệt kê / xoá phiên bản."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from starlette.concurrency import run_in_threadpool

from fastapi_modular import BadRequestError, NotFoundError, injectable
from fastapi_modular.core.logging import get_logger
from fastapi_modular.infrastructure.database import Repository
from src.api.datasets.dto.dataset_dto import ClassPlanOut, DatasetCreate, OptionCount, PlanOut, QuestionPlanOut
from src.api.datasets.entities.dataset_model import DatasetVersion
from src.api.datasets.exporter import (
    ARCHS,
    FORMATS,
    NO,
    ExportFormat,
    ExportItem,
    build_zip,
    export_imagefolder,
    export_yolo,
    plan,
)
from src.api.images.entities.image_model import ImageItem, ImageStatus
from src.api.drive.drive_service import DriveService
from src.api.live.live_events import LiveEvents
from src.api.projects import classes as cls_cfg
from src.api.projects.entities.project_model import TaskType
from src.api.projects.project_service import ProjectService
from src.core.storage import Storage

log = get_logger(__name__)


@injectable
class DatasetService:
    def __init__(
        self,
        repo: Repository[DatasetVersion],
        images: Repository[ImageItem],
        projects: ProjectService,
        storage: Storage,
        live: LiveEvents,
        drive: DriveService,
    ) -> None:
        self._drive = drive
        self._repo = repo
        self._images = images
        self._projects = projects
        self._storage = storage
        self._live = live

    async def get_version(self, dataset_id: str) -> DatasetVersion:
        item = await self._repo.get(dataset_id)
        if item is None:
            raise NotFoundError(f"Không tìm thấy dataset {dataset_id}")
        return item

    async def list_versions(self, project_id: str) -> list[DatasetVersion]:
        return await self._repo.query().where(project_id=project_id).order_by_desc("version").all()

    async def _labeled(self, project_id: str) -> list[ImageItem]:
        return await self._images.find(project_id=project_id, status=ImageStatus.LABELED, order_by="filename")

    async def plan(self, project_id: str, fmt: ExportFormat) -> PlanOut:
        """Trước khi xuất: lớp nào xuất được sang `fmt`, bao nhiêu đối tượng / ảnh."""
        project = await self._projects.get_entity(project_id)
        if fmt not in FORMATS[project.task]:
            raise BadRequestError(f"Định dạng {fmt.value} không dùng cho loại project này")
        classes = cls_cfg.load(project.classes)
        labeled = await self._labeled(project_id)
        per_class, per_option = cls_cfg.usage(project.task, [im.annotations for im in labeled])
        out = PlanOut(format=fmt, labeled=len(labeled), archs=ARCHS.get(fmt, []))
        if project.task is TaskType.CLASSIFY:
            for c in classes:
                options = [
                    OptionCount(id=o["id"], name=o["name"], images=per_option.get((c["id"], o["id"]), 0))
                    for o in c["options"]
                ]
                unknown = len(labeled) - sum(o.images for o in options)
                out.questions.append(QuestionPlanOut(id=c["id"], name=c["name"], options=options, unknown=unknown))
            return out
        p = plan(classes, fmt)
        out.classes = [
            ClassPlanOut(
                id=cp.id, name=cp.name, shape=cp.shape, status=cp.status, note=cp.note, objects=per_class.get(cp.id, 0)
            )
            for cp in p.classes
        ]
        if p.pose:
            out.pose_k, out.pose_from = p.pose.k, p.pose.source
        return out

    async def create_version(self, project_id: str, payload: DatasetCreate) -> DatasetVersion:
        project = await self._projects.get_entity(project_id)
        fmt = payload.format
        if fmt not in FORMATS[project.task]:
            raise BadRequestError(f"Định dạng {fmt.value} không dùng cho loại project này")
        classes = cls_cfg.load(project.classes)
        if not classes:
            raise BadRequestError("Project chưa có lớp nào. Thêm lớp ở mục Lớp trước.")
        labeled = await self._labeled(project_id)
        if not labeled:
            raise BadRequestError("Chưa có ảnh nào được duyệt để tạo dataset. Duyệt ảnh ở mục Cần review trước.")

        # Kiểm hết trước khi đánh số phiên bản và ghi file.
        question = None
        selected: list[int] = []
        arch = ""
        if project.task is TaskType.CLASSIFY:
            if payload.question is None:
                question = classes[0]
            else:
                question = next((c for c in classes if c["id"] == payload.question), None)
            if question is None:
                raise BadRequestError("Lớp phân loại cần xuất không tồn tại")
            arch = payload.arch or ARCHS[fmt][0]
            if arch not in ARCHS[fmt]:
                raise BadRequestError(f"Model {arch} không thuộc {fmt.value}. Chọn một trong: {', '.join(ARCHS[fmt])}")
        else:
            p = plan(classes, fmt)
            status = {cp.id: cp for cp in p.classes}
            if payload.classes is None:
                wanted = [cp.id for cp in p.classes if cp.status != NO]
            else:
                wanted = payload.classes
            for cid in wanted:
                if cid not in status:
                    raise BadRequestError(f"Lớp id {cid} không tồn tại")
                if status[cid].status == NO:
                    raise BadRequestError(
                        f"Lớp '{status[cid].name}' không xuất được sang {fmt.value}: {status[cid].note}"
                    )
            selected = [cp.id for cp in p.classes if cp.id in set(wanted)]  # giữ thứ tự cấu hình
            if not selected:
                raise BadRequestError("Chưa chọn lớp nào để xuất")
            if fmt is ExportFormat.YOLO_POSE and not any(status[c].shape == "pose" for c in selected):
                raise BadRequestError("YOLO pose cần ít nhất một lớp kiểu pose trong danh sách xuất")

        # Lưu ý: find(order_by=...) chỉ nhận tên cột trần, không sắp giảm dần được -> dùng query().
        latest = await self._repo.query().where(project_id=project_id).order_by_desc("version").first()
        version = latest.version + 1 if latest else 1
        root = self._storage.dataset_dir(project.name, project.id, version)
        items = [
            ExportItem(
                image_id=im.id,
                filename=im.filename,
                source=self._storage.image_path(project_id, im.stored_name),
                annotations=im.annotations,
                object_count=im.object_count,
            )
            for im in labeled
        ]
        if question is not None:
            stats, names = await run_in_threadpool(
                export_imagefolder, root, question, items, arch, payload.val_ratio, payload.include_unknown
            )
        else:
            stats, names = await run_in_threadpool(
                export_yolo, root, classes, selected, items, fmt, payload.val_ratio, payload.include_background
            )
        if not stats.train + stats.val:
            shutil.rmtree(root, ignore_errors=True)
            raise BadRequestError("Không có ảnh nào để xuất với lựa chọn này (mọi ảnh đều bị bỏ qua).")
        item = await self._repo.save(
            DatasetVersion(
                id="",
                project_id=project_id,
                version=version,
                name=payload.name or f"v{version}",
                note=payload.note,
                val_ratio=payload.val_ratio,
                include_background=payload.include_unknown if question is not None else payload.include_background,
                train_count=stats.train,
                val_count=stats.val,
                object_count=stats.objects,
                background_count=stats.background,
                skipped_count=stats.skipped,
                format=fmt.value,
                arch=arch,
                class_names=json.dumps(names, ensure_ascii=False),
                question=(question.get("label") or question["name"]) if question else "",
                path=str(root),
            )
        )
        await self._projects.touch(project_id)
        await self._live.project(project_id, "dataset", "", version=version)
        log.info("dataset.created", project=project_id, version=version, format=fmt.value, path=str(root))
        # Bật "tự tải lên Google Drive" thì đẩy lên luôn (chạy nền; lỗi hiện trên thẻ dataset).
        try:
            await self._drive.maybe_auto_upload(item.id)
        except Exception as e:  # noqa: BLE001 - dataset đã tạo xong, lỗi Drive không được làm hỏng nó
            log.warning("drive.auto_upload_failed", dataset=item.id, error=str(e))
        return await self.get_version(item.id)

    async def zip_path(self, dataset_id: str) -> tuple[Path, str]:
        item = await self.get_version(dataset_id)
        root = Path(item.path)
        if not root.is_dir():
            raise NotFoundError(f"Thư mục dataset không còn trên đĩa: {root}")
        # Tên zip và thư mục bên trong giống nhau: bien-so-hn-v3.zip -> bien-so-hn-v3/data.yaml
        name = f"{root.parent.name}-v{item.version}"
        return await run_in_threadpool(build_zip, root, name), f"{name}.zip"

    async def delete_version(self, dataset_id: str) -> None:
        item = await self.get_version(dataset_id)
        await self._repo.delete(dataset_id)
        root = Path(item.path)
        shutil.rmtree(root, ignore_errors=True)
        root.with_suffix(".zip").unlink(missing_ok=True)
