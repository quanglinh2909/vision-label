"""Nghiệp vụ của module Image: upload, duyệt, lưu nhãn."""

from __future__ import annotations

import io
import json
import uuid
from enum import Enum
from pathlib import Path, PurePosixPath

from PIL import Image, ImageOps
from starlette.concurrency import run_in_threadpool

from fastapi_modular import BadRequestError, ConflictError, ForbiddenError, NotFoundError, injectable
from fastapi_modular.core.clock import utcnow
from fastapi_modular.core.logging import get_logger
from fastapi_modular.infrastructure.database import Repository
from src.api.auth.auth_service import AuthService
from src.api.auth.guards import Caller
from src.api.images.annotations import count_objects, validate_objects
from src.api.projects.classes import load as load_classes
from src.api.images.dto.image_dto import UploadResult
from src.api.images.entities.image_model import ImageItem, ImageStatus
from src.api.images.entities.revision_model import ImageRevision, RevisionAction
from src.api.images.locks import LEASE, holder
from src.api.live.live_events import LiveEvents
from src.api.projects.project_service import ProjectService
from src.core.storage import Storage

log = get_logger(__name__)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def _write_image(data: bytes, original: Path, thumb: Path, thumb_size: int) -> tuple[int, int]:
    """Kiểm ảnh đọc được, lưu bản gốc + ảnh thu nhỏ; trả (rộng, cao) đã xoay theo EXIF.

    Kích thước lấy SAU khi xoay theo EXIF vì trình duyệt và Ultralytics đều hiển
    thị/đọc ảnh đã xoay — toạ độ nhãn phải khớp với ảnh đó.
    """
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im)
        width, height = im.size
        small = im.convert("RGB")
        small.thumbnail((thumb_size, thumb_size))
        original.parent.mkdir(parents=True, exist_ok=True)
        thumb.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(data)
        small.save(thumb, "JPEG", quality=85)
    return width, height


class Queue(str, Enum):
    """Các danh sách ảnh. Người gán nhãn chỉ thấy ảnh được giao cho mình."""

    UNLABELED = "unlabeled"  # (quản trị viên) mọi ảnh chưa gán
    TODO = "todo"  # (người gán) ảnh được giao chưa làm + ảnh bị trả lại
    REVIEW = "review"  # chờ duyệt: quản trị viên thấy hết, người gán thấy ảnh mình nộp
    REJECTED = "rejected"  # bị trả lại, chờ người gán sửa (quản trị viên xem theo từng người)
    LABELED = "labeled"  # đã duyệt


S = ImageStatus


@injectable
class ImageService:
    def __init__(
        self,
        repo: Repository[ImageItem],
        revisions: Repository[ImageRevision],
        projects: ProjectService,
        users: AuthService,
        storage: Storage,
        live: LiveEvents,
    ) -> None:
        self._repo = repo
        self._revisions = revisions
        self._projects = projects
        self._users = users
        self._storage = storage
        self._live = live

    async def _changed(self, item: ImageItem, kind: str, by: str, **extra) -> None:
        """Báo realtime: quản trị viên đang xem project + người được giao ảnh (nếu là người khác)."""
        data = {"image_id": item.id, "filename": item.filename, "status": item.status.value,
                "assigned_to": item.assigned_to, "locked_by": holder(item), **extra}
        await self._live.project(item.project_id, kind, by, **data)
        await self._live.user(item.assigned_to, item.project_id, kind, by, **data)

    # ------------------------------------------------------------ quyền
    @staticmethod
    def check_access(item: ImageItem, who: Caller) -> None:
        if not who.admin and item.assigned_to != who.username:
            raise ForbiddenError("Ảnh này không được giao cho bạn")

    async def get_image(self, image_id: str) -> ImageItem:
        item = await self._repo.get(image_id)
        if item is None:
            raise NotFoundError(f"Không tìm thấy ảnh {image_id}")
        return item

    async def get_for(self, image_id: str, who: Caller) -> ImageItem:
        item = await self.get_image(image_id)
        self.check_access(item, who)
        return item

    async def _log(self, item: ImageItem, who: str, action: RevisionAction) -> None:
        await self._revisions.save(
            ImageRevision(
                id="",
                image_id=item.id,
                project_id=item.project_id,
                user=who,
                action=action,
                object_count=item.object_count,
                annotations=item.annotations,
            )
        )

    async def history(self, image_id: str, who: Caller) -> list[ImageRevision]:
        await self.get_for(image_id, who)
        return await self._revisions.query().where(image_id=image_id).order_by_desc("created_at").all()

    # ------------------------------------------------------------ upload
    async def upload(
        self,
        project_id: str,
        files: list[tuple[str, bytes]],
        by: str = "",
        annotations: dict[str, list] | None = None,
    ) -> UploadResult:
        """Thêm ảnh. `annotations` (nhập từ dataset có sẵn): {tên file: nhãn đã đổi sang định dạng
        của app}. Ảnh có nhãn hợp lệ vào thẳng "chờ duyệt", ghi người nhập là người gán; nhãn lỗi
        thì ảnh vẫn được thêm nhưng ở "chưa gán", kèm lý do trong `errors`."""
        project = await self._projects.get_entity(project_id)
        classes = load_classes(project.classes)
        annotations = annotations or {}
        result = UploadResult(added=0)
        for raw_name, data in files:
            # Upload cả thư mục thì tên có thể kèm đường dẫn con — chỉ giữ tên file.
            filename = PurePosixPath(raw_name.replace("\\", "/")).name
            ext = Path(filename).suffix.lower()
            if ext not in IMAGE_EXTS:
                result.errors.append(f"{filename}: không phải ảnh ({ext or 'không có đuôi'})")
                continue
            if await self._repo.exists(project_id=project_id, filename=filename):
                result.skipped.append(filename)
                continue
            clean = None
            if filename in annotations:
                try:
                    clean = validate_objects(project.task, classes, annotations[filename])
                except BadRequestError as e:
                    result.errors.append(f"{filename}: nhãn không hợp lệ ({e.message}), ảnh được thêm vào Chưa gán")
            image_id = str(uuid.uuid4())
            stored = f"{image_id}{ext}"
            try:
                width, height = await run_in_threadpool(
                    _write_image,
                    data,
                    self._storage.image_path(project_id, stored),
                    self._storage.thumb_path(project_id, image_id),
                    self._storage.thumb_size,
                )
            except Exception as e:  # noqa: BLE001 - ảnh hỏng thì báo lại, không dừng cả lô
                result.errors.append(f"{filename}: {e}")
                continue
            item = ImageItem(
                id=image_id,
                project_id=project_id,
                filename=filename,
                stored_name=stored,
                width=width,
                height=height,
            )
            if clean is not None:
                now = utcnow()
                item.annotations = json.dumps(clean)
                item.object_count = count_objects(project.task, clean)
                item.status = S.IN_REVIEW
                item.labeled_by = item.edited_by = item.assigned_to = by
                item.labeled_at = item.edited_at = item.assigned_at = now
            item = await self._repo.save(item)
            if clean is not None:
                await self._log(item, by, RevisionAction.IMPORT)
                result.imported += 1
            result.added += 1
        if result.added:
            await self._projects.touch(project_id)
            await self._live.project(project_id, "uploaded", by, count=result.added, imported=result.imported)
        log.info(
            "images.uploaded", project=project_id, added=result.added, imported=result.imported, skipped=len(result.skipped)
        )
        return result

    # ------------------------------------------------------------ danh sách
    def _queue_query(self, project_id: str, queue: Queue, who: Caller, assignee: str | None):
        q = self._repo.query().where(project_id=project_id)
        statuses = {
            Queue.UNLABELED: [S.UNLABELED],
            Queue.TODO: [S.UNLABELED, S.REJECTED],
            Queue.REVIEW: [S.IN_REVIEW],
            Queue.REJECTED: [S.REJECTED],
            Queue.LABELED: [S.LABELED],
        }[queue]
        q = q.where(status__in=[s.value for s in statuses])
        if not who.admin:
            if queue is Queue.UNLABELED:
                raise ForbiddenError("Bạn chỉ xem được ảnh được giao cho mình")
            q = q.where(assigned_to=who.username)
        elif assignee is not None:
            q = q.where(assigned_to=assignee)
        return q

    async def list_images(
        self, project_id: str, queue: Queue, who: Caller, *, assignee: str | None, limit: int, offset: int
    ) -> tuple[list[ImageItem], int]:
        total = await self._queue_query(project_id, queue, who, assignee).count()
        items = await self._queue_query(project_id, queue, who, assignee).order_by_asc("filename").limit(limit).offset(offset).all()
        return items, total

    async def list_refs(self, project_id: str, queue: Queue, who: Caller, assignee: str | None) -> list[ImageItem]:
        return await self._queue_query(project_id, queue, who, assignee).order_by_asc("filename").all()

    # ------------------------------------------------------------ cột mới trên dữ liệu cũ
    async def backfill_new_columns(self) -> int:
        """Ảnh có từ trước khi thêm cột mang NULL dưới database. Bộ lọc so `cột = ''` không
        bao giờ khớp NULL (compare-and-set giữ chỗ, ảnh chưa giao...) -> đổi NULL thành
        chuỗi rỗng một lần lúc khởi động. Đọc lên entity thì NULL đã thành "" nên phải lọc bằng SQL."""
        fixed = 0
        for col in ("lock_token", "assigned_to", "reviewed_by", "review_note"):
            for item in await self._repo.query().where(**{f"{col}__isnull": True}).all():
                await self._repo.update(
                    item.id,
                    labeled_by=item.labeled_by or "",
                    locked_by=item.locked_by or "",
                    lock_token=item.lock_token or "",
                    assigned_to=item.assigned_to or "",
                    reviewed_by=item.reviewed_by or "",
                    review_note=item.review_note or "",
                )
                fixed += 1
        # Trước khi tách "người gán" và "người sửa cuối", labeled_by là người lưu gần nhất.
        for item in await self._repo.query().where(edited_by__isnull=True).all():
            await self._repo.update(item.id, edited_by=item.labeled_by or "", edited_at=item.updated_at if item.labeled_by else None)
            fixed += 1
        return fixed

    # ------------------------------------------------------------ giữ chỗ
    async def _try_lock(self, item: ImageItem, who: str) -> bool:
        """Compare-and-set trên lock_token: hai người giành cùng lúc thì chỉ một người thắng."""
        n = await self._repo.update_where(
            {"id": item.id, "lock_token": item.lock_token},
            locked_by=who,
            locked_until=utcnow() + LEASE,
            lock_token=str(uuid.uuid4()),
        )
        return n == 1

    async def lock(self, image_id: str, who: Caller, *, force: bool = False) -> ImageItem:
        """Giữ (hoặc gia hạn) ảnh. Đang có người khác giữ thì 409, trừ khi `force`."""
        for _ in range(3):
            item = await self.get_for(image_id, who)
            current = holder(item)
            if current and current != who.username and not force:
                raise ConflictError(f"Ảnh đang được {current} mở")
            if await self._try_lock(item, who.username):
                locked = await self.get_image(image_id)
                if current != who.username:
                    await self._changed(locked, "lock", who.username, taken_from=current)
                return locked
        raise ConflictError("Ảnh vừa được người khác mở, thử lại")

    async def unlock(self, image_id: str, who: Caller) -> None:
        n = await self._repo.update_where(
            {"id": image_id, "locked_by": who.username}, locked_by="", locked_until=None, lock_token=""
        )
        item = await self._repo.get(image_id) if n else None
        if item is not None:
            await self._live.project(item.project_id, "unlock", who.username, image_id=image_id, locked_by="")

    async def claim_next(self, project_id: str, who: Caller, exclude: set[str]) -> ImageItem | None:
        """Ảnh kế tiếp để gán.

        - Người gán: chỉ trong ảnh được giao cho mình — ảnh bị trả lại trước, rồi ảnh chưa làm.
        - Quản trị viên: ảnh chưa gán và chưa giao cho ai.
        """
        await self._projects.get_entity(project_id)
        for _ in range(5):
            now = utcnow()
            q = self._repo.query().where(project_id=project_id)
            if who.admin:
                q = q.where(status=S.UNLABELED.value, assigned_to="")
            else:
                q = q.where(status__in=[S.REJECTED.value, S.UNLABELED.value], assigned_to=who.username)
            rows = [i for i in await q.order_by_asc("filename").all()
                    if i.id not in exclude and holder(i, now) in ("", who.username)]
            if not rows:
                return None
            rows.sort(key=lambda i: (holder(i, now) != who.username, i.status is not S.REJECTED))
            if await self._try_lock(rows[0], who.username):
                claimed = await self.get_image(rows[0].id)
                if holder(rows[0], now) != who.username:
                    await self._live.project(project_id, "lock", who.username, image_id=claimed.id, locked_by=who.username)
                return claimed
        return None

    # ------------------------------------------------------------ nhãn
    async def save_annotations(
        self, image_id: str, objects: list[dict], who: Caller, *, approve: bool = False
    ) -> ImageItem:
        """Lưu nhãn. Mọi lần lưu (kể cả của quản trị viên) đưa ảnh vào "chờ duyệt"; chỉ khi
        quản trị viên lưu kèm `approve=True` (nút Duyệt trong Cần review) ảnh mới thành đã duyệt."""
        if approve and not who.admin:
            raise ForbiddenError("Chỉ quản trị viên được duyệt ảnh")
        item = await self.get_for(image_id, who)
        current = holder(item)
        if current and current != who.username:
            raise ConflictError(f"Ảnh đang được {current} mở, không lưu đè được")
        if not who.admin and item.status is S.LABELED:
            raise ForbiddenError("Ảnh đã được duyệt, không sửa được nữa")
        project = await self._projects.get_entity(item.project_id)
        clean = validate_objects(project.task, load_classes(project.classes), objects)
        before = item.status
        first = before is S.UNLABELED or not item.labeled_by
        now = utcnow()
        item.annotations = json.dumps(clean)
        item.object_count = count_objects(project.task, clean)
        if first:
            item.labeled_by, item.labeled_at = who.username, now
        item.edited_by, item.edited_at = who.username, now
        # Ảnh chưa giao ai mà quản trị viên tự gán: ghi họ là người làm, để trong "Cần review"
        # ảnh nằm đúng nhóm của họ và bị trả lại thì về đúng người.
        if not item.assigned_to:
            item.assigned_to, item.assigned_at = who.username, now
        if approve:
            item.status = S.LABELED
            item.reviewed_by, item.reviewed_at, item.review_note = who.username, now, ""
            action = RevisionAction.APPROVE
        else:
            item.status = S.IN_REVIEW
            action = RevisionAction.LABEL if first else RevisionAction.EDIT
        # Lưu xong là trả chỗ, để không giữ ảnh khi người gán đã sang ảnh khác.
        item.locked_by, item.locked_until, item.lock_token = "", None, ""
        item = await self._repo.save(item)
        await self._log(item, who.username, action)
        await self._changed(item, "approved" if approve else "saved", who.username)
        return item

    async def clear_annotations(self, image_id: str, who: Caller) -> ImageItem:
        """Đưa ảnh về 'chưa gán nhãn' (vẫn giữ người được giao)."""
        item = await self.get_for(image_id, who)
        current = holder(item)
        if current and current != who.username:
            raise ConflictError(f"Ảnh đang được {current} mở")
        if not who.admin and item.status is S.LABELED:
            raise ForbiddenError("Ảnh đã được duyệt, không sửa được nữa")
        item.annotations, item.object_count, item.status = "[]", 0, S.UNLABELED
        # Lần gán sau tính là gán mới; người bỏ nhãn được ghi là người sửa cuối.
        item.labeled_by, item.labeled_at = "", None
        item.edited_by, item.edited_at = who.username, utcnow()
        item = await self._repo.save(item)
        await self._log(item, who.username, RevisionAction.CLEAR)
        await self._changed(item, "cleared", who.username)
        return item

    # ------------------------------------------------------------ review (quản trị viên)
    async def approve(self, project_id: str, ids: list[str], who: Caller) -> int:
        """Duyệt nguyên trạng các ảnh đang chờ duyệt -> vào dataset."""
        done = 0
        now = utcnow()
        per_owner: dict[str, list[str]] = {}
        for image_id in ids:
            item = await self._repo.get(image_id)
            if item is None or item.project_id != project_id or item.status is not S.IN_REVIEW:
                continue
            item.status = S.LABELED
            item.reviewed_by, item.reviewed_at, item.review_note = who.username, now, ""
            await self._repo.save(item)
            await self._log(item, who.username, RevisionAction.APPROVE)
            per_owner.setdefault(item.assigned_to, []).append(item.id)
            done += 1
        if done:
            await self._live.project(project_id, "approved", who.username, image_ids=[i for v in per_owner.values() for i in v])
            for owner, owned in per_owner.items():
                await self._live.user(owner, project_id, "approved", who.username, image_ids=owned, count=len(owned))
        return done

    async def _reject_item(self, item: ImageItem, note: str, who: Caller) -> ImageItem:
        """Trả một ảnh về cho người đã gán. Ném BadRequestError nếu không trả được."""
        if item.status not in (S.IN_REVIEW, S.LABELED):
            raise BadRequestError("Chỉ trả lại được ảnh đang chờ duyệt hoặc đã duyệt")
        owner = item.assigned_to or (item.labeled_by if item.labeled_by != who.username else "")
        if not owner:
            raise BadRequestError("Ảnh này không giao cho ai nên không có người để trả lại")
        item.status = S.REJECTED
        item.assigned_to = owner
        item.reviewed_by, item.reviewed_at, item.review_note = who.username, utcnow(), note
        item = await self._repo.save(item)
        await self._log(item, who.username, RevisionAction.REJECT)
        return item

    async def reject(self, image_id: str, note: str, who: Caller) -> ImageItem:
        """Trả ảnh về cho người đã gán, kèm ghi chú cần sửa gì."""
        item = await self._reject_item(await self.get_image(image_id), note, who)
        await self._changed(item, "rejected", who.username, note=note)
        return item

    async def reject_many(self, project_id: str, ids: list[str], note: str, who: Caller) -> tuple[int, int]:
        """Trả lại nhiều ảnh cùng một ghi chú. Trả (số ảnh đã trả, số ảnh bỏ qua).

        Ảnh không trả được (đã bị trả rồi, chưa nộp, không có người gán...) thì bỏ qua chứ không
        làm hỏng cả lô. Mỗi người gán nhận MỘT thông báo tổng hợp, không phải mỗi ảnh một tin.
        """
        per_owner: dict[str, list[str]] = {}
        skipped = 0
        for image_id in ids:
            item = await self._repo.get(image_id)
            if item is None or item.project_id != project_id:
                skipped += 1
                continue
            try:
                item = await self._reject_item(item, note, who)
            except BadRequestError:
                skipped += 1
                continue
            per_owner.setdefault(item.assigned_to, []).append((item.id, item.filename))
        done = sum(len(v) for v in per_owner.values())
        if done:
            await self._live.project(project_id, "rejected", who.username, image_ids=[i for v in per_owner.values() for i, _ in v], note=note)
            for owner, owned in per_owner.items():
                # Một ảnh thì kèm tên file để thông báo ghi rõ "Ảnh X bị trả lại".
                extra = {"filename": owned[0][1]} if len(owned) == 1 else {}
                await self._live.user(owner, project_id, "rejected", who.username,
                                      image_ids=[i for i, _ in owned], count=len(owned), note=note, **extra)
        return done, skipped

    # ------------------------------------------------------------ phân công (quản trị viên)
    async def assign(self, project_id: str, username: str, count: int, by: str = "") -> int:
        """Giao `count` ảnh chưa gán, chưa giao cho ai, cho `username`.

        Mỗi ảnh được giành bằng compare-and-set trên `assigned_to = ''`, nên hai lệnh phân
        công chạy cùng lúc cũng không giao trùng một ảnh cho hai người.
        """
        await self._projects.get_entity(project_id)
        user = await self._users.get_by_username(username)
        if user is None or not user.active:
            raise BadRequestError(f"Không có tài khoản đang hoạt động tên '{username}'")
        given = 0
        now = utcnow()
        while given < count:
            batch = await (self._repo.query()
                           .where(project_id=project_id, status=S.UNLABELED.value, assigned_to="")
                           .order_by_asc("filename").limit(count - given + 20).all())
            free = [i for i in batch if holder(i, now) in ("", username)]
            if not free:
                break
            progress = False
            for item in free:
                if given >= count:
                    break
                if await self._repo.update_where({"id": item.id, "assigned_to": ""}, assigned_to=username, assigned_at=now):
                    given += 1
                    progress = True
            if not progress:
                break
        if given:
            await self._projects.touch(project_id)
            project = await self._projects.get_entity(project_id)
            await self._live.project(project_id, "assigned", by, username=username, count=given)
            await self._live.user(username, project_id, "assigned", by, count=given, project_name=project.name)
        log.info("images.assigned", project=project_id, user=username, count=given)
        return given

    async def revoke(self, project_id: str, username: str, by: str = "", *, scope: str = "unlabeled") -> int:
        """Thu hồi ảnh đã giao cho `username`, trả về kho "chưa giao cho ai".

        - scope="unlabeled": ảnh người đó chưa làm.
        - scope="rejected" : ảnh bị trả lại mà người đó chưa sửa. Ảnh về lại "chưa gán nhãn"
          nhưng GIỮ NGUYÊN nhãn cũ, để người được giao tiếp theo sửa từ đó.
        """
        if scope == "rejected":
            n = await self._repo.update_where(
                {"project_id": project_id, "assigned_to": username, "status": S.REJECTED.value},
                assigned_to="",
                assigned_at=None,
                status=S.UNLABELED.value,
            )
        else:
            n = await self._repo.update_where(
                {"project_id": project_id, "assigned_to": username, "status": S.UNLABELED.value},
                assigned_to="",
                assigned_at=None,
            )
        if n:
            await self._live.project(project_id, "revoked", by, username=username, count=n, scope=scope)
            await self._live.user(username, project_id, "revoked", by, count=n, scope=scope)
        return n

    async def assignment_stats(self, project_id: str) -> dict:
        rows = await self._repo.find(project_id=project_id, order_by=None)
        people: dict[str, dict[str, int]] = {}
        unassigned = 0
        for im in rows:
            if not im.assigned_to:
                unassigned += im.status is S.UNLABELED
                continue
            p = people.setdefault(im.assigned_to, {s.value: 0 for s in S})
            p[im.status.value] += 1
        return {
            "unassigned": unassigned,
            "people": [{"username": u, **c} for u, c in sorted(people.items())],
        }

    async def labeler_stats(self, project_id: str) -> dict[str, int]:
        done = await self._repo.find(project_id=project_id, status=S.LABELED, order_by=None)
        stats: dict[str, int] = {}
        for im in done:
            stats[im.labeled_by or ""] = stats.get(im.labeled_by or "", 0) + 1
        return dict(sorted(stats.items(), key=lambda kv: -kv[1]))

    # ------------------------------------------------------------ file
    async def delete_image(self, image_id: str, by: str = "") -> None:
        item = await self.get_image(image_id)
        await self._changed(item, "deleted", by)
        await self._repo.delete(image_id)
        await self._revisions.delete_where(image_id=image_id)
        self._storage.image_path(item.project_id, item.stored_name).unlink(missing_ok=True)
        self._storage.thumb_path(item.project_id, item.id).unlink(missing_ok=True)

    async def file_path(self, image_id: str, who: Caller, *, thumb: bool) -> Path:
        item = await self.get_for(image_id, who)
        path = (
            self._storage.thumb_path(item.project_id, item.id)
            if thumb
            else self._storage.image_path(item.project_id, item.stored_name)
        )
        if not path.is_file():
            raise NotFoundError(f"Mất file ảnh trên đĩa: {item.filename}")
        return path

    @staticmethod
    def ensure_files(files: list) -> None:
        if not files:
            raise BadRequestError("Chưa chọn file nào")
