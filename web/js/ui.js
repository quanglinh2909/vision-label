// Helper dùng chung cho mọi trang.

// TL, TR, BR, BL
export const KP_COLORS = ['#ff5a4f', '#3fb27f', '#4a8fe7', '#f2c230'];
export const SELECT_COLOR = '#f2c230';

export const TASKS = {
  detect: {
    label: 'Nhận diện đối tượng',
    desc: 'Khoanh đối tượng trong ảnh. Mỗi lớp tự chọn kiểu: khung, pose (điểm) hoặc đa giác. Xuất YOLO detect, pose, segment.',
    // Sơ đồ: một khung (xe) chứa một tấm biển có 4 điểm góc.
    figure: `<svg viewBox="0 0 72 48" aria-hidden="true">
      <rect x="5" y="5" width="62" height="38" rx="2" fill="none" stroke="#4a8fe7" stroke-width="2.2"/>
      <rect x="21" y="22" width="30" height="14" rx="2" fill="#f3f5f2" stroke="#1a1d21" stroke-width="2"/>
      <text x="36" y="32.5" text-anchor="middle" font-family="Barlow Condensed, sans-serif" font-weight="700" font-size="9" fill="#1a1d21">29A-123</text>
      ${[[21, 22], [51, 22], [51, 36], [21, 36]].map(([x, y], k) => `<circle cx="${x}" cy="${y}" r="2.8" fill="${KP_COLORS[k]}" stroke="#1a1d21" stroke-width="1"/>`).join('')}
    </svg>`,
  },
  classify: {
    label: 'Phân loại ảnh',
    desc: 'Trả lời câu hỏi cho cả ảnh, VD "Đeo khẩu trang": có, không hoặc không rõ. Xuất dataset cho MobileNet, ResNet.',
    // Sơ đồ: một ảnh và ba lựa chọn, một lựa chọn đang bật.
    figure: `<svg viewBox="0 0 72 48" aria-hidden="true">
      <rect x="4" y="6" width="30" height="36" rx="3" fill="#353b42" stroke="#9aa3ad" stroke-width="1.6"/>
      <circle cx="19" cy="20" r="6" fill="none" stroke="#e9ece8" stroke-width="1.8"/>
      <path d="M10 37c1.5-6 5-8 9-8s7.5 2 9 8" fill="none" stroke="#e9ece8" stroke-width="1.8"/>
      ${[['Có', 9, true], ['Không', 21, false], ['?', 33, false]].map(([t, y, on]) => `
        <rect x="40" y="${y - 5}" width="28" height="10" rx="2" fill="${on ? '#f2c230' : 'none'}" stroke="${on ? '#f2c230' : '#9aa3ad'}" stroke-width="1.4"/>
        <text x="54" y="${y + 3}" text-anchor="middle" font-family="Barlow, sans-serif" font-weight="600" font-size="7.5" fill="${on ? '#2a2206' : '#e9ece8'}">${t}</text>`).join('')}
    </svg>`,
  },
};

// Kiểu vẽ của một lớp (project nhận diện đối tượng). `yolo` = định dạng xuất nguyên vẹn.
export const SHAPES = {
  box: { label: 'Detect', yolo: 'detect', how: 'Kéo chuột để vẽ khung.' },
  pose: { label: 'Pose', yolo: 'pose', how: 'Click lần lượt từng điểm theo thứ tự.' },
  polygon: { label: 'Segment', yolo: 'segment', how: 'Click từng đỉnh; click lại đỉnh đầu hoặc Enter để khép.' },
};
export const UNKNOWN = -1; // lựa chọn "Không rõ" của project phân loại
export const UNKNOWN_LABEL = 'Không rõ';
/** Màu của điểm thứ k (4 điểm đầu giữ màu góc biển số quen thuộc). */
export const kpColor = k => (k < KP_COLORS.length ? KP_COLORS[k] : PALETTE[k % PALETTE.length]);
/** Tên hiển thị của lớp (lớp cũ chưa có thì dùng tên trong dataset). */
export const clsLabel = c => c?.label || c?.name || '?';
/** {id lớp: cấu hình lớp} */
export const classMap = project => Object.fromEntries(project.classes.map(c => [c.id, c]));

const svg = body => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  upload: svg('<path d="M10 13V3M6 7l4-4 4 4M3 13v3h14v-3"/>'),
  unlabeled: svg('<rect x="3" y="5" width="14" height="10" rx="2" stroke-dasharray="2.5 2"/>'),
  labeled: svg('<rect x="3" y="5" width="14" height="10" rx="2"/><path d="M7 10l2 2 4-4"/>'),
  todo: svg('<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M7 4V2.5M13 4V2.5M6.5 10l2.5 2.5 4.5-4.5"/>'),
  review: svg('<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4M6.8 9l1.6 1.6 3-3"/>'),
  rejected: svg('<path d="M8 5L4 9l4 4"/><path d="M4 9h8a4 4 0 010 8h-2"/>'),
  assign: svg('<circle cx="7" cy="7" r="3"/><path d="M2 17c0-3 2.2-5 5-5s5 2 5 5M14 7h4M16 5v4"/>'),
  datasets: svg('<path d="M10 3l7 3.5-7 3.5-7-3.5z"/><path d="M3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5"/>'),
  classes: svg('<path d="M3 4h6.5l7.5 7.5-5 5L4.5 9H3z"/><circle cx="6.5" cy="7.5" r="1.2"/>'),
  settings: svg('<path d="M4 6h8M15 6h1M4 14h1M8 14h8"/><circle cx="13.5" cy="6" r="1.6"/><circle cx="6.5" cy="14" r="1.6"/>'),
  drop: `<svg viewBox="0 0 64 44" aria-hidden="true"><rect x="6" y="8" width="52" height="28" rx="4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="5 4"/><path d="M32 30V15M26 20l6-6 6 6" fill="none" stroke="#f2c230" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

/** Tấm biển số — điểm nhấn thị giác dùng cho logo, tên project và chuỗi OCR. */
export const plate = (text, size = '') => `<span class="plate ${size}"><span>${esc(text)}</span></span>`;
export const PALETTE = ['#4a8fe7', '#3fb27f', '#ff8a5c', '#c39bf5', '#4fd1c5', '#f27fb2', '#a3d44f', '#7aa7ff', '#ffb366', '#5fd38d'];

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(msg, kind = 'ok', ms = 3500) {
  const el = h(`<div class="toast ${kind}"></div>`);
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- phiên đăng nhập ----------
// Người đang đăng nhập (app.js nạp từ /api/auth/status lúc mở trang). Tên đăng nhập cũng là
// tên được ghi vào "ai đang gán / ai đã gán" ở server.
export const session = { user: null };
export const isAdmin = () => session.user?.role === 'admin';
export const getLabeler = () => session.user?.username || '';

/** Hộp thoại dùng chung (thẻ <dialog> của trình duyệt, giao diện của trang). */
export function openDialog(html, onSubmit) {
  return new Promise(resolve => {
    const dlg = h(`<dialog class="dialog"><form method="dialog">${html}</form></dialog>`);
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try { done(await onSubmit(form)); }
      catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    });
    form.querySelector('[data-cancel]')?.addEventListener('click', () => done(null));
    dlg.addEventListener('cancel', () => done(null));
    dlg.showModal();
    form.querySelector('input')?.focus();
  });
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

/** Màu cố định cho một lớp, để cùng một ký tự luôn cùng màu. */
export const classColor = cls => (cls < 0 ? '#ff5a4f' : PALETTE[cls % PALETTE.length]);

/**
 * Xếp box ký tự theo thứ tự đọc (trên xuống, trái sang phải; biển 2 dòng thành 2 dòng).
 * boxes: [{box:[x1,y1,x2,y2], ...}] — trả về mảng các dòng, mỗi dòng là mảng box.
 */
export function readingOrder(boxes) {
  if (!boxes.length) return [];
  const items = boxes.map(b => ({ b, cx: (b.box[0] + b.box[2]) / 2, cy: (b.box[1] + b.box[3]) / 2, h: b.box[3] - b.box[1] }));
  const hs = items.map(i => i.h).sort((a, b) => a - b);
  const medH = hs[hs.length >> 1] || 1;
  items.sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const it of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(it.cy - line.cy) < medH * 0.5) {
      line.items.push(it);
      line.cy = line.items.reduce((s, i) => s + i.cy, 0) / line.items.length;
    } else lines.push({ cy: it.cy, items: [it] });
  }
  return lines.map(l => l.items.sort((a, b) => a.cx - b.cx).map(i => i.b));
}

export function ocrText(objects, classes) {
  const names = Object.fromEntries(classes.map(c => [c.id, c.name]));
  return readingOrder(objects.filter(o => o.box)).map(line => line.map(o => names[o.cls] ?? '?').join('')).join(' ');
}
