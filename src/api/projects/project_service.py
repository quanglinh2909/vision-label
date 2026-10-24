"""Nghiệp vụ của module Project."""

from __future__ import annotations

import json

from fastapi_modular import ConflictError, ForbiddenError, NotFoundError, injectable
from fastapi_modular.core.logging import get_logger
from fastapi_modular.infrastructure.database import Repository
from src.api.auth.guards import Caller
from src.api.datasets.entities.dataset_model import DatasetVersion
from src.api.images.entities.image_model import ImageItem, ImageStatus
from src.api.images.entities.revision_model import ImageRevision
from src.api.projects import classes as cls_cfg
from src.api.projects.dto.project_dto import ClassUsage, ProjectCreate, ProjectOut, ProjectUpdate
from src.api.projects.entities.project_model import Project
from src.core.storage import Storage

log = get_logger(__name__)


@injectable
class ProjectService:
    def __init__(
        self,
        repo: Repository[Project],
        images: Repository[ImageItem],
        datasets: Repository[DatasetVersion],
        revisions: Repository[ImageRevision],
        storage: Storage,
    ) -> None:
        self._repo = repo
        self._images = images
        self._revisions = revisions
        self._datasets = datasets
        self._storage = storage

    async def _out(self, item: Project, who: Caller) -> ProjectOut:
        # Người gán chỉ được biết về ảnh giao cho mình.
        scope = {"project_id": item.id} | ({} if who.admin else {"assigned_to": who.username})
        count = lambda **f: self._images.count(**scope, **f)  # noqa: E731
        return ProjectOut.build(
            item,
            image_count=await count(),
            unlabeled_count=await count(status=ImageStatus.UNLABELED),
            review_count=await count(status=ImageStatus.IN_REVIEW),
            rejected_count=await count(status=ImageStatus.REJECTED),
            labeled_count=await count(status=ImageStatus.LABELED),
            unassigned_count=await self._images.count(project_id=item.id, status=ImageStatus.UNLABELED, assigned_to="") if who.admin else 0,
            dataset_count=await self._datasets.count(project_id=item.id) if who.admin else 0,
        )

    async def _visible(self, item: Project, who: Caller) -> bool:
        return who.admin or await self._images.exists(project_id=item.id, assigned_to=who.username)

    async def get_entity(self, project_id: str) -> Project:
        item = await self._repo.get(project_id)
        if item is None:
            raise NotFoundError(f"Không tìm thấy project {project_id}")
        return item

    async def list_projects(self, who: Caller) -> list[ProjectOut]:
        items = await self._repo.query().order_by_desc("updated_at").all()
        return [await self._out(item, who) for item in items if await self._visible(item, who)]

    async def get_project(self, project_id: str, who: Caller) -> ProjectOut:
        item = await self.get_entity(project_id)
        if not await self._visible(item, who):
            raise ForbiddenError("Bạn chưa được giao ảnh nào trong project này")
        return await self._out(item, who)

    async def create_project(self, payload: ProjectCreate, who: Caller) -> ProjectOut:
        if await self._repo.exists(name=payload.name):
            raise ConflictError(f"Đã có project tên '{payload.name}'")
        classes = cls_cfg.normalize(payload.task, payload.classes, [])
        item = await self._repo.save(
            Project(
                id="",
                name=payload.name,
                task=payload.task,
                classes=json.dumps(classes, ensure_ascii=False),
                description=payload.description,
            )
        )
        log.info("project.created", id=item.id, task=item.task.value)
        return await self._out(item, who)

    async def update_project(self, project_id: str, payload: ProjectUpdate, who: Caller) -> ProjectOut:
        item = await self.get_entity(project_id)
        if payload.name is not None and payload.name != item.name:
            if await self._repo.exists(name=payload.name):
                raise ConflictError(f"Đã có project tên '{payload.name}'")
            item.name = payload.name
        if payload.classes is not None:
            # Nhãn trỏ tới lớp bằng id: đổi tên, đổi thứ tự, thêm lớp luôn an toàn. Chỉ chặn
            # thay đổi làm nhãn đã có mất nghĩa (xoá lớp đang dùng, đổi kiểu vẽ, đổi số điểm).
            classes = cls_cfg.normalize(
                item.task, payload.classes, cls_cfg.load(item.classes), await self._usage(item)
            )
            item.classes = json.dumps(classes, ensure_ascii=False)
        if payload.description is not None:
            item.description = payload.description
        return await self._out(await self._repo.save(item), who)

    async def _usage(self, item: Project):
        rows = await self._images.find(project_id=item.id)
        return cls_cfg.usage(item.task, [r.annotations for r in rows])

    async def class_usage(self, project_id: str) -> ClassUsage:
        item = await self.get_entity(project_id)
        per_class, per_option = await self._usage(item)
        return ClassUsage(
            classes=dict(per_class),
            options={f"{c}:{o}": n for (c, o), n in per_option.items()},
        )

    async def touch(self, project_id: str) -> None:
        """Đẩy project lên đầu danh sách khi có thay đổi bên trong nó."""
        item = await self._repo.get(project_id)
        if item is not None:
            await self._repo.save(item)

    async def delete_project(self, project_id: str) -> None:
        await self.get_entity(project_id)
        # Xoá con trước cha: các cột project_id là khoá ngoại.
        await self._revisions.delete_where(project_id=project_id)
        await self._images.delete_where(project_id=project_id)
        await self._datasets.delete_where(project_id=project_id)
        await self._repo.delete(project_id)
        # Ảnh upload bị xoá theo; các dataset đã xuất trong dataset/ được GIỮ LẠI
        # vì có thể đang dùng để train.
        self._storage.remove_project_files(project_id)
        log.info("project.deleted", id=project_id)
