"""Điểm vào — chạy bằng `fam dev`.

FILE NÀY LÀ CỦA BẠN. Khung cố ý không giấu phần lắp ráp: mỗi dòng dưới đây làm
đúng một việc, xoá được, đổi thứ tự được, chèn thêm được.

Thêm module nghiệp vụ thì KHÔNG phải sửa file này — `register_routes` tự quét
thư mục `src/api/`. Còn thêm middleware, đổi CORS, gắn router của thư viện
ngoài, bọc lifespan... thì sửa ngay tại đây.

Chưa cần sửa gì thì cả khối dưới rút lại còn hai dòng:

    from fastapi_modular import create_app
    app = create_app(AppSettings())
"""

from __future__ import annotations

from pathlib import Path

from fastapi.staticfiles import StaticFiles
from fastapi_modular import (
    add_middleware,
    bind_settings,
    configure_logging,
    new_fastapi,
    register_error_handlers,
    register_providers,
    register_routes,
)

from src.core.config import AppSettings
from src.core.lifespan import lifespan

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class WebFiles(StaticFiles):
    """File giao diện: buộc trình duyệt hỏi lại server mỗi lần (no-cache + ETag).

    Không có dòng này, trình duyệt tự đoán thời hạn cache và tiếp tục chạy JS cũ sau khi
    cập nhật code — gây lỗi kiểu giao diện cũ nói chuyện với server mới. File không đổi
    thì server chỉ trả 304, gần như không tốn gì.
    """

    def file_response(self, *args, **kwargs):  # type: ignore[override]
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response

# Đọc .env, chốt lớp cấu hình cho cả tiến trình, cắm vào DI container.
settings = bind_settings(AppSettings())
configure_logging(settings.log)

# lifespan: khung lo database và hạ tầng, phần việc riêng nằm ở
# src/core/lifespan.py — sửa ở đó, không phải ở đây.
app = new_fastapi(settings, lifespan=lifespan)

# CORS + access log + request-id. Middleware của bạn thêm sau dòng này sẽ chạy
# TRƯỚC ba cái đó (FastAPI chạy ngược thứ tự add).
add_middleware(app, settings)

# Đổi lỗi nghiệp vụ thành JSON có mã và request_id.
register_error_handlers(app, debug=settings.debug)

# Quét src/providers/, dựng sổ cho mỗi họ provider. Không có thư mục đó thì
# bỏ qua, không lỗi. Phải chạy TRƯỚC register_routes: service nhận sổ qua
# __init__, mà controller nhận service.
register_providers()

# Quét src/api/, gắn mọi @controller và @gateway tìm được.
register_routes(app, prefix=settings.api_prefix)

# Giao diện gán nhãn (SPA tĩnh trong web/). Gắn SAU cùng để mọi route /api/...
# ở trên được khớp trước.
app.mount("/", WebFiles(directory=WEB_DIR, html=True), name="web")
