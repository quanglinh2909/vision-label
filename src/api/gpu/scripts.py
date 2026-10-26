"""Script bash chạy nền trên server GPU cho một việc (cài môi trường / train).

Mỗi việc một thư mục <workdir>/jobs/<id>/:

    run.sh      script dưới đây; chạy bằng `nohup setsid bash run.sh`, nên vẫn chạy tiếp khi
                app tắt hay mất mạng — app mở lại sẽ theo dõi tiếp
    pid         pid (cũng là process group) để dừng cả cây tiến trình
    log.txt     toàn bộ output
    exit_code   ghi khi xong: 0 = thành công
    data.zip    (train) bản zip dataset, giải nén vào data/
    train/      (train YOLO) kết quả của Ultralytics: results.csv, weights/best.pt
"""

from __future__ import annotations

from src.api.gpu.ssh import q

LAUNCH = "nohup setsid bash run.sh > log.txt 2>&1 < /dev/null &"
VENV = "venv/bin/python"  # tính từ workdir
# Model tải từ Hugging Face (LocateAnything) nằm trong workdir, không dùng ~/.cache/huggingface chung của máy:
# thư mục đó hay bị root chiếm (ai đó từng chạy bằng sudo) và không ghi được. Agent đặt cùng biến này.
HF_HOME = "hf-cache"
# Tìm trọng số tốt nhất sau khi train: YOLO ghi ở train/weights, train.py (phân loại) ghi cạnh nó.
WEIGHTS_GLOB = "train/weights/best.pt data/*/best.pt"


def _wrap(title: str, body: str) -> str:
    return f"""#!/usr/bin/env bash
# Sinh bởi VisionLabel: {title}
cd "$(dirname "$0")"
echo $$ > pid
main() {{
  set -e
{body}
}}
( main ); code=$?
echo "== Kết thúc, mã thoát $code"
echo $code > exit_code
"""


def setup_script(workdir: str, base_python: str, locate: bool) -> str:
    locate_part = f"""
  echo "== Cài thư viện cho LocateAnything-3B"
  $PY -m pip install "transformers==4.57.1" peft accelerate huggingface_hub opencv-python-headless
  $PY -m pip install "decord==0.6.0" lmdb || echo "!! Không cài được decord / lmdb (chỉ cần cho video), bỏ qua"
  echo "== Tải model nvidia/LocateAnything-3B (khoảng 7 GB, lần đầu hơi lâu) vào $HF_HOME"
  $PY -c "from huggingface_hub import snapshot_download; print(snapshot_download('nvidia/LocateAnything-3B'))"
""" if locate else ""
    body = f"""  [ -f apt.log ] && cat apt.log
  echo "== Máy"; uname -a
  nvidia-smi || echo "!! Không chạy được nvidia-smi: server chưa cài driver NVIDIA?"
  cd {q(workdir)}
  export HF_HOME="$(pwd)/{HF_HOME}"
  {base_python} --version
  if [ -x {VENV} ] && ! {VENV} -m pip --version >/dev/null 2>&1; then
    echo "== venv cũ bị hỏng (thiếu pip, VD lần cài trước thiếu python3-venv): tạo lại"
    rm -rf venv
  fi
  # venv tách hẳn khỏi gói của hệ thống: gói apt (VD Pillow 9 của Ubuntu 22.04) quá cũ cho transformers /
  # ultralytics mới mà pip lại coi là "đã có". venv cũ từng tạo với --system-site-packages thì tạo lại.
  if grep -qs "include-system-site-packages = true" venv/pyvenv.cfg; then
    echo "== venv cũ dùng chung gói của hệ thống: tạo lại venv riêng"
    rm -rf venv
  fi
  if [ ! -x {VENV} ]; then
    echo "== Tạo môi trường Python: $(pwd)/venv"
    {base_python} -m venv venv || {{ echo "!! Không tạo được venv. Trên Ubuntu chạy: sudo apt install python3-venv"; exit 1; }}
  fi
  PY={VENV}
  $PY -m pip install -U pip
  echo "== Cài ultralytics (YOLO), kèm PyTorch (lần đầu tải vài GB)"
  $PY -m pip install -U ultralytics
{locate_part}
  echo "== Kiểm tra"
  $PY -c "import torch; print('torch', torch.__version__, '| CUDA:', torch.cuda.is_available(), '|', [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())])"
  echo "== Xong. Python dùng cho agent và train: $(pwd)/{VENV}"
"""
    return _wrap("cài môi trường", body)


def yolo_train_script(python: str, task: str, model: str, epochs: int, imgsz: int, batch: int, device: str) -> str:
    """`task`: detect | pose | segment. Kết quả ghi vào train/ trong thư mục việc."""
    args = f"data=sys.argv[1], epochs={epochs}, imgsz={imgsz}, batch={batch}, project=str(Path.cwd()), name='train', exist_ok=True"
    if device:
        args += f", device={device!r}"
    body = f"""  PY={python}
  echo "== Giải nén dataset"
  rm -rf data && $PY -m zipfile -e data.zip data
  DATA="$(ls -d data/*/ | head -n 1)data.yaml"
  echo "== Train YOLO {task}: model {model}, {epochs} epoch, imgsz {imgsz}, batch {batch}"
  $PY - "$DATA" <<'PYEOF'
import sys
from pathlib import Path
from ultralytics import YOLO
YOLO({model!r}).train({args})
PYEOF
"""
    return _wrap(f"train YOLO {task}", body)


def classify_train_script(python: str, epochs: int, imgsz: int, batch: int) -> str:
    """Dataset phân loại có sẵn train.py (torchvision); best.pt ghi cạnh train.py."""
    body = f"""  PY={python}
  echo "== Giải nén dataset"
  rm -rf data && $PY -m zipfile -e data.zip data
  DIR="$(ls -d data/*/ | head -n 1)"
  echo "== Train phân loại: {epochs} epoch, imgsz {imgsz}, batch {batch}"
  $PY -u "${{DIR}}train.py" --epochs {epochs} --imgsz {imgsz} --batch {batch}
"""
    return _wrap("train phân loại", body)
