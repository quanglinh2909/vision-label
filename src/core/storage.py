"""Đường dẫn file trên đĩa — một chỗ duy nhất biết thư mục nào chứa gì.

    storage/projects/<project_id>/images/<image_id>.<ext>   ảnh gốc
    storage/projects/<project_id>/thumbs/<image_id>.jpg     ảnh thu nhỏ
    dataset/<project-slug>/v<n>/                            dataset đã xuất
    storage/models/<model_id>.pt                            model train xong đã lưu
"""

from __future__ import annotations

import re
import shutil
import unicodedata
from pathlib import Path

from fastapi_modular import injectable
from src.core.config import AppSettings


def slugify(text: str, fallback: str = "project") -> str:
    """'Biển số Hà Nội' -> 'bien-so-ha-noi' (để làm tên thư mục)."""
    text = text.replace("đ", "d").replace("Đ", "D")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or fallback


@injectable
class Storage:
    def __init__(self, settings: AppSettings) -> None:
        self._root = settings.storage.dir.resolve()
        self._datasets = settings.storage.datasets_dir.resolve()
        self.thumb_size = settings.storage.thumb_size

    def project_dir(self, project_id: str) -> Path:
        return self._root / "projects" / project_id

    def image_path(self, project_id: str, stored_name: str) -> Path:
        return self.project_dir(project_id) / "images" / stored_name

    def thumb_path(self, project_id: str, image_id: str) -> Path:
        return self.project_dir(project_id) / "thumbs" / f"{image_id}.jpg"

    def dataset_dir(self, project_name: str, project_id: str, version: int) -> Path:
        return self._datasets / slugify(project_name, project_id[:8]) / f"v{version}"

    def model_path(self, model_id: str) -> Path:
        """Model đã lưu (xem module gpu). Không nằm trong thư mục project: xoá project vẫn giữ model."""
        return self._root / "models" / f"{model_id}.pt"

    def remove_project_files(self, project_id: str) -> None:
        shutil.rmtree(self.project_dir(project_id), ignore_errors=True)
