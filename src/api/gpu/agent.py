"""Agent chạy TRÊN server GPU. VisionLabel đẩy file này lên <workdir>/agent.py qua SSH rồi chạy:

    python agent.py serve --idle 30
    python agent.py stream <tham số JSON base64>    (trang Kiểm tra model: video / RTSP, xem stream())

Đọc yêu cầu JSON từng dòng ở stdin, trả JSON từng dòng ở stdout:

    -> {"op": "detect", "engine": "yolo", "model": "yolo26n.pt", "image": "<jpeg base64>", "conf": 0.25, ...}
    <- {"ok": true, "dets": [{"label": "car", "conf": 0.91, "box": [x1, y1, x2, y2]}, ...], "seconds": 0.12}

Toạ độ trả về chuẩn hoá 0..1. Model nạp một lần rồi giữ trong GPU, nên các ảnh sau chạy nhanh.
Không có yêu cầu nào trong `--idle` phút (hoặc VisionLabel đóng kết nối) thì agent tự thoát, trả GPU.

File này cũng nằm trong src/api/ của app, nên phải import được mà không cần torch: thư viện nặng
chỉ import bên trong hàm.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import select
import struct
import sys
import time
import traceback

LOCATE_DEFAULT = "nvidia/LocateAnything-3B"
_models: dict[tuple[str, str], object] = {}


def _image(b64: str):
    from PIL import Image

    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


# ---------------------------------------------------------------- YOLO (Ultralytics)
def _yolo(model: str):
    key = ("yolo", model)
    if key not in _models:
        from ultralytics import YOLO

        _models[key] = YOLO(model)
    return _models[key]


def detect_yolo(req: dict, img) -> list[dict]:
    r = _yolo(req["model"]).predict(
        img, conf=req.get("conf", 0.25), iou=req.get("iou", 0.5), imgsz=req.get("imgsz", 640),
        device=req.get("device") or None, verbose=False,
    )[0]
    if r.boxes is None:  # model phân loại: không có khung
        return []
    dets = []
    for i in range(len(r.boxes)):
        d = {
            "label": str(r.names[int(r.boxes.cls[i])]),
            "conf": float(r.boxes.conf[i]),
            "box": [float(v) for v in r.boxes.xyxyn[i].tolist()],
        }
        if r.keypoints is not None and len(r.keypoints):
            xy = r.keypoints.xyn[i].tolist()
            kc = r.keypoints.conf[i].tolist() if r.keypoints.conf is not None else [1.0] * len(xy)
            d["kpts"] = [[x, y, c] for (x, y), c in zip(xy, kc)]
        if r.masks is not None and len(r.masks):
            d["poly"] = r.masks.xyn[i].tolist()
        dets.append(d)
    return dets


# ---------------------------------------------------------------- LocateAnything-3B
class _Locate:
    """Theo worker mẫu trên model card nvidia/LocateAnything-3B (cần transformers==4.57.1)."""

    def __init__(self, path: str) -> None:
        import torch
        from transformers import AutoModel, AutoProcessor, AutoTokenizer

        if not torch.cuda.is_available():
            raise RuntimeError("LocateAnything-3B cần GPU NVIDIA (torch không thấy CUDA)")
        self.torch = torch
        self.dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        self.tokenizer = AutoTokenizer.from_pretrained(path, trust_remote_code=True)
        self.processor = AutoProcessor.from_pretrained(path, trust_remote_code=True)
        self.model = AutoModel.from_pretrained(path, torch_dtype=self.dtype, trust_remote_code=True).to("cuda").eval()

    def ask(self, img, question: str, mode: str, max_new_tokens: int) -> str:
        messages = [{"role": "user", "content": [{"type": "image", "image": img}, {"type": "text", "text": question}]}]
        with self.torch.no_grad():
            text = self.processor.py_apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            images, videos = self.processor.process_vision_info(messages)
            inputs = self.processor(text=[text], images=images, videos=videos, return_tensors="pt").to("cuda")
            out = self.model.generate(
                pixel_values=inputs["pixel_values"].to(self.dtype),
                input_ids=inputs["input_ids"],
                attention_mask=inputs["attention_mask"],
                image_grid_hws=inputs.get("image_grid_hws", None),
                tokenizer=self.tokenizer,
                max_new_tokens=max_new_tokens,
                use_cache=True,
                generation_mode=mode,
                temperature=0.7,
                do_sample=True,
                top_p=0.9,
                repetition_penalty=1.1,
                verbose=False,
            )
        return out[0] if isinstance(out, tuple) else out


def _locate(model: str) -> _Locate:
    key = ("locate", model)
    if key not in _models:
        _models[key] = _Locate(model)
    return _models[key]


_BOX = re.compile(r"<box>\s*<(\d+)>\s*<(\d+)>\s*<(\d+)>\s*<(\d+)>\s*</box>")
_TAG = re.compile(r"<[^>]*>")


def _match(text: str, prompts: list[str]) -> str | None:
    t = text.strip(" .,:;-\n\t").lower()
    if not t:
        return None
    for p in prompts:
        if p.lower() == t:
            return p
    for p in prompts:
        if p.lower() in t or t in p.lower():
            return p
    return None


def parse_locate(answer: str, prompts: list[str]) -> list[tuple[str | None, list[float]]]:
    """[(mô tả, khung 0..1)]. Mô tả của một khung là đoạn chữ gần nhất đứng trước nó (None = không rõ)."""
    found, label, pos = [], None, 0
    for m in _BOX.finditer(answer):
        between = _TAG.sub(" ", answer[pos : m.start()])
        if between.strip():
            label = _match(between, prompts)
        pos = m.end()
        box = [int(g) / 1000 for g in m.groups()]
        found.append((prompts[0] if len(prompts) == 1 else label, box))
    return found


def _question(prompts: list[str]) -> str:
    return f"Locate all the instances that matches the following description: {'</c>'.join(prompts)}."


def detect_locate(req: dict, img) -> list[dict]:
    worker = _locate(req.get("model") or LOCATE_DEFAULT)
    prompts = [p for p in req.get("prompts", []) if p]
    if not prompts:
        return []
    mode, tokens = req.get("mode", "hybrid"), int(req.get("max_new_tokens", 8192))
    found = parse_locate(worker.ask(img, _question(prompts), mode, tokens), prompts)
    if len(prompts) > 1 and any(label is None for label, _ in found):
        # Không biết khung nào thuộc mô tả nào -> hỏi riêng từng mô tả (chậm hơn nhưng chắc chắn).
        found = []
        for p in prompts:
            found += parse_locate(worker.ask(img, _question([p]), mode, tokens), [p])
    return [{"label": label, "conf": 1.0, "box": box} for label, box in found]


# ---------------------------------------------------------------- các lệnh
def op_ping(req: dict) -> dict:
    info: dict = {"python": sys.version.split()[0], "loaded": [f"{e}:{m}" for e, m in _models]}
    try:
        import torch

        info.update(
            torch=torch.__version__, cuda=torch.cuda.is_available(),
            gpus=[torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())],
        )
    except ImportError:
        info["torch"] = ""
    for name in ("ultralytics", "transformers"):
        try:
            info[name] = __import__(name).__version__
        except ImportError:
            info[name] = ""
    return info


def op_load(req: dict) -> dict:
    if req.get("engine") == "locate":
        _locate(req.get("model") or LOCATE_DEFAULT)
    else:
        _yolo(req["model"])
    return {}


def op_detect(req: dict) -> dict:
    img = _image(req["image"])
    dets = detect_locate(req, img) if req.get("engine") == "locate" else detect_yolo(req, img)
    return {"dets": dets, "width": img.width, "height": img.height}


def op_unload(req: dict) -> dict:
    """Gỡ một model (engine + model) khỏi GPU; không chỉ rõ thì gỡ hết."""
    if req.get("engine"):
        model = req.get("model") or (LOCATE_DEFAULT if req["engine"] == "locate" else "")
        _models.pop((req["engine"], model), None)
    else:
        _models.clear()
    try:
        import gc

        import torch

        gc.collect()
        torch.cuda.empty_cache()
    except ImportError:
        pass
    return {}


OPS = {"ping": op_ping, "load": op_load, "detect": op_detect, "unload": op_unload}


def serve(idle_minutes: float) -> None:
    # Kênh trả lời là stdout THẬT; mọi thứ thư viện in ra (Ultralytics in khá nhiều) bị đẩy sang
    # stderr — VisionLabel ghi stderr vào agent.log — để không làm hỏng các dòng JSON.
    sys.stdout.flush()
    reply = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    print(f"[{time.strftime('%F %T')}] agent bắt đầu, pid {os.getpid()}", file=sys.stderr, flush=True)
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], idle_minutes * 60)
        if not ready:
            print(f"[{time.strftime('%F %T')}] {idle_minutes} phút không dùng, thoát để trả GPU", file=sys.stderr, flush=True)
            return
        line = sys.stdin.readline()
        if not line:
            return
        start = time.time()
        try:
            req = json.loads(line)
            result = {"ok": True, **OPS[req.get("op", "")](req)}
        except Exception as e:  # noqa: BLE001 - mọi lỗi đều trả về cho app hiện ra
            traceback.print_exc()
            result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        result["seconds"] = round(time.time() - start, 3)
        reply.write(json.dumps(result) + "\n")


def stream(args: dict) -> None:
    """Chạy YOLO trên video / RTSP, gửi từng khung hình đã vẽ kết quả ra stdout (trang Kiểm tra model).

    Mỗi khung: 12 byte (độ dài meta, ảnh đã vẽ, ảnh gốc; big-endian) + meta JSON + JPEG đã vẽ + JPEG gốc.
    Ảnh gốc (chưa vẽ, để đưa vào gán nhãn) chỉ gửi cho khung được "ghi lại" (meta.keep): khung có nhận dạng
    tối đa 1 / hit_gap giây, khung không nhận dạng được 1 / miss_gap giây; các khung khác ảnh gốc rỗng.
    Tiến trình này riêng với agent `serve`; VisionLabel đóng kết nối là nó tự chết (ghi stdout lỗi pipe).
    """
    from collections import Counter

    sys.stdout.flush()
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)  # print của Ultralytics sang stderr (file log), không lẫn vào luồng ảnh
    import cv2
    from ultralytics import YOLO

    model = YOLO(args["model"])
    max_side, limit = int(args.get("max_side", 1280)), float(args.get("max_seconds", 0))
    # Mốc thời gian của khung: video file tính theo giây trong video (chạy nhanh hơn thời gian thực vẫn đúng),
    # camera / stream tính theo thời gian thực.
    source = str(args["source"])
    src_fps = 0.0
    if not source.lower().startswith(("rtsp://", "rtsps://", "rtmp://", "http://", "https://")):
        cap = cv2.VideoCapture(source)
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        cap.release()
    gaps = {True: float(args.get("hit_gap", 1.0)), False: float(args.get("miss_gap", 5.0))}
    # Tốc độ phát video file: 1 = đúng tốc độ thật của video, 2 = nhanh gấp đôi..., 0 = nhanh nhất có thể.
    speed = float(args.get("speed", 1.0)) if src_fps else 0.0
    play_start = None  # mốc phát: lúc ra khung đầu (không tính thời gian nạp model)
    last_kept: dict[bool, float | None] = {True: None, False: None}
    start = last = time.time()
    fps, n = 0.0, 0
    results = model.predict(
        source=args["source"], stream=True, conf=float(args.get("conf", 0.25)), iou=float(args.get("iou", 0.5)),
        imgsz=int(args.get("imgsz", 640)), device=args.get("device") or None, verbose=False,
    )
    for r in results:
        now = time.time()
        fps = 1 / max(now - last, 1e-3) if n == 0 else 0.9 * fps + 0.1 / max(now - last, 1e-3)
        last, n = now, n + 1
        img = r.plot()  # BGR, đã vẽ khung / điểm / mask và nhãn
        h, w = img.shape[:2]
        if max(h, w) > max_side:  # camera 4K: thu nhỏ cho nhẹ đường truyền, kết quả đã vẽ sẵn
            k = max_side / max(h, w)
            img = cv2.resize(img, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA)
        counts = Counter(r.names[int(c)] for c in r.boxes.cls) if r.boxes is not None else Counter()
        text = f"{fps:.1f} FPS"
        cv2.putText(img, text, (12, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 5, cv2.LINE_AA)
        cv2.putText(img, text, (12, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
        ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            continue
        t = (n - 1) / src_fps if src_fps else now - start
        if speed > 0:  # chờ tới đúng lúc khung này phải hiện theo thời gian của video
            play_start = play_start or time.time()
            wait = play_start + t / speed - time.time()
            if wait > 0:
                time.sleep(wait)
        hit = bool(counts)
        prev = last_kept[hit]
        keep = prev is None or not (0 <= t - prev < gaps[hit])
        raw = b""
        if keep:
            last_kept[hit] = t
            orig = r.orig_img
            oh, ow = orig.shape[:2]
            if max(oh, ow) > 1920:
                k = 1920 / max(oh, ow)
                orig = cv2.resize(orig, (int(ow * k), int(oh * k)), interpolation=cv2.INTER_AREA)
            ok, raw_jpg = cv2.imencode(".jpg", orig, [cv2.IMWRITE_JPEG_QUALITY, 92])
            raw = raw_jpg.tobytes() if ok else b""
        infer_ms = sum((r.speed or {}).values())  # tiền xử lý + chạy model + hậu xử lý, ms
        meta = json.dumps({"frame": n, "t": round(t, 2), "fps": round(fps, 1), "counts": dict(counts),
                           "width": w, "height": h, "keep": keep, "infer_ms": round(infer_ms, 1)}).encode()
        data = jpg.tobytes()
        out.write(struct.pack(">III", len(meta), len(data), len(raw)) + meta + data + raw)
        out.flush()
        if limit and now - start > limit:
            break


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "serve":
        idle = float(sys.argv[sys.argv.index("--idle") + 1]) if "--idle" in sys.argv else 30.0
        serve(idle)
    elif len(sys.argv) >= 3 and sys.argv[1] == "stream":
        stream(json.loads(base64.b64decode(sys.argv[2])))  # tham số gói base64 để khỏi lo ký tự đặc biệt
    else:
        print(__doc__)
