"""Nói chuyện với server GPU qua SSH (paramiko): chạy lệnh, đẩy file, giữ một agent chạy lâu.

Server chỉ cần mở SSH (Ubuntu: `sudo apt install openssh-server`), không cần mở thêm cổng nào:
mọi thứ — kể cả ảnh gửi đi đánh nhãn — đi trong kết nối SSH.

Các hàm ở đây chạy đồng bộ (chặn) — service gọi qua thread pool.
"""

from __future__ import annotations

import codecs
import io
import json
import shlex
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass

import paramiko

CONNECT_TIMEOUT = 15


class SshError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class AgentGone(SshError):
    """Agent trên server đã thoát (hết giờ chờ, bị kill...) — mở lại là dùng được."""


@dataclass(frozen=True, slots=True)
class Target:
    host: str
    port: int
    username: str
    password: str = ""
    private_key: str = ""


def q(path: str) -> str:
    """Bọc đường dẫn cho shell; giữ `~/` ở đầu để shell tự đổi thành thư mục nhà."""
    if path == "~":
        return '"$HOME"'
    if path.startswith("~/"):
        return '"$HOME"/' + shlex.quote(path[2:])
    return shlex.quote(path)


def _pkey(text: str) -> paramiko.PKey:
    for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
        try:
            return cls.from_private_key(io.StringIO(text.strip() + "\n"))
        except paramiko.PasswordRequiredException as e:
            raise SshError("Khoá riêng đang đặt passphrase. Dùng khoá không có passphrase, hoặc dùng mật khẩu.") from e
        except (paramiko.SSHException, ValueError):
            continue
    raise SshError("Không đọc được khoá riêng (cần khoá OpenSSH ed25519, ecdsa hoặc rsa)")


def connect(t: Target) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    # Server mới thêm chưa có trong known_hosts: tin lần đầu (như `ssh -o StrictHostKeyChecking=accept-new`).
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    pkey = _pkey(t.private_key) if t.private_key.strip() else None
    own = bool(t.password or pkey)  # có thông tin đăng nhập riêng thì không thử khoá của máy chạy app
    try:
        client.connect(
            t.host, port=t.port, username=t.username, password=t.password or None, pkey=pkey,
            look_for_keys=not own, allow_agent=not own,
            timeout=CONNECT_TIMEOUT, banner_timeout=CONNECT_TIMEOUT, auth_timeout=CONNECT_TIMEOUT,
        )
    except paramiko.AuthenticationException as e:
        raise SshError(f"Đăng nhập SSH bị từ chối ({t.username}@{t.host}): sai mật khẩu hoặc khoá") from e
    except (TimeoutError, socket.timeout) as e:
        raise SshError(f"Hết thời gian chờ kết nối tới {t.host}:{t.port}") from e
    except (OSError, paramiko.SSHException) as e:
        raise SshError(f"Không kết nối được tới {t.host}:{t.port}: {e}") from e
    transport = client.get_transport()
    if transport is not None:
        transport.set_keepalive(30)  # giữ kết nối qua NAT / firewall khi để lâu không dùng
    return client


def alive(client: paramiko.SSHClient) -> bool:
    transport = client.get_transport()
    return bool(transport and transport.is_active())


def run(
    client: paramiko.SSHClient,
    cmd: str,
    timeout: float = 60,
    stdin: str | None = None,
    on_output: Callable[[str], None] | None = None,
) -> tuple[int, str]:
    """Chạy lệnh qua shell của server; trả (mã thoát, stdout + stderr gộp).

    `stdin`: gửi vào lệnh qua kênh SSH (VD mật khẩu cho `sudo -S`), không lộ trên dòng lệnh hay file.
    `on_output`: nhận output ngay khi tới (lệnh chạy lâu như apt), không phải chờ lệnh xong.
    """
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    try:
        chan = client.get_transport().open_session(timeout=CONNECT_TIMEOUT)
        chan.settimeout(timeout)
        chan.set_combine_stderr(True)
        chan.exec_command(cmd)
        if stdin is not None:
            chan.sendall(stdin.encode())
        chan.shutdown_write()
        out = bytearray()
        while chunk := chan.recv(65536):
            out += chunk
            if on_output:
                on_output(decoder.decode(chunk))
        code = chan.recv_exit_status()
        chan.close()
    except (TimeoutError, socket.timeout) as e:
        raise SshError(f"Lệnh trên server chạy quá {int(timeout)} giây") from e
    except (OSError, paramiko.SSHException, AttributeError) as e:
        raise SshError(f"Mất kết nối SSH: {e}") from e
    return code, out.decode("utf-8", errors="replace")


def write_file(client: paramiko.SSHClient, path: str, text: str, mode: int = 0o644) -> None:
    try:
        with client.open_sftp() as sftp, sftp.open(path, "w") as f:
            f.write(text.encode("utf-8"))
            f.chmod(mode)
    except (OSError, paramiko.SSHException) as e:
        raise SshError(f"Không ghi được {path} trên server: {e}") from e


def put_file(client: paramiko.SSHClient, local: str, remote: str, progress: Callable[[int, int], None] | None = None) -> None:
    try:
        with client.open_sftp() as sftp:
            sftp.put(local, remote, callback=progress)
    except (OSError, paramiko.SSHException) as e:
        raise SshError(f"Không gửi được file lên server: {e}") from e


def get_file(client: paramiko.SSHClient, remote: str, local: str) -> None:
    try:
        with client.open_sftp() as sftp:
            sftp.get(remote, local)
    except (OSError, paramiko.SSHException) as e:
        raise SshError(f"Không lấy được {remote} từ server: {e}") from e


class Agent:
    """Một tiến trình `python agent.py serve` chạy lâu trên server: gửi một dòng JSON, nhận một dòng JSON.

    Mỗi lần chỉ một yêu cầu (khoá), nên nhiều người bấm tự gán nhãn cùng lúc sẽ xếp hàng.
    """

    def __init__(self, client: paramiko.SSHClient, cmd: str) -> None:
        try:
            self._stdin, self._stdout, _ = client.exec_command(cmd)
        except (OSError, paramiko.SSHException) as e:
            raise SshError(f"Không chạy được agent trên server: {e}") from e
        self._chan = self._stdout.channel
        self.lock = threading.Lock()

    def alive(self) -> bool:
        return not self._chan.closed and not self._chan.exit_status_ready()

    def call(self, msg: dict, timeout: float) -> dict:
        with self.lock:
            try:
                self._chan.settimeout(timeout)
                self._stdin.write(json.dumps(msg) + "\n")
                self._stdin.flush()
                line = self._stdout.readline()
            except (TimeoutError, socket.timeout) as e:
                # Câu trả lời muộn sẽ lệch với câu hỏi sau -> bỏ agent này, lần sau mở cái mới.
                self.close()
                raise SshError(f"Server GPU không trả lời sau {int(timeout)} giây") from e
            except (OSError, paramiko.SSHException) as e:
                self.close()
                raise AgentGone(f"Agent trên server đã dừng: {e}") from e
            if not line:
                self.close()
                raise AgentGone("Agent trên server đã dừng")
            try:
                return json.loads(line)
            except ValueError as e:
                self.close()
                raise SshError(f"Agent trả về dữ liệu lạ: {line[:200]}") from e

    def close(self) -> None:
        try:
            self._chan.close()  # agent đọc thấy hết stdin thì tự thoát, trả GPU
        except Exception:  # noqa: BLE001
            pass
