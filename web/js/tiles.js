// Ô ảnh thu nhỏ có vẽ sẵn nhãn — dùng chung cho các lưới ảnh và trang review.

import { api } from './api.js';
import { $, classColor, classMap, clsLabel, esc, getLabeler, h, isAdmin, kpColor, ocrText, plate, toast, UNKNOWN } from './ui.js';

export const STATUS = {
  unlabeled: 'Chưa gán',
  in_review: 'Chờ duyệt',
  rejected: 'Bị trả lại',
  labeled: 'Đã duyệt',
};

function overlay(img) {
  const sw = 'vector-effect="non-scaling-stroke"';
  return img.annotations.map(o => {
    const c = classColor(o.cls);
    if (o.box) {
      const [x1, y1, x2, y2] = o.box;
      return `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${c}" stroke-width="2" ${sw}/>`;
    }
    if (o.poly) return `<polygon points="${o.poly.map(p => p.join(',')).join(' ')}" fill="${c}33" stroke="${c}" stroke-width="2" ${sw}/>`;
    if (!o.pts) return '';
    const vis = o.pts.filter(Boolean);
    const shape = vis.length === o.pts.length && vis.length >= 3
      ? `<polygon points="${vis.map(p => p.join(',')).join(' ')}" fill="${c}33" stroke="${c}" stroke-width="2" ${sw}/>` : '';
    const dots = o.pts.map((p, k) => p &&
      `<line x1="${p[0]}" y1="${p[1]}" x2="${p[0]}" y2="${p[1]}" stroke="${kpColor(k)}" stroke-width="7" stroke-linecap="round" ${sw}/>`).join('');
    return shape + dots;
  }).join('');
}

/** Tóm tắt nhãn một dòng dưới ảnh. */
function summaryOf(img, project) {
  const defs = classMap(project);
  if (project.task === 'classify') {
    const parts = img.annotations.filter(o => o.value !== UNKNOWN).map(o => defs[o.cls]?.options.find(x => x.id === o.value)).filter(Boolean).map(x => x.label || x.name);
    return parts.length ? `<span class="tag ${img.status}">${esc(parts.join(' · '))}</span>` : '<span class="tag">Không rõ</span>';
  }
  if (!img.object_count) return `<span class="tag ${img.status}">ảnh nền</span>`;
  // Bộ ký tự (mọi lớp tên một ký tự, vẽ khung): đọc thành chuỗi biển số.
  if (project.classes.every(c => c.name.length === 1 && c.shape === 'box')) return plate(ocrText(img.annotations, project.classes), 'sm');
  const counts = {};
  for (const o of img.annotations) counts[o.cls] = (counts[o.cls] || 0) + 1;
  const groups = Object.entries(counts);
  const text = groups.length <= 2 ? groups.map(([cls, n]) => `${n} ${clsLabel(defs[cls])}`).join(', ') : `${img.object_count} đối tượng`;
  return `<span class="tag ${img.status}">${esc(text)}</span>`;
}

/** Cập nhật nhãn "X đang mở" trên một ô ảnh khi có người mở / đóng ảnh (realtime). */
export function setBusy(root, imageId, lockedBy) {
  const tile = root.querySelector(`.tile[data-id="${CSS.escape(imageId)}"]`);
  if (!tile) return;
  tile.querySelector('.tag.busy')?.remove();
  if (lockedBy && lockedBy !== getLabeler()) {
    tile.querySelector('.fname').insertAdjacentHTML('beforebegin', `<span class="tag busy">${esc(lockedBy)} đang mở</span>`);
  }
}

/**
 * opts.href      đường dẫn mở ảnh trong trình gán nhãn
 * opts.assignee  hiện "Giao cho X" (quản trị viên xem danh sách chưa gán)
 * opts.onDeleted gọi sau khi xoá ảnh (chỉ quản trị viên thấy nút xoá)
 */
export function imageTile(img, project, { href, assignee = false, onDeleted } = {}) {
  const me = getLabeler();
  const wide = img.width / img.height >= 16 / 10;
  const busy = img.locked_by && img.locked_by !== me;
  const done = img.status !== 'unlabeled';
  const tip = [
    img.filename,
    img.assigned_to && `Giao cho ${img.assigned_to}`,
    img.labeled_by && `Gán bởi ${img.labeled_by}`,
    img.edited_by && img.edited_by !== img.labeled_by && `Sửa cuối bởi ${img.edited_by}`,
    img.reviewed_by && img.status === 'labeled' && `Duyệt bởi ${img.reviewed_by}`,
    img.status === 'rejected' && img.review_note && `Trả lại: ${img.review_note}`,
    busy && `${img.locked_by} đang mở`,
  ].filter(Boolean).join('\n');

  let summary = '';
  if (img.status === 'rejected') summary = '<span class="tag rejected">Bị trả lại</span>';
  else if (done) summary = summaryOf(img, project);

  const t = h(`
    <div class="tile" title="${esc(tip)}" tabindex="0" data-id="${esc(img.id)}">
      <div class="thumb">
        <div class="frame ${wide ? 'wide' : 'tall'}" style="aspect-ratio:${img.width}/${img.height}">
          <img loading="lazy" src="${api.thumbUrl(img.id)}" alt="">
          ${img.annotations.length && project.task === 'detect' ? `<svg viewBox="0 0 1 1" preserveAspectRatio="none">${overlay(img)}</svg>` : ''}
        </div>
      </div>
      <div class="meta">
        ${summary}
        ${assignee && img.assigned_to ? `<span class="tag assignee">${esc(img.assigned_to)}</span>` : ''}
        ${busy ? `<span class="tag busy">${esc(img.locked_by)} đang mở</span>` : ''}
        <span class="fname">${esc(img.filename)}</span>
      </div>
      ${isAdmin() && onDeleted ? '<button class="del sm danger" title="Xoá ảnh khỏi project">Xoá</button>' : ''}
    </div>`);
  t.addEventListener('click', () => { location.hash = href; });
  t.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === t) location.hash = href; });

  const del = $('.del', t);
  del?.addEventListener('click', async e => {
    e.stopPropagation();
    if (!del.dataset.armed) {
      del.dataset.armed = '1'; del.textContent = 'Bấm lần nữa để xoá';
      setTimeout(() => { delete del.dataset.armed; del.textContent = 'Xoá'; }, 2500);
      return;
    }
    try { await api.deleteImage(img.id); t.remove(); onDeleted(); }
    catch (err) { toast(err.message, 'err'); }
  });
  return t;
}

// ---------- lọc theo lớp và số đối tượng (project nhận diện) ----------
// Trên URL: ?cls=<id lớp> = ảnh CÓ đối tượng lớp đó; &missing=1 = ảnh CHƯA có (tìm ảnh còn thiếu nhãn);
// &count=<n>&op=eq|gte|lte = số đối tượng của lớp đó (không có cls = đếm mọi lớp), VD ảnh có đúng 2 xe.
const OPS = { eq: '=', gte: '≥', lte: '≤' };

/** {cls, missing, count, op} từ query của URL, hoặc null nếu không lọc. cls / count có thể là null. */
export function readClassFilter(query) {
  const num = v => (v === undefined || v === '' || Number.isNaN(+v) ? null : +v);
  const cls = num(query.cls), count = num(query.count);
  if (cls === null && count === null) return null;
  return { cls, missing: cls !== null && query.missing === '1', count: query.missing === '1' ? null : count, op: OPS[query.op] ? query.op : 'eq' };
}

/** Đuôi query giữ bộ lọc khi dựng link (bắt đầu bằng &, rỗng nếu không lọc). */
export const filterQuery = f => (!f ? '' : [
  f.cls !== null ? `&cls=${f.cls}` : '', f.missing ? '&missing=1' : '',
  f.count !== null ? `&count=${f.count}${f.op !== 'eq' ? `&op=${f.op}` : ''}` : '',
].join(''));

/** Tham số gửi API (api.images / api.refs). */
export const filterParams = f => (!f ? {} : {
  cls: f.cls ?? undefined, missing: f.missing || undefined,
  count: f.count ?? undefined, op: f.count !== null && f.op !== 'eq' ? f.op : undefined,
});

/** Ảnh có khớp bộ lọc không — giống matches_filter ở server (images/image_service.py). */
export function matchesFilter(img, f) {
  if (!f) return true;
  const n = img.annotations.filter(o => f.cls === null || o.cls === f.cls).length;
  if (f.missing) return n === 0;
  if (f.count === null) return n > 0;
  return f.op === 'gte' ? n >= f.count : f.op === 'lte' ? n <= f.count : n === f.count;
}

/** Ô chọn lớp + ô số đối tượng; đổi gì thì gọi go(filter mới hoặc null). Project phân loại không có. */
export function classFilter(project, f, go) {
  if (project.task !== 'detect' || !project.classes.length) return null;
  const cur = !f || f.cls === null ? '' : `${f.missing ? 'miss' : 'has'}:${f.cls}`;
  const opt = (v, text) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(text)}</option>`;
  const el = h(`<span class="cls-filter-box" title="Lọc ảnh theo lớp và số đối tượng. VD: Có Xe máy, = 2 là ảnh có đúng 2 xe máy">
    <select class="cls-filter" aria-label="Lọc theo lớp">
      ${opt('', 'Mọi lớp')}
      <optgroup label="Ảnh có lớp">${project.classes.map(c => opt(`has:${c.id}`, `Có ${clsLabel(c)}`)).join('')}</optgroup>
      <optgroup label="Ảnh chưa có lớp (thiếu nhãn)">${project.classes.map(c => opt(`miss:${c.id}`, `Thiếu ${clsLabel(c)}`)).join('')}</optgroup>
    </select>
    <select class="cls-op" aria-label="So sánh số đối tượng">${Object.entries(OPS).map(([k, t]) => `<option value="${k}" ${f?.op === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <input class="cls-count" type="number" min="0" max="10000" placeholder="số" aria-label="Số đối tượng" value="${f?.count ?? ''}">
  </span>`);
  const [sel, op, count] = el.querySelectorAll('select, input');
  const countable = () => !sel.value.startsWith('miss:'); // "thiếu lớp" = 0 đối tượng, không cần ô số
  const apply = () => {
    const [kind, id] = sel.value.split(':');
    const n = count.value.trim() === '' || !countable() ? null : Math.max(0, Math.floor(+count.value));
    const cls = sel.value ? +id : null;
    go(cls === null && n === null ? null : { cls, missing: kind === 'miss', count: n, op: op.value });
  };
  const refresh = () => { op.hidden = count.hidden = !countable(); };
  sel.addEventListener('change', () => { refresh(); apply(); });
  op.addEventListener('change', () => { if (count.value.trim() !== '') apply(); });
  count.addEventListener('change', apply); // Enter hoặc rời ô số
  refresh();
  return el;
}
