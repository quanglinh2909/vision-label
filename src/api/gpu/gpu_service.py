"""Nghiệp vụ của module GPU: server, agent tự gán nhãn, việc chạy nền trên server (cài đặt / train).

- Mỗi server giữ một kết nối SSH dùng chung, và (khi cần) một agent giữ model trong GPU.
- Việc chạy nền: app chuẩn bị thư mục việc trên server (gửi dataset, ghi run.sh — xem scripts.py),
  khởi chạy bằng nohup, rồi cứ vài giây hỏi lại log / results.csv / exit_code. App tắt giữa chừng thì
  việc trên server vẫn chạy; app mở lại theo dõi tiếp.
"""

from __future__ import annotations

import asyncio
import contextvars
import csv
import io
import json
import re
import shlex
import threading
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any

import paramiko
from starlette.concurrency import run_in_threadpool

from fastapi_modular import BadRequestError, ConflictError, NotFoundError, injectable
from fastapi_modular.core.clock import utcnow
from fastapi_modular.core.logging import get_logger
from fastapi_modular.infrastructure.database import Repository
from src.api.datasets.entities.dataset_model import DatasetVersion
from src.api.datasets.exporter import build_zip
from src.api.gpu import agent as agent_module
from src.api.gpu import scripts, ssh
from src.api.gpu.dto.gpu_dto import (
    JobOut,
    ModelUpdate,
    SavedModelOut,
    SaveModelRequest,
    ServerCreate,
    ServerOut,
    ServerUpdate,
    TrainCreate,
    TrainedModel,
)
from src.api.gpu.entities.gpu_model import GpuJob, GpuServer, JobKind, JobStatus, SavedModel
from src.api.gpu.ssh import Agent, AgentGone, SshError, Target, q
from src.core.config import AppSettings
from src.core.storage import Storage, slugify

log = get_logger(__name__)

AGENT_SOURCE = Path(agent_module.__file__).read_text(encoding="utf-8")
SEP = "@@VL@@"
LOG_TAIL = 16_000
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# Dòng tiến độ: Ultralytics in "   3/50   2.31G   1.234 ...", train.py (phân loại) in "epoch 3/50  loss ...".
EPOCH_LINE = re.compile(r"^(?:\s+|epoch )(\d+)/(\d+)\s", re.M)
# Dòng mỗi epoch của train.py (phân loại): "epoch 3/30  loss 0.4123  val_acc 0.912".
CLS_EPOCH = re.compile(r"^epoch (\d+)/\d+\s+loss ([0-9.]+)\s+val_acc ([0-9.]+|nan)", re.M)


def _num(v: str) -> float | None:
    try:
        return float(v)
    except ValueError:
        return None
YOLO_TASKS = {"yolo-detect": "detect", "yolo-pose": "pose", "yolo-segment": "segment"}
BASE_MODEL = {"detect": "yolo26n.pt", "pose": "yolo26n-pose.pt", "segment": "yolo26n-seg.pt"}
S = JobStatus
ACTIVE = (S.UPLOADING, S.RUNNING)

# In một dòng tóm tắt môi trường Python của server (chạy bằng python của server).
PROBE_PY = """import sys
out = ['Python ' + sys.version.split()[0]]
for m in ('torch', 'ultralytics', 'transformers'):
    try:
        mod = __import__(m)
        v = mod.__version__
        if m == 'torch':
            v += ' (CUDA)' if mod.cuda.is_available() else ' (không thấy CUDA)'
    except Exception:
        v = 'chưa cài'
    out.append(m + ' ' + v)
print(' · '.join(out))"""


# Mức dùng GPU lúc này, đọc kèm mỗi lần hỏi tiến độ (cùng một lệnh SSH, không tốn thêm kết nối).
GPU_QUERY = (
    "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit"
    " --format=csv,noheader,nounits"
)


def parse_gpus(text: str) -> list[dict[str, Any]]:
    """Kết quả GPU_QUERY -> [{index, name, util %, mem_used / mem_total MiB, temp °C, power / power_limit W}]."""
    def num(v: str) -> float | None:
        try:
            return float(v)
        except ValueError:  # "[N/A]" trên một số card
            return None

    out = []
    for line in text.strip().splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) < 8 or num(p[0]) is None:
            continue
        out.append({
            "index": int(num(p[0])), "name": p[1], "util": num(p[2]), "mem_used": num(p[3]), "mem_total": num(p[4]),
            "temp": num(p[5]), "power": num(p[6]), "power_limit": num(p[7]),
        })
    return out


def clean_log(text: str) -> str:
    """Bỏ mã màu; dòng tiến độ ghi đè bằng \\r (tqdm) thì chỉ giữ lần ghi cuối."""
    return "\n".join(line.rstrip("\r").split("\r")[-1] for line in ANSI.sub("", text).split("\n"))


@injectable
class GpuService:
    def __init__(
        self,
        servers: Repository[GpuServer],
        jobs: Repository[GpuJob],
        datasets: Repository[DatasetVersion],
        models: Repository[SavedModel],
        storage: Storage,
        settings: AppSettings,
    ) -> None:
        self._servers = servers
        self._jobs = jobs
        self._datasets = datasets
        self._models = models
        self._storage = storage
        self._cfg = settings.gpu
        self._clients: dict[str, tuple[Target, paramiko.SSHClient]] = {}
        self._agents: dict[str, Agent] = {}
        self._homes: dict[str, str] = {}  # server id -> $HOME trên server
        self._lock = threading.Lock()
        self._tasks: set[asyncio.Task] = set()  # giữ tham chiếu để việc nền không bị dọn mất

    # ---------------------------------------------------------------- server
    async def get_server(self, server_id: str) -> GpuServer:
        s = await self._servers.get(server_id)
        if s is None:
            raise NotFoundError(f"Không tìm thấy server GPU {server_id}")
        return s

    def out(self, s: GpuServer) -> ServerOut:
        agent = self._agents.get(s.id)
        return ServerOut.build(s, agent is not None and agent.alive())

    async def list_servers(self) -> list[ServerOut]:
        return [self.out(s) for s in await self._servers.query().order_by_asc("name").all()]

    async def create_server(self, payload: ServerCreate) -> GpuServer:
        if await self._servers.exists(name=payload.name.strip()):
            raise ConflictError(f"Đã có server tên '{payload.name}'")
        data = payload.model_dump()
        data = {k: v.strip() if isinstance(v, str) and k != "private_key" else v for k, v in data.items()}
        s = await self._servers.save(GpuServer(id="", **data))
        log.info("gpu.server_added", id=s.id, host=s.host)
        return s

    async def update_server(self, server_id: str, payload: ServerUpdate) -> GpuServer:
        s = await self.get_server(server_id)
        if payload.name is not None and payload.name.strip() != s.name:
            if await self._servers.exists(name=payload.name.strip()):
                raise ConflictError(f"Đã có server tên '{payload.name}'")
            s.name = payload.name.strip()
        for key in ("host", "username", "workdir", "python", "note"):
            value = getattr(payload, key)
            if value is not None:
                setattr(s, key, value.strip())
        if payload.port is not None:
            s.port = payload.port
        if payload.clear_password:
            s.password = ""
        if payload.password:
            s.password = payload.password
        if payload.clear_key:
            s.private_key = ""
        if payload.private_key and payload.private_key.strip():
            s.private_key = payload.private_key
        s = await self._servers.save(s)
        self._forget(s.id)  # thông tin kết nối có thể đã đổi
        return s

    async def delete_server(self, server_id: str) -> None:
        await self.get_server(server_id)
        if await self._active(server_id=server_id):
            raise BadRequestError("Server đang có việc chạy (train / cài đặt). Dừng việc đó trước.")
        self._forget(server_id)
        await self._servers.delete(server_id)

    async def _active(self, **where: str) -> bool:
        return await self._jobs.query().where(**where, status__in=[x.value for x in ACTIVE]).count() > 0

    def _forget(self, server_id: str) -> None:
        with self._lock:
            agent = self._agents.pop(server_id, None)
            client = self._clients.pop(server_id, None)
            self._homes.pop(server_id, None)
        if agent:
            agent.close()
        if client:
            client[1].close()

    def close_all(self) -> None:
        for server_id in list(self._clients):
            self._forget(server_id)

    # ---------------------------------------------------------------- SSH (đồng bộ, chạy trong thread pool)
    def _client(self, s: GpuServer) -> paramiko.SSHClient:
        target = Target(s.host, s.port, s.username, s.password, s.private_key)
        with self._lock:
            cached = self._clients.get(s.id)
        if cached and cached[0] == target and ssh.alive(cached[1]):
            return cached[1]
        client = ssh.connect(target)
        with self._lock:
            old = self._clients.get(s.id)
            self._clients[s.id] = (target, client)
        if old and old[1] is not client:
            old[1].close()
        return client

    # Cho các module khác của gpu (VD kiểm tra model) dùng chung kết nối SSH. Chạy đồng bộ, gọi qua thread pool.
    def ssh_client(self, s: GpuServer) -> paramiko.SSHClient:
        return self._client(s)

    def workdir(self, s: GpuServer, client: paramiko.SSHClient) -> str:
        return self._workdir(s, client)

    def _workdir(self, s: GpuServer, client: paramiko.SSHClient) -> str:
        """Thư mục làm việc dạng tuyệt đối (SFTP không hiểu `~`)."""
        wd = s.workdir.strip().rstrip("/") or "~"
        if wd.startswith("/"):
            return wd
        home = self._homes.get(s.id)
        if home is None:
            _, out = ssh.run(client, 'printf %s "$HOME"')
            home = self._homes[s.id] = out.strip() or "/tmp"
        rest = wd[1:].lstrip("/") if wd.startswith("~") else wd
        return f"{home}/{rest}" if rest else home

    def _probe(self, s: GpuServer) -> dict[str, Any]:
        client = self._client(s)
        cmd = (
            f"uname -srm; echo {SEP}; "
            "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits 2>&1; "
            f"echo {SEP}; {s.python} -c {shlex.quote(PROBE_PY)} 2>&1 | tail -n 3"
        )
        _, out = ssh.run(client, cmd, timeout=90)
        os_info, smi, py = (out.split(SEP) + ["", "", ""])[:3]
        gpus, warnings = [], []
        for line in smi.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            try:
                gpus.append({"name": parts[0], "mem_used": int(parts[1]), "mem_total": int(parts[2]), "util": int(parts[3])})
            except (IndexError, ValueError):
                warnings.append(f"nvidia-smi: {line.strip()}")
        py = py.strip()
        if not py.startswith("Python"):
            warnings.append(f"Không chạy được '{s.python}': {py[-300:]}")
            py = ""
        return {"os_info": os_info.strip(), "gpus": gpus, "python_info": py, "warnings": warnings}

    def _start_agent(self, s: GpuServer) -> Agent:
        client = self._client(s)
        wd = self._workdir(s, client)
        code, out = ssh.run(client, f"mkdir -p {q(wd)}")
        if code:
            raise SshError(f"Không tạo được thư mục {wd} trên server: {out.strip()}")
        ssh.write_file(client, f"{wd}/agent.py", AGENT_SOURCE)
        cmd = f"cd {q(wd)} && HF_HOME={q(wd)}/{scripts.HF_HOME} exec {s.python} -u agent.py serve --idle {self._cfg.agent_idle_minutes} 2>>agent.log"
        return Agent(client, cmd)

    def _agent_log(self, s: GpuServer) -> str:
        try:
            client = self._client(s)
            _, out = ssh.run(client, f"tail -n 12 {q(self._workdir(s, client))}/agent.log")
            return out.strip()
        except SshError:
            return ""

    def _call(self, s: GpuServer, msg: dict, timeout: float) -> dict:
        for attempt in (1, 2):
            with self._lock:
                agent = self._agents.get(s.id)
            fresh = agent is None or not agent.alive()
            if fresh:
                agent = self._start_agent(s)
                with self._lock:
                    self._agents[s.id] = agent
            try:
                return agent.call(msg, timeout)
            except AgentGone:
                with self._lock:
                    self._agents.pop(s.id, None)
                # Agent cũ tự thoát vì lâu không dùng -> mở cái mới thử lại một lần.
                if fresh or attempt == 2:
                    tail = self._agent_log(s)
                    raise SshError(
                        f"Agent không chạy được trên server bằng '{s.python}'. Đã bấm 'Cài môi trường' cho server chưa?"
                        + (f"\nCuối agent.log:\n{tail}" if tail else "")
                    ) from None
            except SshError:
                with self._lock:
                    self._agents.pop(s.id, None)
                raise
        raise SshError("Không gọi được agent")  # không tới được đây

    # ---------------------------------------------------------------- dùng từ ngoài
    async def test_server(self, server_id: str) -> GpuServer:
        """Kết nối thử, đọc GPU và môi trường Python; lưu kết quả để trang server hiện ra."""
        s = await self.get_server(server_id)
        fields: dict[str, Any] = {"checked_at": utcnow()}
        try:
            info = await run_in_threadpool(self._probe, s)
            fields |= {
                "check_ok": True, "check_error": "\n".join(info["warnings"]), "os_info": info["os_info"],
                "python_info": info["python_info"], "gpus": json.dumps(info["gpus"], ensure_ascii=False),
            }
        except SshError as e:
            fields |= {"check_ok": False, "check_error": e.message}
        return await self._servers.update(server_id, **fields)

    async def agent_call(self, server_id: str, msg: dict, timeout: float | None = None) -> dict:
        s = await self.get_server(server_id)
        try:
            return await run_in_threadpool(self._call, s, msg, timeout or self._cfg.infer_timeout)
        except SshError as e:
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e

    async def call_if_running(self, server_id: str, msg: dict, timeout: float = 60) -> dict | None:
        """Gọi agent nếu nó đang chạy; None nếu không có agent (không nạp gì trên GPU)."""
        with self._lock:
            agent = self._agents.get(server_id)
        if agent is None or not agent.alive():
            return None
        s = await self.get_server(server_id)
        try:
            return await run_in_threadpool(agent.call, msg, timeout)
        except SshError as e:
            with self._lock:
                self._agents.pop(server_id, None)
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e

    async def release(self, server_id: str) -> GpuServer:
        """Tắt agent: model rời khỏi GPU. Lần tự gán nhãn sau sẽ nạp lại."""
        s = await self.get_server(server_id)
        with self._lock:
            agent = self._agents.pop(server_id, None)
        if agent:
            agent.close()
        return s

    # ---------------------------------------------------------------- việc chạy nền
    async def get_job(self, job_id: str) -> GpuJob:
        job = await self._jobs.get(job_id)
        if job is None:
            raise NotFoundError(f"Không tìm thấy việc {job_id}")
        return job

    async def job_out(self, job: GpuJob, detail: bool = False) -> JobOut:
        """`detail`: kèm lịch sử chỉ số theo từng epoch (nặng, chỉ trả khi xem một việc)."""
        s = await self._servers.get(job.server_id)
        return JobOut.build(job, s.name if s else "", detail)

    async def list_jobs(self, project_id: str | None = None) -> list[JobOut]:
        query = self._jobs.query()
        if project_id:
            query = query.where(project_id=project_id)
        rows = await query.order_by_desc("created_at").limit(100).all()
        names = {s.id: s.name for s in await self._servers.query().all()}
        return [JobOut.build(j, names.get(j.server_id, "")) for j in rows]

    async def trained_models(self, project_id: str) -> list[TrainedModel]:
        rows = await self._jobs.query().where(project_id=project_id, kind=JobKind.TRAIN.value, status=S.DONE.value) \
            .order_by_desc("created_at").all()
        return [
            TrainedModel(job_id=j.id, server_id=j.server_id, path=j.weights, title=j.title, finished_at=j.finished_at)
            for j in rows
            if j.weights and json.loads(j.params or "{}").get("task") != "classify"
        ]

    def _spawn(self, coro) -> None:
        # Context trống: task không được mang theo phiên database của request đang gọi.
        # (Không dùng create_task(context=...): tham số đó chỉ có từ Python 3.11.)
        task = contextvars.Context().run(asyncio.create_task, coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def start_setup(self, server_id: str, locate: bool, by: str) -> GpuJob:
        await self.get_server(server_id)
        if await self._active(server_id=server_id, kind=JobKind.SETUP.value):
            raise BadRequestError("Server này đang cài môi trường, chờ xong đã")
        title = "Cài môi trường: ultralytics" + (" + LocateAnything-3B" if locate else "")
        job = await self._jobs.save(GpuJob(
            id="", kind=JobKind.SETUP, server_id=server_id, title=title,
            params=json.dumps({"locate": locate}), status=S.UPLOADING, created_by=by,
        ))
        self._spawn(self._run(job.id))
        return job

    async def start_train(self, project_id: str, payload: TrainCreate, by: str) -> GpuJob:
        ds = await self._datasets.get(payload.dataset_id)
        if ds is None or ds.project_id != project_id:
            raise NotFoundError("Không tìm thấy phiên bản dataset này trong project")
        if not Path(ds.path).is_dir():
            raise BadRequestError(f"Thư mục dataset không còn trên đĩa: {ds.path}")
        await self.get_server(payload.server_id)
        if ds.format in YOLO_TASKS:
            task = YOLO_TASKS[ds.format]
            model = payload.model.strip() or BASE_MODEL[task]
        else:
            task, model = "classify", ds.arch
        params = {
            "format": ds.format, "task": task, "model": model, "epochs": payload.epochs, "imgsz": payload.imgsz,
            "batch": payload.batch, "device": payload.device.strip(), "workers": payload.workers,
            "dataset": ds.name, "version": ds.version,
        }
        job = await self._jobs.save(GpuJob(
            id="", kind=JobKind.TRAIN, server_id=payload.server_id, project_id=project_id, dataset_id=ds.id,
            title=f"{ds.name} · {model}", params=json.dumps(params, ensure_ascii=False), status=S.UPLOADING,
            epochs=payload.epochs, created_by=by,
        ))
        log.info("gpu.train_started", job=job.id, dataset=ds.id, model=model)
        self._spawn(self._run(job.id))
        return job

    @staticmethod
    def _base_python(s: GpuServer) -> str:
        """Python của hệ thống dùng để tạo venv."""
        return "python3" if s.python.endswith(scripts.VENV) else s.python

    def _script(self, job: GpuJob, s: GpuServer, workdir: str) -> str:
        p = json.loads(job.params or "{}")
        if job.kind is JobKind.SETUP:
            return scripts.setup_script(workdir, self._base_python(s), p.get("locate", False))
        if p["task"] == "classify":
            return scripts.classify_train_script(s.python, p["epochs"], p["imgsz"], p["batch"], p.get("workers", 2))
        return scripts.yolo_train_script(s.python, p["task"], p["model"], p["epochs"], p["imgsz"], p["batch"], p["device"],
                                         p.get("workers", 2))

    def _prepare(self, s: GpuServer, job: GpuJob, zip_path: Path | None, state: dict) -> str:
        """Tạo thư mục việc, gửi dataset, ghi run.sh. Trả đường dẫn thư mục việc trên server.

        Lúc này chưa có log.txt trên server, nên từng bước ghi vào state["log"] để giao diện thấy ngay.
        """
        def say(text: str) -> None:
            state["log"] += text

        say(f"== Kết nối SSH tới {s.username}@{s.host}:{s.port}\n")
        client = self._client(s)
        wd = self._workdir(s, client)
        jobdir = f"{wd}/jobs/{job.id}"
        code, out = ssh.run(client, f"mkdir -p {q(jobdir)}")
        if code:
            raise SshError(f"Không tạo được thư mục {jobdir}: {out.strip()}")
        if job.kind is JobKind.SETUP:
            self._ensure_venv(s, client, jobdir, say)
        if zip_path is not None:
            say(f"== Gửi dataset lên server ({zip_path.stat().st_size / 1e6:.1f} MB)\n")
            ssh.put_file(client, str(zip_path), f"{jobdir}/data.zip",
                         lambda done, total: state.__setitem__("progress", done / total if total else 1.0))
        ssh.write_file(client, f"{jobdir}/run.sh", self._script(job, s, wd), 0o755)
        say(f"== Khởi chạy trong {jobdir}\n")
        return jobdir

    def _ensure_venv(self, s: GpuServer, client: paramiko.SSHClient, jobdir: str, say: Callable[[str], None]) -> None:
        """Ubuntu không cài sẵn python3-venv: cài bằng sudo, dùng mật khẩu SSH của server.

        Mật khẩu đi vào `sudo -S` qua kênh SSH, không ghi ra file hay dòng lệnh. Đăng nhập bằng khoá thì
        chỉ chạy được khi tài khoản có sudo không cần mật khẩu. Kết quả ghi vào apt.log, run.sh in ra đầu log.
        """
        base = self._base_python(s)
        if ssh.run(client, f"{base} -c 'import ensurepip, venv'")[0] == 0:
            return
        code, ver = ssh.run(client, f"{base} -c 'import sys; print(\"%d.%d\" % sys.version_info[:2])'")
        pkgs = "python3-venv" + (f" python{ver.strip()}-venv" if code == 0 and ver.strip() else "")
        apt = f"DEBIAN_FRONTEND=noninteractive apt-get install -y {pkgs}"
        install = f"{apt} || (apt-get update && {apt})"  # danh sách gói cũ thì cập nhật rồi thử lại
        say(f"== Python của server chưa tạo được venv: cài {pkgs} bằng sudo (có thể mất vài phút)\n")
        if s.password:
            cmd, stdin = f"sudo -S -p '' sh -c {shlex.quote(install)}", s.password + "\n"
        else:
            cmd, stdin = f"sudo -n sh -c {shlex.quote(install)}", None
        code, out = ssh.run(client, cmd, timeout=900, stdin=stdin, on_output=say)
        ssh.write_file(client, f"{jobdir}/apt.log", f"== Thiếu venv, cài {pkgs} bằng sudo\n{out}")
        if code == 0:
            return
        tail = "\n".join(out.strip().splitlines()[-5:])
        if "incorrect password" in out or "Sorry, try again" in out:
            why = "mật khẩu sudo sai (sudo dùng mật khẩu SSH đã lưu)"
        elif "not in the sudoers" in out:
            why = f"tài khoản {s.username} không có quyền sudo"
        elif "password is required" in out:
            why = "đăng nhập bằng khoá nên không có mật khẩu cho sudo; lưu thêm mật khẩu SSH cho server"
        else:
            why = "apt-get báo lỗi"
        raise SshError(f"Không cài được {pkgs}: {why}. Hoặc chạy tay trên server: sudo apt install {pkgs}\n{tail}")

    def _launch(self, s: GpuServer, jobdir: str) -> None:
        # `cd ... || exit` rồi mới `nohup ... &`: viết `cd && nohup ... &` thì cả cụm thành một subshell
        # nền giữ stdout của kênh SSH, lệnh này sẽ treo tới khi train xong.
        code, out = ssh.run(self._client(s), f"cd {q(jobdir)} || exit 1; {scripts.LAUNCH}")
        if code:
            raise SshError(f"Không khởi chạy được: {out.strip()}")

    async def _run(self, job_id: str) -> None:
        """Chuẩn bị + khởi chạy một việc, rồi theo dõi tới khi xong."""
        # Task chạy phiên database riêng, có thể bắt đầu trước khi request tạo việc kịp commit.
        for _ in range(100):
            if await self._jobs.get(job_id) is not None:
                break
            await asyncio.sleep(0.1)
        state: dict[str, Any] = {"progress": 0.0, "log": ""}  # tiến độ / log của bước chuẩn bị
        try:
            job = await self.get_job(job_id)
            s = await self.get_server(job.server_id)
            zip_path = None
            if job.kind is JobKind.TRAIN:
                ds = await self._datasets.get(job.dataset_id)
                if ds is None:
                    raise SshError("Phiên bản dataset đã bị xoá")
                root = Path(ds.path)
                zip_path = await run_in_threadpool(build_zip, root, f"{root.parent.name}-v{ds.version}")
            prepare = asyncio.ensure_future(run_in_threadpool(self._prepare, s, job, zip_path, state))
            shown, shown_log = 0.0, ""
            while not prepare.done():
                await asyncio.wait({prepare}, timeout=1)
                changes: dict[str, Any] = {}
                if state["progress"] - shown >= 0.02:
                    shown = changes["progress"] = state["progress"]
                if state["log"] != shown_log:
                    shown_log = state["log"]
                    changes["log"] = clean_log(shown_log)[-LOG_TAIL:]
                if changes:
                    await self._jobs.update(job_id, **changes)
            jobdir = prepare.result()
            job = await self._jobs.update(job_id, remote_dir=jobdir)
            if job is None or job.status is S.STOPPED:  # bị xoá / bấm dừng khi còn đang gửi dataset
                return
            await run_in_threadpool(self._launch, s, jobdir)
            await self._jobs.update(job_id, status=S.RUNNING, progress=0.0, started_at=utcnow())
        except Exception as e:  # noqa: BLE001 - lỗi gì cũng phải ghi lại cho người dùng thấy
            message = e.message if isinstance(e, (SshError, BadRequestError, NotFoundError)) else f"{type(e).__name__}: {e}"
            log.warning("gpu.job_failed", job=job_id, error=message)
            await self._jobs.update(job_id, status=S.ERROR, error=message, finished_at=utcnow(),
                                    log=clean_log(state["log"])[-LOG_TAIL:])
            return
        await self._watch(job_id)

    def _snapshot(self, s: GpuServer, job: GpuJob) -> dict[str, Any] | None:
        """Log, results.csv, exit_code, best.pt của một việc. None = thư mục việc đã mất."""
        cmd = (
            f"cd {q(job.remote_dir)} || exit 3; cat exit_code 2>/dev/null; echo {SEP}; "
            f"tail -c {LOG_TAIL} log.txt 2>/dev/null; echo {SEP}; cat train/results.csv 2>/dev/null; echo {SEP}; "
            f"ls -d {scripts.WEIGHTS_GLOB} 2>/dev/null | head -n 1; echo {SEP}; {GPU_QUERY} 2>/dev/null"
        )
        code, out = ssh.run(self._client(s), cmd)
        if code == 3:
            return None
        exit_code, text, results, weights, smi = (out.split(SEP) + [""] * 5)[:5]
        rows = list(csv.reader(io.StringIO(results.strip()))) if results.strip() else []
        weights = weights.strip()
        return {
            "exit": int(exit_code.strip()) if exit_code.strip().lstrip("-").isdigit() else None,
            "log": clean_log(text.lstrip("\n")),
            "header": [h.strip() for h in rows[0]] if rows else [],
            "rows": rows[1:],
            "weights": f"{job.remote_dir}/{weights}" if weights else "",
            "gpus": parse_gpus(smi),
        }

    def _progress(self, job: GpuJob, snap: dict[str, Any]) -> dict[str, Any]:
        fields: dict[str, Any] = {"log": snap["log"][-LOG_TAIL:], "error": "", "gpu_stats": json.dumps(snap["gpus"])}
        if job.kind is JobKind.TRAIN:
            done = len(snap["rows"])
            current = [int(m.group(1)) for m in EPOCH_LINE.finditer(snap["log"])]
            epoch = max([done, *current])
            fields["epoch"] = epoch
            if job.epochs:
                # Epoch đang chạy mới tính nửa vời -> lấy số epoch đã xong (hoặc đang chạy trừ 1).
                fields["progress"] = min(1.0, max(done, epoch - 1) / job.epochs)
            # Mọi cột của results.csv (loss train / val, precision, recall, mAP...): `metrics` = epoch gần nhất,
            # `history` = cả quá trình theo từng epoch để vẽ xu hướng (VD loss val tăng lại = bắt đầu overfit).
            history: dict[str, list[float | None]] = {}
            if snap["rows"]:
                for i, key in enumerate(snap["header"]):
                    if key not in ("epoch", "time") and not key.startswith("lr/"):
                        history[key] = [_num(r[i].strip()) if i < len(r) else None for r in snap["rows"]]
            elif rows := CLS_EPOCH.findall(snap["log"]):
                history = {"train/loss": [_num(r[1]) for r in rows], "val/acc": [_num(r[2]) for r in rows]}
            if history:
                fields["metrics"] = json.dumps({k: v[-1] for k, v in history.items()})
                fields["history"] = json.dumps(history)
        if snap["exit"] is None:
            return fields
        fields["finished_at"] = utcnow()
        trained_all = job.kind is JobKind.TRAIN and job.epochs and len(snap["rows"]) >= job.epochs
        killed = snap["exit"] in (137, -9)
        why = " (bị hệ điều hành giết, thường do server hết RAM)" if killed else ""
        if snap["exit"] != 0 and trained_all and snap["weights"]:
            # Train đủ epoch, best.pt đã lưu; chỉ chết ở bước kiểm tra lại cuối cùng của Ultralytics -> model vẫn dùng được.
            fields |= {
                "status": S.DONE, "progress": 1.0, "weights": snap["weights"],
                "error": f"Cảnh báo: đã train đủ {job.epochs} epoch và lưu best.pt, nhưng tiến trình dừng ở bước kiểm tra "
                         f"cuối (mã thoát {snap['exit']}){why}. Model dùng được; chỉ số lấy theo epoch cuối.",
            }
        elif snap["exit"] != 0:
            tail = [line for line in snap["log"].splitlines() if line.strip()][-6:]
            hint = "\nGợi ý: giảm batch / workers, hoặc tắt bớt chương trình khác trên server." if killed else ""
            fields |= {"status": S.ERROR, "error": f"Lỗi (mã thoát {snap['exit']}){why}:\n" + "\n".join(tail) + hint}
        elif job.kind is JobKind.TRAIN and not snap["weights"]:
            fields |= {"status": S.ERROR, "error": "Train xong nhưng không thấy file best.pt"}
        else:
            fields |= {"status": S.DONE, "progress": 1.0, "weights": snap["weights"]}
        return fields

    async def _watch(self, job_id: str) -> None:
        failures = 0
        while True:
            await asyncio.sleep(self._cfg.poll_seconds)
            job = await self._jobs.get(job_id)
            if job is None or job.status is not S.RUNNING:
                return
            s = await self._servers.get(job.server_id)
            if s is None:
                await self._jobs.update(job_id, status=S.ERROR, error="Server đã bị xoá", finished_at=utcnow())
                return
            try:
                snap = await run_in_threadpool(self._snapshot, s, job)
            except SshError as e:
                # Mất mạng thì việc trên server vẫn chạy: báo lên và cứ thử lại.
                failures += 1
                if failures == 1 or failures % 12 == 0:
                    await self._jobs.update(job_id, error=f"Đang mất kết nối tới server, vẫn thử lại: {e.message}")
                continue
            failures = 0
            if snap is None:
                await self._jobs.update(job_id, status=S.ERROR, error=f"Thư mục việc không còn trên server: {job.remote_dir}",
                                        finished_at=utcnow())
                return
            fields = self._progress(job, snap)
            await self._jobs.update(job_id, **fields)
            if "status" not in fields:
                continue
            log.info("gpu.job_finished", job=job_id, status=fields["status"].value)
            if job.kind is JobKind.SETUP and fields["status"] is S.DONE:
                # Từ giờ agent và train chạy bằng python trong venv vừa cài.
                workdir = str(PurePosixPath(job.remote_dir).parent.parent)
                await self._servers.update(job.server_id, python=f"{workdir}/{scripts.VENV}")
                self._forget(job.server_id)
                await self.test_server(job.server_id)
            return

    async def recheck_job(self, job_id: str) -> GpuJob:
        """Đọc lại thư mục việc trên server (VD việc báo lỗi nhưng thực ra best.pt đã có) và cập nhật trạng thái."""
        job = await self.get_job(job_id)
        if job.status in ACTIVE:
            raise BadRequestError("Việc đang chạy, trạng thái tự cập nhật")
        if not job.remote_dir:
            raise BadRequestError("Việc này chưa từng chạy trên server")
        s = await self.get_server(job.server_id)
        try:
            snap = await run_in_threadpool(self._snapshot, s, job)
        except SshError as e:
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e
        if snap is None:
            raise BadRequestError(f"Thư mục việc không còn trên server: {job.remote_dir}")
        if snap["exit"] is None:
            raise BadRequestError("Trên server chưa có kết quả kết thúc của việc này")
        fields = self._progress(job, snap)
        fields.pop("gpu_stats", None)
        return await self._jobs.update(job_id, **fields)

    async def stop_job(self, job_id: str) -> GpuJob:
        job = await self.get_job(job_id)
        if job.status not in ACTIVE:
            raise BadRequestError("Việc này không còn chạy")
        if job.status is S.RUNNING and job.remote_dir:
            s = await self.get_server(job.server_id)
            # pid là process group (setsid) -> dừng cả cây tiến trình: bash, python, dataloader...
            d = q(job.remote_dir)
            cmd = f"P=$(cat {d}/pid 2>/dev/null) && kill -TERM -- -$P 2>/dev/null; sleep 2; [ -n \"$P\" ] && kill -KILL -- -$P 2>/dev/null; true"
            try:
                await run_in_threadpool(lambda: ssh.run(self._client(s), cmd))
            except SshError as e:
                raise BadRequestError(f"Không dừng được: {e.message}") from e
        return await self._jobs.update(job_id, status=S.STOPPED, finished_at=utcnow(), error="")

    async def delete_job(self, job_id: str) -> None:
        """Xoá việc, kèm thư mục của nó trên server (dataset đã gửi, log, trọng số đã train)."""
        job = await self.get_job(job_id)
        if job.status in ACTIVE:
            raise BadRequestError("Việc đang chạy, dừng trước rồi mới xoá")
        s = await self._servers.get(job.server_id)
        # Chỉ xoá đúng thư mục jobs/<id> do app tạo.
        if s and job.remote_dir.endswith(f"/jobs/{job.id}"):
            try:
                await run_in_threadpool(lambda: ssh.run(self._client(s), f"rm -rf {q(job.remote_dir)}"))
            except SshError as e:
                log.warning("gpu.job_cleanup_failed", job=job_id, error=e.message)
        await self._jobs.delete(job_id)

    # ---------------------------------------------------------------- model train xong: tải về, lưu trữ
    @staticmethod
    def weights_filename(params: dict, name: str = "") -> str:
        """VD bien-so-v3-yolo26n-pose-best.pt — đủ để biết model từ dataset nào, model gốc nào."""
        stem = Path(params.get("model", "")).stem or params.get("task", "model")
        base = slugify(name) if name else f"{slugify(params.get('dataset', ''), 'dataset')}-{slugify(stem, 'model')}"
        return f"{base}-best.pt"

    async def fetch_weights(self, job_id: str, dest: Path) -> GpuJob:
        """Chép best.pt của một việc train từ server GPU về `dest` (qua SFTP)."""
        job = await self.get_job(job_id)
        if job.kind is not JobKind.TRAIN or not job.weights:
            raise BadRequestError("Việc này chưa có trọng số (best.pt): chưa train xong hoặc train lỗi")
        s = await self._servers.get(job.server_id)
        if s is None:
            raise BadRequestError("Server của việc này đã bị xoá nên không lấy được file")
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            await run_in_threadpool(lambda: ssh.get_file(self._client(s), job.weights, str(dest)))
        except SshError as e:
            dest.unlink(missing_ok=True)
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e
        return job

    async def get_model(self, model_id: str) -> SavedModel:
        m = await self._models.get(model_id)
        if m is None:
            raise NotFoundError(f"Không tìm thấy model {model_id}")
        return m

    async def list_models(self, project_id: str) -> list[SavedModelOut]:
        rows = await self._models.query().where(project_id=project_id).order_by_desc("created_at").all()
        rows.sort(key=lambda m: not m.starred)  # đã đánh dấu lên đầu, còn lại mới nhất trước
        return [SavedModelOut.build(m) for m in rows]

    async def save_model(self, job_id: str, payload: SaveModelRequest, by: str) -> SavedModel:
        """Chép best.pt về máy chạy app và ghi lại cùng chỉ số, tham số train. Giữ được cả khi xoá việc / server."""
        job = await self.get_job(job_id)
        params = json.loads(job.params or "{}")
        m = await self._models.save(SavedModel(
            id="", project_id=job.project_id, job_id=job.id, name=payload.name.strip(), note=payload.note.strip(),
            starred=payload.starred, task=params.get("task", ""), base_model=params.get("model", ""),
            dataset=params.get("dataset", ""), epochs=job.epoch, metrics=job.metrics, params=job.params, created_by=by,
        ))
        path = self._storage.model_path(m.id)
        try:
            await self.fetch_weights(job_id, path)
        except Exception:
            await self._models.delete(m.id)
            raise
        log.info("gpu.model_saved", model=m.id, job=job_id, size=path.stat().st_size)
        return await self._models.update(m.id, size=path.stat().st_size)

    async def update_model(self, model_id: str, payload: ModelUpdate) -> SavedModel:
        await self.get_model(model_id)
        changes = {k: (v.strip() if isinstance(v, str) else v) for k, v in payload.model_dump(exclude_none=True).items()}
        return await self._models.update(model_id, **changes)

    async def delete_model(self, model_id: str) -> None:
        await self.get_model(model_id)
        await self._models.delete(model_id)
        self._storage.model_path(model_id).unlink(missing_ok=True)

    async def model_file(self, model_id: str) -> tuple[Path, str]:
        m = await self.get_model(model_id)
        path = self._storage.model_path(m.id)
        if not path.is_file():
            raise NotFoundError(f"Mất file model trên đĩa: {path}")
        return path, self.weights_filename(json.loads(m.params or "{}"), m.name)

    def _deploy(self, s: GpuServer, local: Path, model_id: str) -> str:
        client = self._client(s)
        remote_dir = f"{self._workdir(s, client)}/models"
        remote = f"{remote_dir}/{model_id}.pt"
        # Đã có đúng file (cùng kích thước) trên server thì khỏi gửi lại.
        _, out = ssh.run(client, f"mkdir -p {q(remote_dir)} && stat -c %s {q(remote)} 2>/dev/null || true")
        if out.strip() != str(local.stat().st_size):
            ssh.put_file(client, str(local), remote)
        return remote

    async def deploy_model(self, model_id: str, server_id: str) -> str:
        """Đưa model đã lưu lên server GPU (<workdir>/models/<id>.pt); trả đường dẫn trên server."""
        path, _ = await self.model_file(model_id)
        s = await self.get_server(server_id)
        try:
            return await run_in_threadpool(self._deploy, s, path, model_id)
        except SshError as e:
            raise BadRequestError(f"Server GPU '{s.name}': {e.message}") from e

    async def resume(self) -> int:
        """Lúc app khởi động: theo dõi tiếp việc đang chạy; việc đang gửi dở thì báo lỗi."""
        for job in await self._jobs.find(status=S.UPLOADING):
            await self._jobs.update(job.id, status=S.ERROR, finished_at=utcnow(),
                                    error="App khởi động lại khi đang gửi dữ liệu lên server. Chạy lại.")
        running = await self._jobs.find(status=S.RUNNING)
        for job in running:
            self._spawn(self._watch(job.id))
        return len(running)
