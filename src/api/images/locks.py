"""Giữ chỗ ảnh khi nhiều người cùng gán nhãn.

Mỗi lần mở ảnh, người gán "giữ" nó trong LEASE phút và gia hạn định kỳ khi còn mở.
Người khác xin ảnh tiếp sẽ không nhận ảnh đang bị giữ. Hết hạn thì ảnh tự trống lại.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi_modular.core.clock import utcnow
from src.api.images.entities.image_model import ImageItem

LEASE = timedelta(minutes=5)


def _aware(dt: datetime | None) -> datetime | None:
    # SQLite trả datetime không múi giờ dù cột khai timezone=True — coi là UTC.
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def holder(item: ImageItem, now: datetime | None = None) -> str:
    """Người đang giữ ảnh, hoặc "" nếu ảnh trống / chỗ giữ đã hết hạn."""
    until = _aware(item.locked_until)
    if item.locked_by and until and until > (now or utcnow()):
        return item.locked_by
    return ""
