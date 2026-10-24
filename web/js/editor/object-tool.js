// Công cụ nhận diện đối tượng: một tool cho cả 3 kiểu vẽ, kiểu nào do LỚP đang chọn quyết định.
//   khung (box)   kéo chuột
//   pose          click lần lượt từng điểm theo thứ tự cấu hình; X = điểm hiện tại không thấy
//   đa giác       click từng đỉnh; click lại đỉnh đầu hoặc Enter để khép
// Đối tượng đã vẽ chỉnh được bất kể lớp đang chọn: kéo điểm / góc / đỉnh, kéo bên trong để di chuyển.
// Gõ đúng tên lớp một ký tự để gán lớp. Khi MỌI lớp tên một ký tự (bộ ký tự biển số 0-9, A-Z):
// khung mới chưa có lớp (đỏ, "?"), gõ phím điền lần lượt vào các khung "?" theo thứ tự đọc — vẽ hết
// khung trước rồi gõ cả biển một mạch; còn khung "?" thì chưa lưu được.

import { clamp, classColor, clsLabel, kpColor, readingOrder, SELECT_COLOR } from '../ui.js';
import { inPoly, label } from './editor.js';

const HIT_R = 9;
const MIN_PX = 4;

/** Sắp 4 điểm theo chiều kim đồng hồ bắt đầu từ góc trên-trái: TL, TR, BR, BL. */
export function orderCorners(p) {
  const cx = p.reduce((a, q) => a + q[0], 0) / 4, cy = p.reduce((a, q) => a + q[1], 0) / 4;
  const s = p.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0;
  s.forEach((q, i) => { if (q[0] + q[1] < s[k][0] + s[k][1]) k = i; });
  return [...s.slice(k), ...s.slice(0, k)];
}

export const shapeOf = o => (o.box ? 'box' : o.pts ? 'pose' : 'polygon');

/** Các điểm thấy được của đối tượng. */
export function pointsOf(o) {
  if (o.box) { const [x1, y1, x2, y2] = o.box; return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]; }
  if (o.pts) return o.pts.filter(Boolean);
  return o.poly;
}

export function bboxOf(o) {
  const p = pointsOf(o), xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const scale = (o, fx, fy, round) => {
  const f = q => q && (round ? [clamp(q[0] * fx, 0, 1), clamp(q[1] * fy, 0, 1)] : [q[0] * fx, q[1] * fy]);
  if (o.box) { const [a, b] = f([o.box[0], o.box[1]]), [c, d] = f([o.box[2], o.box[3]]); return { cls: o.cls, box: [a, b, c, d] }; }
  if (o.pts) return { cls: o.cls, pts: o.pts.map(f) };
  return { cls: o.cls, poly: o.poly.map(f) };
};

export class ObjectTool {
  constructor(classes) {
    this.defs = Object.fromEntries(classes.map(c => [c.id, c]));
    this.typing = classes.length > 1 && classes.every(c => c.name.length === 1);
    this.objects = []; // theo pixel ảnh; cls = -1 là khung chưa gán lớp (chế độ gõ ký tự)
    this.sel = -1;
    this.pending = null; // pose / đa giác đang đặt dở: {type, cls, pts}
    this.drag = null;
  }

  /** Lớp đang chọn — quyết định kiểu vẽ của đối tượng mới. */
  get cfg() { return this.defs[this.editor.currentClass]; }

  // [mô tả, các cách bấm]. Chuỗi bắt đầu bằng "mouse:" là thao tác chuột; "+" là tổ hợp phím.
  get help() {
    const shapes = new Set(Object.values(this.defs).map(c => c.shape));
    const charKeys = Object.values(this.defs).some(c => c.name.length === 1);
    const rows = [];
    if (shapes.has('box')) rows.push(['Vẽ khung', ['mouse:Kéo chuột']]);
    if (shapes.has('pose')) rows.push(['Đặt điểm pose theo thứ tự', ['mouse:Click']], ['Điểm hiện tại không thấy', ['X']]);
    if (shapes.has('polygon')) rows.push(['Đặt đỉnh đa giác', ['mouse:Click']], ['Khép đa giác', ['mouse:Click đỉnh đầu', 'Enter']]);
    rows.push(
      ['Chỉnh điểm, góc, đỉnh', ['mouse:Kéo điểm']],
      ['Di chuyển đối tượng', ['mouse:Kéo bên trong']],
      ['Bỏ điểm vừa đặt, hoặc xoá đối tượng', ['mouse:Chuột phải']],
      ['Xoá đối tượng đang chọn', ['Del']],
      ['Chọn đối tượng kế tiếp', ['Tab']],
      charKeys ? ['Gán lớp có tên một ký tự', ['Gõ ký tự']] : ['Chọn lớp', ['1', '…', '9']],
    );
    return { draw: rows };
  }

  setObjects(list, W, H) {
    this.objects = list.map(o => scale(o, W, H, false));
    this.sel = -1; this.pending = null; this.drag = null;
  }

  getObjects(W, H) { return this.objects.map(o => scale(o, 1 / W, 1 / H, true)); }

  validate() {
    if (this.pending) return 'Còn đối tượng đang vẽ dở: vẽ nốt, bấm Enter để kết thúc hoặc Esc để huỷ';
    const n = this.objects.filter(o => o.cls < 0).length;
    return n ? `Còn ${n} khung chưa gán lớp (khung đỏ "?"): gõ ký tự để gán` : null;
  }

  compatible(o, c) {
    const s = shapeOf(o);
    return s === c.shape && (s !== 'pose' || o.pts.length === c.keypoints.length);
  }

  /** Khung chưa gán kế tiếp theo thứ tự đọc, tính từ sau `from` (vòng lại đầu). */
  _nextUnassigned(from = -1) {
    const order = this._order(), pos = order.indexOf(from);
    return [...order.slice(pos + 1), ...order.slice(0, pos + 1)].find(i => this.objects[i].cls < 0) ?? -1;
  }

  _order() { return readingOrder(this.objects.map((o, i) => ({ box: bboxOf(o), i }))).flat().map(x => x.i); }

  /** Các điểm kéo được của đối tượng i. */
  _handles(i) {
    const o = this.objects[i];
    if (o.box) return pointsOf(o).map((p, k) => ({ k, p }));
    if (o.pts) return o.pts.map((p, k) => ({ k, p })).filter(h => h.p);
    return o.poly.map((p, k) => ({ k, p }));
  }

  _hitHandle(sx, sy) {
    const ed = this.editor;
    const all = [...this.objects.keys()].reverse();
    for (const i of this.sel >= 0 ? [this.sel, ...all] : all)
      for (const { k, p } of this._handles(i)) {
        const [x, y] = ed.toScr(...p);
        if (Math.hypot(x - sx, y - sy) <= HIT_R) return { i, k };
      }
    return null;
  }

  _hitObj(sx, sy) {
    const [x, y] = this.editor.toImg(sx, sy);
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const o = this.objects[i];
      if (o.poly && inPoly(x, y, o.poly)) return i;
      if (o.pts && this.defs[o.cls]?.auto_corners && o.pts.every(Boolean) && inPoly(x, y, o.pts)) return i;
      if (!o.poly) {
        const [x1, y1, x2, y2] = bboxOf(o);
        if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return i;
      }
    }
    return -1;
  }

  down(sx, sy) {
    const ed = this.editor;
    const p = ed.clampImg(ed.toImg(sx, sy));
    if (this.pending) return this._addPending(p, sx, sy);
    const hit = this._hitHandle(sx, sy);
    if (hit) {
      ed.pushHistory();
      this.sel = hit.i;
      const o = this.objects[hit.i];
      if (o.box) {
        const [x1, y1, x2, y2] = o.box;
        // Góc đối diện đứng yên, góc đang kéo đi theo chuột.
        this.drag = { type: 'resize', i: hit.i, fixed: [[x2, y2], [x1, y2], [x1, y1], [x2, y1]][hit.k], moved: false };
      } else this.drag = { type: 'point', i: hit.i, k: hit.k, moved: false };
      return ed.changed();
    }
    const i = this._hitObj(sx, sy);
    if (i >= 0) {
      ed.pushHistory();
      this.sel = i;
      this.drag = { type: 'move', i, start: ed.toImg(sx, sy), orig: JSON.parse(JSON.stringify(this.objects[i])), moved: false };
      return ed.changed();
    }
    this.sel = -1;
    const c = this.cfg;
    if (c?.shape === 'box') this.drag = { type: 'draw', cls: c.id, start: p, cur: null, sx, sy };
    else if (c) { this.pending = { type: c.shape, cls: c.id, pts: [] }; return this._addPending(p, sx, sy); }
    ed.changed();
  }

  _addPending(p, sx, sy) {
    const ed = this.editor, pd = this.pending;
    if (pd.type === 'polygon') {
      if (pd.pts.length >= 3) {
        const [fx, fy] = ed.toScr(...pd.pts[0]);
        if (Math.hypot(fx - sx, fy - sy) <= HIT_R) return this._finish();
      }
      pd.pts.push(p);
    } else {
      pd.pts.push(p);
      if (pd.pts.length >= this.defs[pd.cls].keypoints.length) return this._finish();
    }
    ed.changed();
  }

  _skipPoint() {
    const pd = this.pending;
    pd.pts.push(null);
    if (pd.pts.length >= this.defs[pd.cls].keypoints.length) return this._finish();
    this.editor.changed();
  }

  _finish() {
    const ed = this.editor, pd = this.pending, c = this.defs[pd.cls];
    this.pending = null;
    let obj;
    if (pd.type === 'polygon') {
      if (pd.pts.length < 3) return ed.changed();
      obj = { cls: pd.cls, poly: pd.pts };
    } else {
      const k = c.keypoints.length;
      const pts = [...pd.pts, ...Array(Math.max(0, k - pd.pts.length)).fill(null)].slice(0, k);
      if (!pts.some(Boolean)) return ed.changed();
      obj = { cls: pd.cls, pts: c.auto_corners && pts.every(Boolean) ? orderCorners(pts) : pts };
    }
    ed.pushHistory();
    this.objects.push(obj);
    this.sel = this.objects.length - 1;
    ed.markDirty();
  }

  /** Enter khi đang vẽ dở: khép đa giác / chốt pose (điểm còn thiếu tính là không thấy). */
  finishPending() {
    const pd = this.pending;
    if (!pd) return false;
    if (pd.type === 'polygon' ? pd.pts.length >= 3 : pd.pts.some(Boolean)) this._finish();
    return true;
  }

  move(sx, sy) {
    const d = this.drag, ed = this.editor;
    if (!d) return;
    const p = ed.clampImg(ed.toImg(sx, sy));
    if (d.type === 'draw') { d.cur = p; d.ex = sx; d.ey = sy; return; }
    d.moved = true;
    const o = this.objects[d.i];
    if (d.type === 'resize') {
      o.box = [Math.min(d.fixed[0], p[0]), Math.min(d.fixed[1], p[1]), Math.max(d.fixed[0], p[0]), Math.max(d.fixed[1], p[1])];
    } else if (d.type === 'point') {
      (o.pts || o.poly)[d.k] = p;
    } else {
      const [x0, y0] = d.start, [bx1, by1, bx2, by2] = bboxOf(d.orig), [cx, cy] = ed.toImg(sx, sy);
      const dx = clamp(cx - x0, -bx1, ed.W - bx2), dy = clamp(cy - y0, -by1, ed.H - by2);
      const shift = q => q && [q[0] + dx, q[1] + dy];
      if (d.orig.box) { const [a, b, c, e] = d.orig.box; o.box = [a + dx, b + dy, c + dx, e + dy]; }
      else if (d.orig.pts) o.pts = d.orig.pts.map(shift);
      else o.poly = d.orig.poly.map(shift);
    }
  }

  up() {
    const d = this.drag, ed = this.editor;
    this.drag = null;
    if (!d) return;
    if (d.type === 'draw') {
      if (!d.cur || Math.abs(d.ex - d.sx) < MIN_PX || Math.abs(d.ey - d.sy) < MIN_PX) return;
      ed.pushHistory();
      const [a, b] = [d.start, d.cur];
      this.objects.push({ cls: this.typing ? -1 : d.cls, box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
      // Chế độ gõ: không chọn khung vừa vẽ, để phím gõ điền vào khung "?" đầu tiên theo thứ tự đọc.
      this.sel = this.typing ? -1 : this.objects.length - 1;
      return ed.markDirty();
    }
    if (!d.moved) { ed.history.pop(); return; }
    const o = this.objects[d.i];
    if (o.box && (o.box[2] - o.box[0] < 1 || o.box[3] - o.box[1] < 1)) { this.objects.splice(d.i, 1); this.sel = -1; }
    else if (d.type === 'point' && o.pts && this.defs[o.cls]?.auto_corners && o.pts.every(Boolean)) o.pts = orderCorners(o.pts);
    ed.markDirty();
  }

  rightClick(sx, sy) {
    if (this.cancelPending()) return;
    const h = this._hitHandle(sx, sy);
    const i = h ? h.i : this._hitObj(sx, sy);
    if (i >= 0) this._remove(i);
  }

  cursor(sx, sy) {
    if (this.pending) return 'crosshair';
    const h = this._hitHandle(sx, sy);
    if (h) return this.objects[h.i].box ? (h.k % 2 ? 'nesw-resize' : 'nwse-resize') : 'move';
    return this._hitObj(sx, sy) >= 0 ? 'move' : 'crosshair';
  }

  cancel() { this.pending = null; this.sel = -1; this.drag = null; }

  cancelPending() {
    const pd = this.pending;
    if (!pd) return false;
    pd.pts.pop();
    if (!pd.pts.length) this.pending = null;
    return true;
  }

  deleteSelected() { if (this.sel >= 0) this._remove(this.sel); }

  _remove(i) {
    this.editor.pushHistory();
    this.objects.splice(i, 1);
    this.sel = -1;
    this.editor.markDirty();
  }

  select(i) { this.sel = i; this.editor.changed(); }

  /**
   * Chọn lớp. Đối tượng đang chọn cùng kiểu vẽ thì đổi lớp luôn; khác kiểu thì bỏ chọn,
   * lớp mới chỉ dùng cho đối tượng sắp vẽ. `advance`: sang đối tượng kế tiếp theo thứ tự đọc.
   */
  assignClass(id, { advance = false } = {}) {
    const ed = this.editor, c = this.defs[id];
    if (!c) return;
    if (this.pending && this.pending.cls !== id) this.pending = null;
    ed.currentClass = id;
    if (advance && this.typing && this.sel < 0) this.sel = this._nextUnassigned();
    const o = this.objects[this.sel];
    if (o && this.compatible(o, c)) {
      if (o.cls !== id) { ed.pushHistory(); o.cls = id; ed.dirty = true; }
      if (advance && this.typing) {
        const next = this._nextUnassigned(this.sel);
        if (next >= 0) this.sel = next;
      } else if (advance) {
        const order = this._order(), pos = order.indexOf(this.sel);
        if (pos >= 0 && pos + 1 < order.length) this.sel = order[pos + 1];
      }
    } else if (o) this.sel = -1;
    ed.changed();
  }

  key(e) {
    const ed = this.editor;
    if (e.key === 'Tab') {
      if (!this.objects.length) return true;
      const order = this._order(), pos = order.indexOf(this.sel), step = e.shiftKey ? -1 : 1;
      this.sel = order[pos < 0 ? 0 : (pos + step + order.length) % order.length];
      ed.changed();
      return true;
    }
    if (this.pending?.type === 'pose' && e.key.toLowerCase() === 'x') { this._skipPoint(); return true; }
    if (e.key.length !== 1) return false;
    const byName = ed.classes.find(c => c.name.toLowerCase() === e.key.toLowerCase());
    if (byName) { this.assignClass(byName.id, { advance: true }); return true; }
    if (/^[1-9]$/.test(e.key) && +e.key <= ed.classes.length) { this.assignClass(ed.classes[+e.key - 1].id); return true; }
    return false;
  }

  items() {
    return this._order().map(i => ({
      index: i,
      text: this.objects[i].cls < 0 ? '? (chưa gán)' : clsLabel(this.defs[this.objects[i].cls]),
      color: classColor(this.objects[i].cls),
    }));
  }

  // ---------- vẽ ----------
  _drawObj(c, P, lw, o, sel) {
    const cfg = this.defs[o.cls], col = classColor(o.cls), stroke = sel ? SELECT_COLOR : col;
    const name = o.cls < 0 ? '?' : clsLabel(cfg);
    const [bx1, by1] = P(bboxOf(o));
    if (o.box) {
      const [x1, y1] = P([o.box[0], o.box[1]]), [x2, y2] = P([o.box[2], o.box[3]]);
      if (sel) { c.fillStyle = 'rgba(242,194,48,.16)'; c.fillRect(x1, y1, x2 - x1, y2 - y1); }
      c.strokeStyle = stroke;
      c.lineWidth = (sel ? 2.5 : 1.8) * lw;
      c.setLineDash(o.cls < 0 ? [4 * lw, 3 * lw] : []);
      c.strokeRect(x1, y1, x2 - x1, y2 - y1);
      c.setLineDash([]);
      if (sel) for (const [x, y] of [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]) {
        c.fillStyle = SELECT_COLOR;
        c.fillRect(x - 3.5 * lw, y - 3.5 * lw, 7 * lw, 7 * lw);
      }
      return label(c, name, x1, y1, stroke, lw);
    }
    if (o.poly) {
      c.beginPath();
      o.poly.forEach((q, k) => { const [x, y] = P(q); k ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.closePath();
      c.fillStyle = col + (sel ? '55' : '2a');
      c.fill();
      c.strokeStyle = stroke;
      c.lineWidth = (sel ? 2.5 : 2) * lw;
      c.stroke();
      o.poly.forEach(q => {
        const [x, y] = P(q);
        c.beginPath(); c.arc(x, y, (sel ? 4 : 2.5) * lw, 0, Math.PI * 2); c.fillStyle = stroke; c.fill();
      });
      return label(c, name, bx1, by1, stroke, lw);
    }
    // pose: khung bao (nét đứt) suy ra từ các điểm; 4 góc tự sắp thì tô cả tứ giác như tấm biển.
    const [x2, y2] = P(bboxOf(o).slice(2));
    c.setLineDash([5 * lw, 4 * lw]);
    c.strokeStyle = sel ? SELECT_COLOR : 'rgba(255,255,255,.5)';
    c.lineWidth = lw;
    c.strokeRect(bx1, by1, x2 - bx1, y2 - by1);
    c.setLineDash([]);
    if (cfg?.auto_corners && o.pts.every(Boolean)) {
      c.beginPath();
      o.pts.forEach((q, k) => { const [x, y] = P(q); k ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.closePath();
      c.fillStyle = col + (sel ? '44' : '22');
      c.fill();
      c.strokeStyle = stroke;
      c.lineWidth = (sel ? 2.5 : 2) * lw;
      c.stroke();
    }
    o.pts.forEach((q, k) => {
      if (!q) return;
      const [x, y] = P(q);
      c.beginPath();
      c.arc(x, y, (sel ? 5 : 4) * lw, 0, Math.PI * 2);
      c.fillStyle = kpColor(k);
      c.fill();
      c.strokeStyle = '#000';
      c.lineWidth = lw;
      c.stroke();
    });
    label(c, name, bx1, by1, stroke, lw);
  }

  draw(c, P, lw, hide) {
    const ed = this.editor;
    if (!hide) this.objects.forEach((o, i) => this._drawObj(c, P, lw, o, i === this.sel));
    const d = this.drag;
    if (d?.type === 'draw' && d.cur) {
      const [x1, y1] = P(d.start), [x2, y2] = P(d.cur);
      c.strokeStyle = SELECT_COLOR;
      c.lineWidth = 1.5 * lw;
      c.setLineDash([4 * lw, 3 * lw]);
      c.strokeRect(x1, y1, x2 - x1, y2 - y1);
      c.setLineDash([]);
    }
    const pd = this.pending;
    if (!pd) return;
    const m = ed.mouse.in ? ed.toImg(ed.mouse.x, ed.mouse.y) : null;
    const placed = pd.pts.filter(Boolean);
    if (pd.type === 'polygon' || this.defs[pd.cls].auto_corners) {
      c.beginPath();
      placed.forEach((q, k) => { const [x, y] = P(q); k ? c.lineTo(x, y) : c.moveTo(x, y); });
      if (m && placed.length) c.lineTo(...P(m));
      c.strokeStyle = SELECT_COLOR;
      c.lineWidth = 2 * lw;
      c.stroke();
    }
    pd.pts.forEach((q, k) => {
      if (!q) return;
      const [x, y] = P(q);
      c.beginPath();
      c.arc(x, y, 4 * lw, 0, Math.PI * 2);
      c.fillStyle = pd.type === 'pose' ? kpColor(k) : SELECT_COLOR;
      c.fill();
    });
    if (pd.type === 'polygon' && pd.pts.length >= 3) {
      // Vòng quanh đỉnh đầu: click vào đó để khép.
      const [x, y] = P(pd.pts[0]);
      c.beginPath(); c.arc(x, y, HIT_R * lw, 0, Math.PI * 2); c.strokeStyle = SELECT_COLOR; c.lineWidth = 1.5 * lw; c.stroke();
    }
    if (m && pd.type === 'pose') {
      // Tên điểm cần đặt tiếp theo, ngay cạnh con trỏ.
      const kps = this.defs[pd.cls].keypoints, k = pd.pts.length;
      const [x, y] = P(m);
      label(c, `${kps[k]} (${k + 1}/${kps.length})`, x + 14 * lw, y - 6 * lw, kpColor(k), lw);
    }
  }
}
