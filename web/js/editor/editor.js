// Lõi trình gán nhãn: hiển thị ảnh, zoom/kéo, kính lúp, hoàn tác.
// Phần vẽ + chỉnh đối tượng nằm ở "tool" (object-tool.js / classify-tool.js), cùng một giao diện:
//   setObjects(norm, W, H) / getObjects(W, H) / validate()
//   down(sx, sy) / move(sx, sy) / up(sx, sy) / rightClick(sx, sy) / cursor(sx, sy)
//   key(e) -> bool / cancel() / cancelPending() -> bool / deleteSelected()
//   draw(ctx, P, lw) / items() / select(i) / assignClass(i)

import { clamp } from '../ui.js';

export class Editor {
  constructor({ canvas, loupe, tool, classes, onChange }) {
    Object.assign(this, { canvas, loupe, tool, classes, onChange });
    this.ctx = canvas.getContext('2d');
    this.lctx = loupe?.getContext('2d');
    this.img = null;
    this.view = { s: 1, ox: 0, oy: 0 };
    this.mouse = { x: 0, y: 0, in: false };
    this.pan = null;
    this.space = false;
    this.hide = false;
    this.dirty = false;
    this.history = [];
    this.currentClass = classes[0]?.id ?? 0; // id lớp dùng cho đối tượng vẽ tiếp theo
    tool.editor = this;
    this._raf = false;
    this._bind();
  }

  get W() { return this.img?.naturalWidth || 1; }
  get H() { return this.img?.naturalHeight || 1; }
  toImg(sx, sy) { return [(sx - this.view.ox) / this.view.s, (sy - this.view.oy) / this.view.s]; }
  toScr(ix, iy) { return [ix * this.view.s + this.view.ox, iy * this.view.s + this.view.oy]; }
  clampImg([x, y]) { return [clamp(x, 0, this.W), clamp(y, 0, this.H)]; }

  async load(url, objects) {
    const img = new Image();
    img.src = url;
    await img.decode();
    this.img = img;
    this.tool.setObjects(objects, this.W, this.H);
    this.history = [];
    this.dirty = false;
    this.fit();
    this.onChange?.();
  }

  getObjects() { return this.tool.getObjects(this.W, this.H); }

  pushHistory() {
    this.history.push(JSON.stringify(this.tool.objects));
    if (this.history.length > 200) this.history.shift();
  }

  undo() {
    if (this.tool.cancelPending()) return this.requestRender();
    if (!this.history.length) return;
    this.tool.objects = JSON.parse(this.history.pop());
    this.tool.sel = -1;
    this.markDirty();
  }

  markDirty() {
    this.dirty = true;
    this.onChange?.();
    this.requestRender();
  }

  /** Báo thay đổi lựa chọn / lớp hiện tại mà không đổi dữ liệu. */
  changed() { this.onChange?.(); this.requestRender(); }

  fit() {
    if (!this.img) return;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = Math.min(r.width / this.W, r.height / this.H) * 0.96;
    this.view = { s, ox: (r.width - this.W * s) / 2, oy: (r.height - this.H * s) / 2 };
    this.requestRender();
  }

  toggleLabels() { this.hide = !this.hide; this.changed(); }

  // ---------- phím ----------
  /** Phím chung cho mọi tool. Trả true nếu đã xử lý. */
  key(e) {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { this.undo(); return true; }
    if (mod && k === '0') { this.fit(); return true; }
    if (mod || e.altKey) return false;
    if (k === ' ') { this.space = true; this.canvas.style.cursor = 'grab'; return true; }
    if (k === '\\') { this.toggleLabels(); return true; }
    if (k === 'escape') { this.tool.cancel(); this.changed(); return true; }
    if (k === 'delete' || k === 'backspace') { this.tool.deleteSelected(); return true; }
    return this.tool.key(e);
  }

  keyup(e) {
    if (e.key === ' ') { this.space = false; this.canvas.style.cursor = 'crosshair'; }
  }

  // ---------- chuột ----------
  _bind() {
    const c = this.canvas;
    this._h = {
      down: e => {
        if (!this.img) return;
        const sx = e.offsetX, sy = e.offsetY;
        if (e.button === 1 || (e.button === 0 && this.space)) {
          e.preventDefault();
          this.pan = { sx, sy, ox: this.view.ox, oy: this.view.oy, moved: true, right: false };
        } else if (e.button === 2) {
          this.pan = { sx, sy, ox: this.view.ox, oy: this.view.oy, moved: false, right: true };
        } else if (e.button === 0) {
          this.tool.down(sx, sy);
          this.requestRender();
        }
      },
      move: e => {
        const r = c.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        this.mouse = { x: sx, y: sy, in: sx >= 0 && sy >= 0 && sx < r.width && sy < r.height };
        if (this.pan) {
          if (Math.hypot(sx - this.pan.sx, sy - this.pan.sy) > 3) this.pan.moved = true;
          if (this.pan.moved) { this.view.ox = this.pan.ox + sx - this.pan.sx; this.view.oy = this.pan.oy + sy - this.pan.sy; }
        } else if (this.img) {
          this.tool.move(sx, sy);
        }
        if (this.img) {
          c.style.cursor = this.space || this.pan?.moved ? 'grab' : this.tool.cursor(sx, sy);
          this.requestRender();
        }
      },
      up: () => {
        if (this.pan) {
          const { right, moved, sx, sy } = this.pan;
          this.pan = null;
          if (right && !moved) this.tool.rightClick(sx, sy);
        } else if (this.img) this.tool.up();
        this.requestRender();
      },
      wheel: e => {
        if (!this.img) return;
        e.preventDefault();
        const ns = clamp(this.view.s * Math.exp(-e.deltaY * 0.0015), 0.05, 60);
        const [ix, iy] = this.toImg(e.offsetX, e.offsetY);
        this.view = { s: ns, ox: e.offsetX - ix * ns, oy: e.offsetY - iy * ns };
        this.requestRender();
      },
      leave: () => { this.mouse.in = false; this.requestRender(); },
      menu: e => e.preventDefault(),
    };
    // Pointer events: một bộ sự kiện cho chuột, cảm ứng và bút (chạm để đặt góc trên máy tính bảng).
    c.style.touchAction = 'none'; // chạm vào canvas không cuộn / phóng to trang
    c.addEventListener('pointerdown', this._h.down);
    c.addEventListener('wheel', this._h.wheel, { passive: false });
    c.addEventListener('pointerleave', this._h.leave);
    c.addEventListener('contextmenu', this._h.menu);
    window.addEventListener('pointermove', this._h.move);
    window.addEventListener('pointerup', this._h.up);
    this._ro = new ResizeObserver(() => {
      const r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      if (this.img && !this._fitted) { this._fitted = true; this.fit(); }
      this.requestRender();
    });
    this._ro.observe(c.parentElement);
  }

  destroy() {
    window.removeEventListener('pointermove', this._h.move);
    window.removeEventListener('pointerup', this._h.up);
    this._ro.disconnect();
  }

  // ---------- vẽ ----------
  requestRender() {
    if (this._raf) return;
    this._raf = true;
    requestAnimationFrame(() => { this._raf = false; this._render(); });
  }

  _scene(c, s, ox, oy, lw) {
    c.save();
    c.imageSmoothingEnabled = s < 2;
    c.drawImage(this.img, ox, oy, this.W * s, this.H * s);
    const P = ([x, y]) => [x * s + ox, y * s + oy];
    this.tool.draw(c, P, lw, this.hide);
    c.restore();
  }

  _render() {
    const c = this.ctx, dpr = devicePixelRatio || 1;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#1d2125';
    c.fillRect(0, 0, W, H);
    if (this.lctx) { this.lctx.fillStyle = '#1d2125'; this.lctx.fillRect(0, 0, this.loupe.width, this.loupe.height); }
    if (!this.img) return;
    this._scene(c, this.view.s, this.view.ox, this.view.oy, 1);
    if (!this.mouse.in || this.tool.noCrosshair) return;

    // Đường gióng chữ thập giúp căn góc.
    c.strokeStyle = 'rgba(255,255,255,.35)';
    c.lineWidth = 1;
    c.setLineDash([4, 4]);
    c.beginPath();
    c.moveTo(0, this.mouse.y + 0.5); c.lineTo(W, this.mouse.y + 0.5);
    c.moveTo(this.mouse.x + 0.5, 0); c.lineTo(this.mouse.x + 0.5, H);
    c.stroke();
    c.setLineDash([]);

    if (this.lctx) {
      const [ix, iy] = this.toImg(this.mouse.x, this.mouse.y);
      const ls = Math.max(this.view.s * 4, 2), LW = this.loupe.width, LH = this.loupe.height;
      this._scene(this.lctx, ls, LW / 2 - ix * ls, LH / 2 - iy * ls, 1.5);
      const l = this.lctx;
      l.strokeStyle = '#ff4d4d';
      l.lineWidth = 1;
      l.beginPath();
      l.moveTo(LW / 2, 0); l.lineTo(LW / 2, LH); l.moveTo(0, LH / 2); l.lineTo(LW, LH / 2);
      l.stroke();
    }
  }
}

export function inPoly(x, y, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function label(c, text, x, y, color, lw) {
  c.font = `600 ${12 * lw}px system-ui, sans-serif`;
  const tw = c.measureText(text).width;
  c.fillStyle = color;
  c.fillRect(x, y - 16 * lw, tw + 8 * lw, 16 * lw);
  c.fillStyle = '#000';
  c.fillText(text, x + 4 * lw, y - 4 * lw);
}
