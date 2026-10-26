// Lưới ảnh của một danh sách. Cuộn tới đâu tải tới đó.
//   unlabeled (quản trị viên): mọi ảnh chưa gán, kèm người được giao
//   todo      (người gán)    : ảnh được giao chưa làm + ảnh bị trả lại
//   review    (người gán)    : ảnh mình đã nộp, chờ duyệt   (quản trị viên dùng pages/review.js)
//   labeled                  : đã duyệt (người gán: chỉ ảnh của mình)

import { api } from '../api.js';
import { classFilter, filterParams, filterQuery, imageTile, readClassFilter, setBusy } from '../tiles.js';
import { flashLast } from './review.js';
import { $, esc, getLabeler, h, isAdmin, openDialog, toast } from '../ui.js';

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
  // Quản trị viên xoá nhiều ảnh chưa gán (VD tải nhầm cả thư mục): chọn từng ảnh, hoặc xoá cả danh sách.
  const bulk = queue === 'unlabeled' && isAdmin();
  const clsF = readClassFilter(ctx.query); // lọc theo lớp: ảnh có / chưa có lớp đó
  let size = +(localStorage.getItem('gallery-size') || 220);

  const page = h(`
    <div class="page list-page">
      <div class="listbar">
        <h2 title="${esc(T.help || '')}">${T.title}</h2>
        ${filterable ? '<div class="chips" role="tablist" aria-label="Lọc theo người được giao" data-chips></div>' : ''}
        <span data-cls-filter></span>
        <span class="muted" data-total></span>
        ${queue === 'todo' && project.rejected_count ? `<span class="tag rejected" title="Ảnh bị trả lại được đưa lên đầu khi bạn bắt đầu gán">${project.rejected_count} ảnh bị trả lại</span>` : ''}
        ${queue === 'labeled' && isAdmin() ? '<span class="labelers" data-labelers></span>' : ''}
        <span class="spacer"></span>
        ${bulk ? `<label class="check" title="Chọn mọi ảnh đang hiện (cuộn xuống để tải thêm). Bấm ô vuông ở góc ảnh để chọn từng ảnh, giữ Shift để chọn cả dải.">
            <input type="checkbox" data-select-all> Chọn tất cả</label>
          <span class="muted picked" data-picked></span>
          <button class="sm danger" data-del-picked hidden>Xoá</button>
          <button class="sm danger" data-del-all disabled title="Xoá mọi ảnh trong danh sách đang xem (theo bộ lọc phía trên), kể cả ảnh chưa cuộn tới">Xoá tất cả</button>` : ''}
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
  const labelUrl = id => `#/p/${ctx.pid}/label/${id}?queue=${queue}${filterable && assignee ? `&assignee=${encodeURIComponent(assignee)}` : ''}${filterQuery(clsF)}`;
  const listUrl = (who, f) => `#/p/${ctx.pid}/${queue}?${filterable ? `assignee=${encodeURIComponent(who)}` : ''}${filterQuery(f)}`;
  const sel = classFilter(project, clsF, f => { location.hash = listUrl(assignee, f); });
  if (sel) $('[data-cls-filter]', page).replaceWith(sel);
  const totalEl = $('[data-total]', page);

  async function more() {
    if (loading || offset >= total) return;
    loading = true;
    try {
      const res = await api.images(ctx.pid, { queue, assignee: apiAssignee, limit: PAGE, offset, ...filterParams(clsF) });
      total = res.total;
      offset += res.items.length;
      if (!firstId && res.items[0]) firstId = res.items[0].id;
      res.items.forEach(img => {
        const tile = imageTile(img, project, {
          href: labelUrl(img.id),
          assignee: filterable && assignee !== '',
          onDeleted: () => { forget([img.id]); ctx.refreshProject(); },
        });
        if (bulk) addPick(tile, img);
        grid.appendChild(tile);
      });
      totalEl.textContent = `${total} ảnh`;
      $('[data-start]', page).disabled = !firstId;
      if (bulk) sync();
      if (!total && clsF) {
        grid.innerHTML = '<p class="empty">Không có ảnh nào khớp bộ lọc. Chọn <b>Mọi lớp</b> và xoá ô số để xem hết.</p>';
      } else if (!total) {
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

  // ---------- chọn nhiều / xoá (quản trị viên, mục Chưa gán nhãn) ----------
  const picked = new Set();
  const tiles = []; // [{img, tile, box}] theo thứ tự hiện trên lưới
  let anchor = -1; // ảnh bấm gần nhất — mốc cho Shift + bấm chọn cả dải

  function sync() {
    for (const { img, tile, box } of tiles) { box.checked = picked.has(img.id); tile.classList.toggle('picked', picked.has(img.id)); }
    grid.classList.toggle('selecting', picked.size > 0);
    const del = $('[data-del-picked]', page), all = $('[data-select-all]', page);
    del.hidden = !picked.size;
    del.textContent = `Xoá ${picked.size} ảnh`;
    delete del.dataset.armed;
    $('[data-picked]', page).textContent = picked.size ? `Đã chọn ${picked.size}` : '';
    all.checked = tiles.length > 0 && picked.size === tiles.length;
    all.indeterminate = picked.size > 0 && picked.size < tiles.length;
    $('[data-del-all]', page).disabled = !total || total === Infinity;
  }

  function toggle(i, shift) {
    if (shift && anchor >= 0) {
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) picked.add(tiles[k].img.id);
    } else if (picked.has(tiles[i].img.id)) picked.delete(tiles[i].img.id);
    else picked.add(tiles[i].img.id);
    anchor = i;
    sync();
  }

  function addPick(tile, img) {
    // Trang tự xử lý cả ô vuông (không để trình duyệt tự đổi checkbox) để luôn biết có giữ Shift không.
    const pick = h(`<span class="pick" role="checkbox" tabindex="-1" title="Chọn ảnh này"><input type="checkbox" tabindex="-1" aria-label="Chọn ${esc(img.filename)}"></span>`);
    pick.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggle(tiles.findIndex(t => t.tile === tile), e.shiftKey); });
    tile.appendChild(pick);
    tiles.push({ img, tile, box: pick.querySelector('input') });
  }

  /** Bỏ các ảnh đã xoá khỏi lưới và khỏi số đếm. */
  function forget(ids) {
    const gone = new Set(ids);
    for (let k = tiles.length - 1; k >= 0; k--) {
      if (gone.has(tiles[k].img.id)) { tiles[k].tile.remove(); tiles.splice(k, 1); }
    }
    ids.forEach(id => picked.delete(id));
    total -= ids.length; offset -= ids.length;
    totalEl.textContent = `${total} ảnh`;
    anchor = -1;
    if (bulk) sync();
    if (!total) ctx.reload(); // hết ảnh: dựng lại trang để hiện lời nhắc trống
  }

  if (bulk) {
    // Bấm vào ảnh khi giữ Shift / Ctrl, hoặc khi đang có ảnh được chọn -> chọn thay vì mở ảnh.
    grid.addEventListener('click', e => {
      const tile = e.target.closest('.tile');
      if (!tile || e.target.closest('.pick, .del')) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || picked.size) {
        e.preventDefault();
        e.stopPropagation();
        toggle(tiles.findIndex(t => t.tile === tile), e.shiftKey);
      }
    }, true);
    grid.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); });

    $('[data-select-all]', page).addEventListener('change', e => {
      picked.clear();
      if (e.target.checked) tiles.forEach(t => picked.add(t.img.id));
      anchor = -1;
      sync();
    });

    $('[data-del-picked]', page).addEventListener('click', async e => {
      const b = e.currentTarget;
      if (!b.dataset.armed) {
        b.dataset.armed = '1'; b.textContent = `Bấm lần nữa để xoá ${picked.size} ảnh`;
        setTimeout(() => { if (b.dataset.armed) sync(); }, 3000);
        return;
      }
      b.disabled = true;
      try {
        const ids = [...picked];
        const r = await api.deleteImages(ctx.pid, ids);
        const kept = new Set(); // ảnh bị bỏ qua (người khác đang mở) vẫn ở lại lưới
        if (r.skipped) for (const t of tiles) if (picked.has(t.img.id) && t.img.locked_by && t.img.locked_by !== getLabeler()) kept.add(t.img.id);
        forget(ids.filter(id => !kept.has(id)));
        toast(`Đã xoá ${r.deleted} ảnh${r.skipped ? `, bỏ qua ${r.skipped} ảnh đang có người mở` : ''}`, r.skipped ? 'warn' : 'ok');
        ctx.refreshProject();
      } catch (err) { toast(err.message, 'err'); }
      b.disabled = false;
    });

    $('[data-del-all]', page).addEventListener('click', async () => {
      const scope = assignee === '' ? 'chưa giao cho ai'
        : assignee === '*' ? 'trong mục Chưa gán nhãn, kể cả ảnh đã giao cho người gán'
          : `đã giao cho ${esc(assignee)} mà họ chưa làm`;
      const r = await openDialog(`
        <h3>Xoá ${total} ảnh</h3>
        <p>Xoá toàn bộ <b>${total} ảnh ${scope}</b>${clsF ? ' khớp bộ lọc đang chọn' : ''}, kể cả những ảnh chưa cuộn tới. File ảnh trên đĩa bị xoá theo, không hoàn tác được.</p>
        <p class="muted small">Ảnh đã gán nhãn, đang chờ duyệt hay đã duyệt không bị ảnh hưởng. Ảnh đang có người khác mở được giữ lại.</p>
        <label class="field">Gõ <b>${total}</b> để xác nhận <input type="text" name="confirm" required autocomplete="off" inputmode="numeric"></label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
          <button class="danger" type="submit">Xoá ${total} ảnh</button></div>`,
      async form => {
        if (form.confirm.value.trim() !== String(total)) throw new Error(`Gõ đúng ${total} để xác nhận`);
        // Đang lọc theo lớp: chỉ xoá đúng các ảnh khớp bộ lọc, không phải cả danh sách.
        if (clsF) return api.deleteImages(ctx.pid, (await api.refs(ctx.pid, queue, apiAssignee, filterParams(clsF))).map(r => r.id));
        return api.deleteAllUnlabeled(ctx.pid, apiAssignee);
      });
      if (!r) return;
      toast(`Đã xoá ${r.deleted} ảnh${r.skipped ? `, bỏ qua ${r.skipped} ảnh đang có người mở` : ''}`, r.skipped ? 'warn' : 'ok', 6000);
      ctx.refreshProject();
      ctx.reload();
    });
  }

  $('[data-start]', page).addEventListener('click', () => {
    // Đang lọc: mở từ ảnh đầu của bộ lọc (server tự phát ảnh thì không biết bộ lọc).
    if (firstId) location.hash = labelUrl(claims && !clsF ? 'next' : firstId);
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
        const href = listUrl(value, clsF);
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
