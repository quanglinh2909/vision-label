// Lưới ảnh của một danh sách. Cuộn tới đâu tải tới đó.
//   unlabeled (quản trị viên): mọi ảnh chưa gán, kèm người được giao
//   todo      (người gán)    : ảnh được giao chưa làm + ảnh bị trả lại
//   review    (người gán)    : ảnh mình đã nộp, chờ duyệt   (quản trị viên dùng pages/review.js)
//   labeled                  : đã duyệt (người gán: chỉ ảnh của mình)

import { api } from '../api.js';
import { imageTile, setBusy } from '../tiles.js';
import { flashLast } from './review.js';
import { $, esc, getLabeler, h, isAdmin, toast } from '../ui.js';

const PAGE = 120;

const TEXT = {
  unlabeled: {
    title: 'Chưa gán nhãn', start: 'Tự gán nhãn',
    help: 'Ảnh chưa giao cho ai thì bạn tự gán được; gán xong ảnh vào Cần review, bấm Duyệt mới sang Đã duyệt. Chia việc cho người gán nhãn ở mục Phân công.',
    empty: pid => `Không còn ảnh nào chưa gán. <a href="#/p/${pid}/upload">Tải thêm ảnh</a> hoặc xem mục <a href="#/p/${pid}/review">Cần review</a>.`,
  },
  todo: {
    title: 'Việc của tôi', start: 'Bắt đầu gán nhãn',
    empty: () => 'Bạn chưa có ảnh nào cần gán. Khi quản trị viên giao ảnh, chúng sẽ hiện ở đây.',
  },
  rejected: {
    title: 'Bị trả lại', start: 'Xem lần lượt',
    help: 'Ảnh bạn đã trả lại, đang chờ người gán sửa. Rê chuột lên ảnh để xem ghi chú. Muốn giao cho người khác: thu hồi ở mục Phân công.',
    empty: () => 'Không có ảnh nào đang bị trả lại.',
  },
  review: {
    title: 'Chờ duyệt', start: 'Xem lại từ đầu',
    empty: () => 'Chưa có ảnh nào đang chờ duyệt.',
  },
  labeled: {
    title: 'Đã duyệt', start: 'Xem lại từ đầu',
    empty: () => 'Chưa có ảnh nào được duyệt.',
  },
};

export async function mount(el, ctx) {
  const queue = ctx.section;
  const { project } = ctx;
  const T = TEXT[queue];
  // Danh sách "tự phát ảnh": nút bắt đầu để server chọn ảnh (không trùng người khác).
  // Quản trị viên lọc "Chưa gán nhãn" theo người được giao: '' = chưa giao (mặc định), '*' = tất cả.
  const filterable = (queue === 'unlabeled' || queue === 'rejected') && isAdmin();
  const assignee = filterable ? (ctx.query.assignee ?? (queue === 'rejected' ? '*' : '')) : undefined;
  const apiAssignee = assignee === '*' ? undefined : assignee;
  // "Tự phát ảnh" chỉ có nghĩa với ảnh chưa giao (quản trị viên) hoặc việc của người gán.
  const claims = queue === 'todo' || (queue === 'unlabeled' && (!filterable || assignee === ''));
  let size = +(localStorage.getItem('gallery-size') || 220);

  const page = h(`
    <div class="page list-page">
      <div class="listbar">
        <h2 title="${esc(T.help || '')}">${T.title}</h2>
        ${filterable ? '<div class="chips" role="tablist" aria-label="Lọc theo người được giao" data-chips></div>' : ''}
        <span class="muted" data-total></span>
        ${queue === 'todo' && project.rejected_count ? `<span class="tag rejected" title="Ảnh bị trả lại được đưa lên đầu khi bạn bắt đầu gán">${project.rejected_count} ảnh bị trả lại</span>` : ''}
        ${queue === 'labeled' && isAdmin() ? '<span class="labelers" data-labelers></span>' : ''}
        <span class="spacer"></span>
        <label class="row muted size-ctl" title="Cỡ ảnh"><input type="range" min="140" max="440" step="20" value="${size}" data-size aria-label="Cỡ ảnh"></label>
        <button class="sm primary" data-start disabled ${filterable && !claims ? 'hidden' : ''}>${T.start}</button>
      </div>
      <div class="grid"></div>
      <div class="sentinel"></div>
    </div>`);

  if (queue === 'labeled' && isAdmin()) {
    api.labelerStats(ctx.pid).then(stats => {
      const rows = Object.entries(stats);
      if (rows.length) {
        const box = $('[data-labelers]', page);
        box.title = 'Số ảnh đã duyệt theo người gán';
        box.innerHTML = rows.map(([name, n]) => `<span>${esc(name || 'Không rõ')} <b>${n}</b></span>`).join('');
      }
    }).catch(() => { });
  }

  const grid = $('.grid', page);
  grid.style.setProperty('--card', size + 'px');
  $('[data-size]', page).addEventListener('input', e => {
    size = +e.target.value;
    grid.style.setProperty('--card', size + 'px');
    try { localStorage.setItem('gallery-size', size); } catch { }
  });

  let offset = 0, total = Infinity, loading = false, firstId = null;
  const labelUrl = id => `#/p/${ctx.pid}/label/${id}?queue=${queue}${filterable && assignee ? `&assignee=${encodeURIComponent(assignee)}` : ''}`;
  const totalEl = $('[data-total]', page);

  async function more() {
    if (loading || offset >= total) return;
    loading = true;
    try {
      const res = await api.images(ctx.pid, { queue, assignee: apiAssignee, limit: PAGE, offset });
      total = res.total;
      offset += res.items.length;
      if (!firstId && res.items[0]) firstId = res.items[0].id;
      res.items.forEach(img => grid.appendChild(imageTile(img, project, {
        href: labelUrl(img.id),
        assignee: filterable && assignee !== '',
        onDeleted: () => { total--; offset--; totalEl.textContent = `${total} ảnh`; ctx.refreshProject(); },
      })));
      totalEl.textContent = `${total} ảnh`;
      $('[data-start]', page).disabled = !firstId;
      if (!total) {
        grid.innerHTML = filterable && assignee !== ''
          ? `<p class="empty">${assignee === '*' ? T.empty(ctx.pid) : `${esc(assignee)} không còn ảnh nào chưa gán.`}</p>`
          : filterable
            ? `<p class="empty">Không còn ảnh nào chưa giao. Xem ảnh đã giao theo từng người ở các nút phía trên, hoặc <a href="#/p/${ctx.pid}/upload">tải thêm ảnh</a>.</p>`
            : `<p class="empty">${T.empty(ctx.pid)}</p>`;
      }
    } catch (err) { toast(err.message, 'err'); }
    loading = false;
    // Màn hình rộng có thể chứa hết một trang mà sentinel vẫn trong khung -> tải tiếp.
    if (offset < total && sentinel.getBoundingClientRect().top < window.innerHeight + 400) more();
  }

  $('[data-start]', page).addEventListener('click', () => {
    if (firstId) location.hash = labelUrl(claims ? 'next' : firstId);
  });

  if (filterable) {
    // Nút lọc: Chưa giao | từng người (số ảnh chưa gán họ đang giữ) | Tất cả
    api.assignments(ctx.pid).then(st => {
      const me = getLabeler();
      // Ảnh của chính mình ghi "Của bạn" và đứng ngay sau "Chưa giao".
      const field = queue === 'rejected' ? 'rejected' : 'unlabeled';
      const people = st.people.filter(p => p[field] > 0).sort((a, b) => (b.username === me) - (a.username === me));
      const all = (queue === 'unlabeled' ? st.unassigned : 0) + people.reduce((n, p) => n + p[field], 0);
      const chip = (value, label, n) => {
        const href = `#/p/${ctx.pid}/${queue}?assignee=${encodeURIComponent(value)}`;
        return `<a role="tab" href="${href}" aria-selected="${value === assignee}">${label}<span>${n}</span></a>`;
      };
      $('[data-chips]', page).innerHTML =
        (queue === 'unlabeled' ? chip('', 'Chưa giao', st.unassigned) : '') +
        people.map(p => chip(p.username, p.username === me ? 'Của bạn' : esc(p.username), p[field])).join('') +
        chip('*', 'Tất cả', all);
    }).catch(() => { });
  }

  const sentinel = $('.sentinel', page);
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { root: el, rootMargin: '600px' });
  el.replaceChildren(page);
  io.observe(sentinel);
  await more();
  return {
    unmount() { io.disconnect(); },
    onLive(event, data, mine) {
      if (data.kind === 'lock' || data.kind === 'unlock') return setBusy(el, data.image_id, data.locked_by);
      if (!mine) ctx.reload();
    },
    // Quay lại danh sách: tải thêm trang cho đủ cao để cuộn được về vị trí cũ.
    async ensureHeight(px) {
      while (el.scrollHeight < px && offset < total) { const before = offset; await more(); if (offset === before) break; }
    },
    flash: flashLast,
  };
}
