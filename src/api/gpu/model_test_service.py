"""Trang Kiểm tra model: chạy model trên server GPU với ảnh, video hoặc RTSP.

- Ảnh: qua agent (giữ model trong GPU), trả các đối tượng tìm được để trình duyệt tự vẽ.
- Video / RTSP: chạy `agent.py stream` trên server (YOLO đọc nguồn, vẽ kết quả); app đọc từng khung JPEG qua SSH
  và chuyển tiếp cho trình duyệt dạng MJPEG (`multipart/x-mixed-replace`, thẻ <img> hiển thị được ngay).
  RTSP do chính server GPU đọc, nên server GPU phải kết nối được tới camera.
"""

from __future__ import annotations

import base64
import io
import json
import shlex
import socket
import struct
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import paramiko
from PIL import Image, ImageOps
from starlette.concurrency import run_in_threadpool

from fastapi_modular import BadRequestError, injectable
from fastapi_modular.core.logging import get_logger
from src.api.gpu import ssh
from src.api.gpu.agent import LOCATE_DEFAULT
from src.api.gpu.gpu_service import AGENT_SOURCE, BASE_MODEL, GpuService
from src.api.gpu.ssh import SshError, q
from src.api.images.image_service import ImageService
from src.core.storage import slugify

log = get_logger(__name__)

# Khung ghi lại để xem lại / đưa vào gán nhãn (dưới khung xem stream): khung có nhận dạng tối đa 1 khung /
# HIT_GAP giây, khung không nhận dạng được thưa hơn (MISS_GAP) để khỏi tràn. Agent lấy mẫu theo giây của nguồn
# (video: giây trong video) và gửi kèm ảnh gốc cho đúng các khung đó.
HIT_GAP, MISS_GAP = 1.0, 5.0
MAX_SHOTS = 100  # mỗi loại giữ chừng này khung gần nhất (mỗi khung giữ ảnh gốc + ảnh đã vẽ, ~300-400 KB)
SHOT_SIDE = 480
FIRST_FRAME_TIMEOUT = 120  # lần đầu: nạp model, tải trọng số, kết nối camera...
FRAME_TIMEOUT = 30
MAX_SIDE = 2560


def _encode(data: bytes) -> str:
    """Ảnh gửi đi đã xoay theo EXIF (đúng ảnh trình duyệt hiển thị), JPEG, base64."""
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if max(im.size) > MAX_SIDE:
            im.thumbnail((MAX_SIDE, MAX_SIDE))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


# Liệt kê video thử trên server (chạy bằng python của server), kèm thông tin trong file .json đi cùng.
LIST_PY = """import json, os, sys
d = sys.argv[1]
out = []
for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
    p = os.path.join(d, f)
    if f.endswith(('.json', '.log')) or not os.path.isfile(p):
        continue
    info = {}
    try:
        info = json.load(open(os.path.splitext(p)[0] + '.json', encoding='utf-8'))
    except Exception:
        pass
    st = os.stat(p)
    out.append({**info, 'path': p, 'file': f, 'size': st.st_size, 'mtime': st.st_mtime})
print(json.dumps(out))"""


def _thumb(jpg: bytes) -> bytes:
    with Image.open(io.BytesIO(jpg)) as im:
        im.thumbnail((SHOT_SIDE, SHOT_SIDE))
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=80)
    return buf.getvalue()


def _read_exact(chan: paramiko.Channel, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = chan.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def _read_frame(chan: paramiko.Channel) -> tuple[dict, bytes, bytes] | None:
    """(meta, JPEG đã vẽ kết quả, JPEG gốc — rỗng nếu khung không được ghi lại). Xem agent.stream()."""
    head = _read_exact(chan, 12)
    if head is None:
        return None
    meta_len, jpg_len, raw_len = struct.unpack(">III", head)
    meta, jpg = _read_exact(chan, meta_len), _read_exact(chan, jpg_len)
    raw = _read_exact(chan, raw_len) if raw_len else b""
    if meta is None or jpg is None or raw is None:
        return None
    return json.loads(meta), jpg, raw


@injectable
class ModelTestService:
    def __init__(self, gpu: GpuService, images: ImageService) -> None:
        self._gpu = gpu
        self._images = images
        # session (trình duyệt tự sinh) -> {meta, error, running, chan}: để trang hỏi FPS / số đối tượng, và dừng.
        self._sessions: dict[str, dict] = {}

    # ---------------------------------------------------------------- ảnh
    async def image(
        self, server_id: str, data: bytes, engine: str, model: str, conf: float, iou: float, imgsz: int, prompts: str,
    ) -> dict:
        if engine == "locate" and not [p for p in prompts.split(",") if p.strip()]:
            raise BadRequestError("LocateAnything cần mô tả cần tìm, VD: license plate, person")
        try:
            image = await run_in_threadpool(_encode, data)
        except Exception as e:  # noqa: BLE001 - file không phải ảnh
            raise BadRequestError(f"Không đọc được ảnh: {e}") from e
        msg = {
            "op": "detect", "engine": engine, "image": image, "conf": conf, "iou": iou, "imgsz": imgsz,
            "model": model or (LOCATE_DEFAULT if engine == "locate" else BASE_MODEL["detect"]),
            "prompts": [p.strip() for p in prompts.split(",") if p.strip()], "mode": "hybrid", "max_new_tokens": 8192,
        }
        resp = await self._gpu.agent_call(server_id, msg)
        if not resp.get("ok"):
            raise BadRequestError(f"Server GPU báo lỗi: {resp.get('error')}")
        return {"dets": resp.get("dets", []), "seconds": resp.get("seconds", 0), "model": msg["model"]}

    # ---------------------------------------------------------------- video
    # Video thử nằm ở <workdir>/tests/<mã>.<đuôi>, kèm <mã>.json {name, size, source, url, by, at} để hiện tên gốc
    # và dùng lại (không gửi / tải trùng). Video được giữ tới khi xoá tay; chỉ log của các lần chạy tự dọn sau 1 ngày.
    def _tests_dir(self, s, client) -> str:
        tests = f"{self._gpu.workdir(s, client)}/tests"
        ssh.run(client, f"mkdir -p {q(tests)} && find {q(tests)} -name '*.log' -mtime +1 -delete")
        return tests

    def _save_info(self, client, remote: str, info: dict) -> None:
        info = {**info, "at": time.time()}
        ssh.write_file(client, str(Path(remote).with_suffix(".json")), json.dumps(info, ensure_ascii=False))

    def _list(self, s, client) -> list[dict]:
        tests = self._tests_dir(s, client)
        code, out = ssh.run(client, f"{s.python} -c {shlex.quote(LIST_PY)} {q(tests)}")
        try:
            return json.loads(out.strip().splitlines()[-1]) if code == 0 and out.strip() else []
        except ValueError:
            return []

    async def list_videos(self, server_id: str) -> list[dict]:
        """Video thử đang có trên server GPU, mới nhất trước."""
        s = await self._gpu.get_server(server_id)
        try:
            rows = await run_in_threadpool(lambda: self._list(s, self._gpu.ssh_client(s)))
        except SshError as e:
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e
        return sorted(rows, key=lambda r: -float(r.get("at") or r.get("mtime") or 0))

    async def delete_video(self, server_id: str, path: str) -> None:
        s = await self._gpu.get_server(server_id)

        def remove() -> None:
            client = self._gpu.ssh_client(s)
            tests = self._tests_dir(s, client)
            p = Path(path)
            # Chỉ xoá đúng file trong thư mục tests/ của app.
            if str(p.parent) != tests or ".." in p.parts or p.suffix in (".json", ".log"):
                raise SshError("Đường dẫn không thuộc thư mục video thử")
            ssh.run(client, f"rm -f {q(str(p))} {q(str(p.with_suffix('.json')))}")

        try:
            await run_in_threadpool(remove)
        except SshError as e:
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e

    async def upload_video(self, server_id: str, local: Path, filename: str, by: str = "") -> str:
        """Gửi file video lên server GPU (<workdir>/tests/); trả đường dẫn trên server để làm nguồn stream."""
        s = await self._gpu.get_server(server_id)
        ext = Path(filename).suffix.lower()[:8] or ".mp4"
        size = local.stat().st_size

        def send() -> str:
            client = self._gpu.ssh_client(s)
            # Đã có đúng video này (cùng tên, cùng dung lượng) thì dùng lại, khỏi gửi lần nữa.
            for v in self._list(s, client):
                if v.get("name") == filename and v.get("size") == size:
                    return v["path"]
            remote = f"{self._tests_dir(s, client)}/{uuid.uuid4().hex}{ext}"
            ssh.put_file(client, str(local), remote)
            self._save_info(client, remote, {"name": filename, "size": size, "source": "upload", "by": by})
            return remote

        try:
            return await run_in_threadpool(send)
        except SshError as e:
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e

    async def fetch_video(self, server_id: str, url: str, by: str = "") -> str:
        """Cho server GPU tự tải video từ link http(s) về <workdir>/tests/; trả đường dẫn trên server."""
        if not url.lower().startswith(("http://", "https://")):
            raise BadRequestError("Link video phải bắt đầu bằng http:// hoặc https://")
        s = await self._gpu.get_server(server_id)
        ext = Path(url.split("?")[0]).suffix.lower()[:8] or ".mp4"
        # Tải bằng Python của server (máy nào cũng có, không cần curl / wget). Lỗi thì in lý do ra để báo lại.
        script = (
            "import sys, urllib.request\n"
            "req = urllib.request.Request(sys.argv[1], headers={'User-Agent': 'VisionLabel'})\n"
            "with urllib.request.urlopen(req, timeout=60) as r, open(sys.argv[2], 'wb') as f:\n"
            "    while chunk := r.read(1 << 20): f.write(chunk)\n"
        )

        def download() -> str:
            client = self._gpu.ssh_client(s)
            for v in self._list(s, client):  # link này đã tải trước đó: dùng lại
                if v.get("url") == url and v.get("size"):
                    return v["path"]
            remote = f"{self._tests_dir(s, client)}/{uuid.uuid4().hex}{ext}"
            code, out = ssh.run(
                client,
                f"{s.python} -c {shlex.quote(script)} {shlex.quote(url)} {q(remote)} 2>&1 | tail -n 3; "
                f"test -s {q(remote)} && stat -c %s {q(remote)}",
                timeout=1800,
            )
            if code:
                ssh.run(client, f"rm -f {q(remote)}")
                raise SshError(f"Server GPU không tải được video từ link: {out.strip()[-500:] or 'file rỗng'}")
            name = Path(url.split("?")[0]).name or "video"
            size = int(out.strip().splitlines()[-1]) if out.strip().splitlines()[-1].isdigit() else 0
            self._save_info(client, remote, {"name": name, "size": size, "source": "url", "url": url, "by": by})
            return remote

        try:
            return await run_in_threadpool(download)
        except SshError as e:
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e

    # ---------------------------------------------------------------- stream video / RTSP
    async def stream(
        self, session: str, server_id: str, source: str, model: str, conf: float, iou: float, imgsz: int,
        speed: float = 1.0,
    ) -> AsyncIterator[bytes]:
        s = await self._gpu.get_server(server_id)
        self.stop(session)  # cùng trang bấm chạy lại: tắt luồng cũ
        for key, st in list(self._sessions.items()):  # dọn phiên đã xong từ lâu
            if not st["running"] and time.time() - st.get("started", 0) > 3600:
                del self._sessions[key]
        args = {"source": source, "model": model or BASE_MODEL["detect"], "conf": conf, "iou": iou, "imgsz": imgsz,
                "hit_gap": HIT_GAP, "miss_gap": MISS_GAP, "speed": speed}
        payload = base64.b64encode(json.dumps(args).encode()).decode()

        def open_stream() -> tuple[paramiko.Channel, paramiko.SSHClient, str]:
            client = self._gpu.ssh_client(s)
            wd = self._gpu.workdir(s, client)
            ssh.run(client, f"mkdir -p {q(wd)}/tests")
            ssh.write_file(client, f"{wd}/agent.py", AGENT_SOURCE)
            logfile = f"{wd}/tests/{session}.log"
            chan = client.get_transport().open_session()
            chan.settimeout(FIRST_FRAME_TIMEOUT)
            chan.exec_command(f"cd {q(wd)} && exec {s.python} -u agent.py stream {payload} 2>{q(logfile)}")
            return chan, client, logfile

        try:
            chan, client, logfile = await run_in_threadpool(open_stream)
        except (SshError, OSError, paramiko.SSHException) as e:
            message = e.message if isinstance(e, SshError) else str(e)
            self._sessions[session] = {"meta": None, "error": message, "running": False, "chan": None, "started": time.time()}
            raise BadRequestError(f"Server GPU '{s.name}': {message}") from e
        state = {"meta": None, "error": "", "running": True, "chan": chan, "started": time.time(),
                 "shots": [], "seq": 0, "source": source}
        self._sessions[session] = state
        log.info("gpu.stream_started", server=server_id, source=source[:200], model=args["model"])

        async def frames() -> AsyncIterator[bytes]:
            got = 0
            try:
                while True:
                    try:
                        frame = await run_in_threadpool(_read_frame, chan)
                    except (TimeoutError, socket.timeout):
                        state["error"] = (f"Không nhận được hình nào sau {FIRST_FRAME_TIMEOUT} giây" if not got
                                          else f"Nguồn ngừng gửi hình hơn {FRAME_TIMEOUT} giây")
                        break
                    except (OSError, paramiko.SSHException):
                        break  # đã dừng / mất kết nối
                    if frame is None:
                        break
                    meta, jpg, raw = frame
                    if not got:
                        chan.settimeout(FRAME_TIMEOUT)
                    got += 1
                    state["meta"] = meta
                    if raw:
                        await self._keep(state, meta, jpg, raw)
                    yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n"
            finally:
                chan.close()  # trình duyệt đóng / bấm dừng: tiến trình trên server chết theo (lỗi ghi pipe)
                state["running"] = False
                if not got and not state["error"]:
                    # Chưa ra hình nào mà đã hết: đọc log trên server để biết lý do (link sai, model sai...).
                    try:
                        _, out = await run_in_threadpool(lambda: ssh.run(client, f"tail -n 8 {q(logfile)}"))
                        state["error"] = out.strip() or "Nguồn kết thúc mà không có khung hình nào"
                    except SshError as e:
                        state["error"] = e.message
                elif got and not state["error"]:
                    state["ended"] = True  # video phát hết

        return frames()

    async def _keep(self, state: dict, meta: dict, jpg: bytes, raw: bytes) -> None:
        """Ghi lại một khung agent đã chọn: ảnh đã vẽ kết quả (bản đủ ≤1280 px để xem lớn + bản thu nhỏ cho lưới)
        và ảnh gốc (để xem và đưa vào gán nhãn)."""
        hit = bool(meta.get("counts"))
        state["seq"] += 1
        shot = {"id": state["seq"], "frame": meta.get("frame", 0), "t": float(meta.get("t", 0)), "hit": hit,
                "counts": meta.get("counts", {}), "imported": False,
                "jpg": await run_in_threadpool(_thumb, jpg), "full": jpg, "raw": raw}
        state["shots"].append(shot)
        same = [s for s in state["shots"] if s["hit"] == hit]
        if len(same) > MAX_SHOTS:
            state["shots"].remove(same[0])

    def shots(self, session: str, after: int) -> dict:
        """Khung đã ghi lại có id > `after` (trang hỏi dần), kèm tổng số mỗi loại."""
        st = self._sessions.get(session) or {}
        rows = st.get("shots", [])
        return {
            "items": [{k: v for k, v in s.items() if k not in ("jpg", "full", "raw")} for s in rows if s["id"] > after],
            "imported": [s["id"] for s in rows if s["imported"]],
            "ids": [s["id"] for s in rows],  # còn giữ những khung nào (khung cũ bị bỏ khi quá MAX_SHOTS)
        }

    def shot_image(self, session: str, shot_id: int, kind: str = "thumb") -> bytes | None:
        """kind: thumb (đã vẽ, thu nhỏ) | full (đã vẽ, cỡ đủ) | raw (ảnh gốc)."""
        st = self._sessions.get(session) or {}
        key = {"thumb": "jpg", "full": "full", "raw": "raw"}[kind]
        return next((s[key] for s in st.get("shots", []) if s["id"] == shot_id), None)

    async def import_shots(self, session: str, ids: list[int], project_id: str, by: str, name: str = ""):
        """Đưa ảnh gốc của các khung đã ghi lại vào project (mục Chưa gán nhãn)."""
        st = self._sessions.get(session)
        if not st:
            raise BadRequestError("Phiên này không còn (đã quá 1 giờ hoặc app khởi động lại)")
        wanted = set(ids)
        rows = [s for s in st["shots"] if s["id"] in wanted]
        if not rows:
            raise BadRequestError("Không còn khung nào trong số đã chọn")
        # Tên ảnh: <tên video / host camera>-<phiên>-<giây>s-f<khung>.jpg. Không bao giờ dùng cả link RTSP (có mật khẩu).
        src = st.get("source", "")
        if "://" in src:
            name = src.split("@")[-1].split("/")[0]
        prefix = slugify(Path(name).stem if name else Path(src).stem, "stream")[:40]
        files = [(f"{prefix}-{session[:6]}-{s['t']:08.2f}s-f{s['frame']}.jpg", s["raw"]) for s in rows]
        result = await self._images.upload(project_id, files, by=by)
        for s in rows:
            s["imported"] = True
        return result

    def stats(self, session: str) -> dict:
        st = self._sessions.get(session)
        if st is None:
            return {"running": False, "meta": None, "error": "", "ended": False}
        return {"running": st["running"], "meta": st["meta"], "error": st["error"], "ended": st.get("ended", False)}

    def stop(self, session: str) -> None:
        st = self._sessions.get(session)
        if st and st.get("chan") is not None:
            try:
                st["chan"].close()
            except Exception:  # noqa: BLE001
                pass
