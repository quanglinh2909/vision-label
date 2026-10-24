"""Nghiệp vụ của module Drive: kết nối OAuth, đẩy bản zip dataset lên Google Drive.

Trên Drive:  <thư mục gốc, mặc định "VisionLabel">/<tên project>/<project>-v<n>.zip
Upload chạy nền, gửi từng phần (resumable); tiến độ lưu vào DatasetVersion và báo realtime.
"""

from __future__ import annotations

import asyncio
import contextvars
import time
from pathlib import Path

from starlette.concurrency import run_in_threadpool

from fastapi_modular import BadRequestError, NotFoundError, injectable
from fastapi_modular.core.clock import utcnow
from fastapi_modular.core.logging import get_logger
from fastapi_modular.infrastructure.database import Repository
from src.api.datasets.entities.dataset_model import DatasetVersion
from src.api.datasets.exporter import build_zip
from src.api.drive.dto.drive_dto import DriveConfigOut, DriveConfigUpdate, DriveFileOut
from src.api.drive.entities.drive_model import CONFIG_ID, DriveConfig
from src.api.drive.google_client import DriveError, GoogleDrive
from src.api.live.live_events import LiveEvents
from src.api.projects.entities.project_model import Project
from src.core.config import AppSettings
from src.core.security import TokenSigner

log = get_logger(__name__)

STATE = "drive-connect"
UPLOADING, DONE, ERROR = "uploading", "done", "error"


def folder_link(folder_id: str) -> str:
    return f"https://drive.google.com/drive/folders/{folder_id}" if folder_id else ""


@injectable
class DriveService:
    def __init__(
        self,
        repo: Repository[DriveConfig],
        datasets: Repository[DatasetVersion],
        projects: Repository[Project],
        signer: TokenSigner,
        settings: AppSettings,
        live: LiveEvents,
    ) -> None:
        self._repo = repo
        self._datasets = datasets
        self._projects = projects
        self._signer = signer
        self._settings = settings.drive
        self._g = GoogleDrive(settings.drive)
        self._live = live
        self._access: tuple[str, float] | None = None  # (access token, hết hạn lúc)
        self._tasks: set[asyncio.Task] = set()  # giữ tham chiếu để upload nền không bị dọn mất

    # ---------------------------------------------------------------- cấu hình
    async def config(self) -> DriveConfig:
        cfg = await self._repo.get(CONFIG_ID)
        return cfg or await self._repo.save(DriveConfig(id=CONFIG_ID))

    def redirect_uri(self, base_url: str) -> str:
        return self._settings.redirect_uri or f"{base_url.rstrip('/')}/api/drive/callback"

    def out(self, cfg: DriveConfig, base_url: str) -> DriveConfigOut:
        return DriveConfigOut(
            client_id=cfg.client_id,
            has_secret=bool(cfg.client_secret),
            connected=bool(cfg.refresh_token),
            account_email=cfg.account_email,
            connected_by=cfg.connected_by,
            connected_at=cfg.connected_at,
            folder_name=cfg.folder_name,
            folder_link=folder_link(cfg.folder_id),
            auto_upload=cfg.auto_upload,
            redirect_uri=self.redirect_uri(base_url),
        )

    async def update(self, payload: DriveConfigUpdate) -> DriveConfig:
        cfg = await self.config()
        if payload.client_id is not None and payload.client_id.strip() != cfg.client_id:
            # OAuth client khác -> token cũ không dùng được nữa.
            cfg.client_id = payload.client_id.strip()
            self._forget(cfg)
        if payload.client_secret:
            cfg.client_secret = payload.client_secret.strip()
        if payload.folder_name is not None and payload.folder_name.strip() != cfg.folder_name:
            cfg.folder_name, cfg.folder_id = payload.folder_name.strip(), ""
        if payload.auto_upload is not None:
            cfg.auto_upload = payload.auto_upload
        return await self._repo.save(cfg)

    def _forget(self, cfg: DriveConfig) -> None:
        cfg.refresh_token = cfg.account_email = cfg.connected_by = cfg.folder_id = ""
        cfg.connected_at = None
        self._access = None

    # ---------------------------------------------------------------- kết nối
    async def connect_url(self, username: str, base_url: str) -> str:
        cfg = await self.config()
        if not cfg.client_id or not cfg.client_secret:
            raise BadRequestError("Nhập Client ID và Client secret rồi bấm Lưu trước khi kết nối")
        redirect = self.redirect_uri(base_url)
        # state ký số, sống 10 phút: chỉ phiên kết nối do chính app mở mới được chấp nhận.
        state = self._signer.sign(STATE, {"u": username, "r": redirect}, ttl_seconds=600)
        return self._g.auth_url(cfg.client_id, redirect, state)

    async def finish_connect(self, code: str, state: str, username: str) -> DriveConfig:
        data = self._signer.verify(STATE, state)
        if not data or data.get("u") != username:
            raise BadRequestError("Phiên kết nối không hợp lệ hoặc đã quá 10 phút, bấm Kết nối lại")
        cfg = await self.config()
        tokens = await run_in_threadpool(self._g.exchange_code, cfg.client_id, cfg.client_secret, code, data["r"])
        if not tokens.get("refresh_token"):
            raise BadRequestError(
                "Google không trả refresh token. Gỡ quyền của app ở myaccount.google.com/permissions rồi kết nối lại."
            )
        self._access = (tokens["access_token"], time.time() + int(tokens.get("expires_in", 3600)) - 60)
        email = await run_in_threadpool(self._g.account_email, tokens["access_token"])
        if email != cfg.account_email:
            cfg.folder_id = ""  # tài khoản khác -> thư mục cũ không thuộc về tài khoản này
        cfg.refresh_token = tokens["refresh_token"]
        cfg.account_email, cfg.connected_by, cfg.connected_at = email, username, utcnow()
        log.info("drive.connected", account=email, by=username)
        return await self._repo.save(cfg)

    async def disconnect(self) -> DriveConfig:
        cfg = await self.config()
        if cfg.refresh_token:
            try:
                await run_in_threadpool(self._g.revoke, cfg.refresh_token)
            except DriveError as e:  # đã bị thu hồi từ phía Google thì thôi
                log.warning("drive.revoke_failed", error=e.message)
        self._forget(cfg)
        return await self._repo.save(cfg)

    async def _token(self, cfg: DriveConfig) -> str:
        if self._access and self._access[1] > time.time():
            return self._access[0]
        if not cfg.refresh_token:
            raise DriveError("Chưa kết nối Google Drive", auth=True)
        data = await run_in_threadpool(self._g.refresh, cfg.client_id, cfg.client_secret, cfg.refresh_token)
        self._access = (data["access_token"], time.time() + int(data.get("expires_in", 3600)) - 60)
        return self._access[0]

    # ---------------------------------------------------------------- upload
    async def start_upload(self, dataset_id: str, by: str = "") -> DatasetVersion:
        """Đưa một phiên bản dataset lên Drive (chạy nền). Trả ngay trạng thái 'đang tải'."""
        cfg = await self.config()
        if not cfg.refresh_token:
            raise BadRequestError("Chưa kết nối Google Drive. Vào trang Google Drive để kết nối.")
        item = await self._datasets.get(dataset_id)
        if item is None:
            raise NotFoundError(f"Không tìm thấy dataset {dataset_id}")
        if item.drive_status == UPLOADING:
            return item
        item = await self._datasets.update(dataset_id, drive_status=UPLOADING, drive_progress=0.0, drive_error="")
        await self._emit(item, by)
        # Context trống: task không được mang theo phiên database của request đang gọi (request xong là
        # phiên đó đóng; dùng tiếp sẽ giữ khoá ghi của SQLite). Mỗi lần ghi trong task tự commit.
        task = asyncio.create_task(self._upload(dataset_id, by), context=contextvars.Context())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return item

    async def maybe_auto_upload(self, dataset_id: str) -> None:
        cfg = await self.config()
        if cfg.auto_upload and cfg.refresh_token:
            await self.start_upload(dataset_id)

    async def _emit(self, item: DatasetVersion, by: str) -> None:
        await self._live.project(
            item.project_id, "drive", by, dataset_id=item.id, version=item.version,
            status=item.drive_status, progress=item.drive_progress, link=item.drive_link, error=item.drive_error,
        )

    async def _upload(self, dataset_id: str, by: str) -> None:
        item = await self._datasets.get(dataset_id)
        try:
            for attempt in (1, 2):
                try:
                    item = await self._send(item, by)
                    break
                except DriveError as e:
                    # Access token chỉ sống 1 giờ: 401 lần đầu thì lấy token mới, thử lại một lần.
                    if e.status == 401 and attempt == 1:
                        self._access = None
                        continue
                    raise
        except Exception as e:  # noqa: BLE001 - lỗi gì cũng phải ghi lại cho người dùng thấy
            message = e.message if isinstance(e, DriveError) else str(e)
            if isinstance(e, DriveError) and e.auth:
                self._access = None
                message = f"Kết nối Google Drive không còn hiệu lực ({message}). Vào trang Google Drive để kết nối lại."
            log.warning("drive.upload_failed", dataset=dataset_id, error=message)
            item = await self._datasets.update(dataset_id, drive_status=ERROR, drive_error=message)
        if item is not None:
            await self._emit(item, by)

    async def _send(self, item: DatasetVersion, by: str) -> DatasetVersion:
        """Một lượt tải lên trọn vẹn: zip -> thư mục -> gửi từng phần. Trả bản ghi đã cập nhật."""
        dataset_id = item.id
        cfg = await self.config()
        project = await self._projects.get(item.project_id)
        root = Path(item.path)
        if not root.is_dir():
            raise DriveError(f"Thư mục dataset không còn trên đĩa: {root}")
        name = f"{root.parent.name}-v{item.version}"
        zip_path = await run_in_threadpool(build_zip, root, name)

        token = await self._token(cfg)
        if not cfg.folder_id or not await run_in_threadpool(self._g.folder_alive, token, cfg.folder_id):
            cfg.folder_id = await run_in_threadpool(self._g.ensure_folder, token, cfg.folder_name, None)
            await self._repo.update(CONFIG_ID, folder_id=cfg.folder_id)
        parent = await run_in_threadpool(self._g.ensure_folder, token, project.name if project else name, cfg.folder_id)

        total = zip_path.stat().st_size
        session = await run_in_threadpool(self._g.start_upload, token, f"{name}.zip", parent, total, "application/zip")
        chunk = max(1, self._settings.chunk_kb // 256) * 256 * 1024
        sent, result, last = 0, None, 0.0
        with zip_path.open("rb") as f:
            while result is None:
                data = f.read(chunk)
                if not data and sent < total:
                    raise DriveError("File zip bị thay đổi trong lúc tải lên")
                result = await run_in_threadpool(self._g.put_chunk, session, data, sent, total)
                sent += len(data)
                progress = sent / total if total else 1.0
                if result is None and progress - last >= 0.05:  # báo mỗi 5% để không dồn sự kiện
                    last = progress
                    updated = await self._datasets.update(dataset_id, drive_progress=progress)
                    if updated is None:
                        raise DriveError("Phiên bản dataset đã bị xoá trong lúc tải lên")
                    await self._emit(updated, by)
        file_id = result.get("id", "")
        updated = await self._datasets.update(
            dataset_id, drive_status=DONE, drive_progress=1.0, drive_file_id=file_id,
            drive_link=result.get("webViewLink") or f"https://drive.google.com/file/d/{file_id}/view",
            drive_error="", drive_uploaded_at=utcnow(),
        )
        log.info("drive.uploaded", dataset=dataset_id, size=total, file=file_id)
        return updated

    # ---------------------------------------------------------------- lấy về (khôi phục ở máy khác)
    async def _authed(self) -> tuple[DriveConfig, str]:
        cfg = await self.config()
        if not cfg.refresh_token:
            raise BadRequestError("Chưa kết nối Google Drive. Vào trang Google Drive để kết nối.")
        try:
            return cfg, await self._token(cfg)
        except DriveError as e:
            raise BadRequestError(f"Kết nối Google Drive không còn hiệu lực ({e.message}). Kết nối lại.") from e

    async def list_files(self) -> list[DriveFileOut]:
        """Các bản zip dataset app đã đẩy lên (mới nhất trước), kèm tên thư mục chứa."""
        _, token = await self._authed()
        files = await run_in_threadpool(self._g.list_zips, token)
        names: dict[str, str] = {}
        for pid in {p for f in files for p in f.get("parents", [])}:
            names[pid] = await run_in_threadpool(self._g.name_of, token, pid)
        return [
            DriveFileOut(
                id=f["id"], name=f["name"], size=int(f.get("size") or 0), modified=f.get("modifiedTime"),
                folder=names.get((f.get("parents") or [""])[0], ""),
            )
            for f in files
        ]

    async def download(self, file_id: str, dest: Path) -> None:
        _, token = await self._authed()
        try:
            await run_in_threadpool(self._g.download, token, file_id, dest)
        except DriveError as e:
            dest.unlink(missing_ok=True)
            raise BadRequestError(e.message) from e

    async def reset_interrupted(self) -> int:
        """Server tắt giữa chừng thì các upload dở không bao giờ xong — đánh dấu lỗi để bấm tải lại."""
        rows = await self._datasets.find(drive_status=UPLOADING)
        for row in rows:
            await self._datasets.update(row.id, drive_status=ERROR, drive_error="Server khởi động lại khi đang tải lên. Bấm tải lại.")
        return len(rows)
