// Cần review (quản trị viên): ảnh đã nộp, chia tab theo từng người (giống "Chưa gán nhãn").
// Trong mỗi tab: chọn một số ảnh (hoặc tất cả) để duyệt nhanh, hoặc mở review lần lượt.

import { api } from '../api.js';
import { classFilter, filterQuery, imageTile, matchesFilter, readClassFilter, setBusy } from '../tiles.js';
import { $, esc, h, openDialog, session, toast } from '../ui.js';

export async function mount(el, ctx) {
  const { project } = ctx;

  // Lấy hết ảnh chờ duyệt (theo trang 500), rồi nhóm theo người được giao.
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const res = await api.images(ctx.pid, { queue: 'review', limit: 500, offset });
    all.push(...res.items);
    if (all.length >= res.total || !res.items.length) break;
  }
  // Lọc theo lớp / số đối tượng trước khi chia tab, để số trên tab khớp bộ lọc.
  const clsF = readClassFilter(ctx.query);
  const shown = clsF ? all.filter(img => matchesFilter(img, clsF)) : all;
  const byUser = new Map();
  for (const img of shown) {
    const who = img.assigned_to || img.labeled_by || '';
    if (!byUser.has(who)) byUser.set(who, []);
    byUser.get(who).push(img);
  }
  // Tab: ảnh của chính mình ("Của bạn") luôn đứng đầu và được mở mặc định; sau đó là người
  // nhiều ảnh chờ nhất. '*' = tất cả.
  const me = session.user.username;
  const people = [...byUser.entries()].sort((a, b) =>
    (b[0] === me) - (a[0] === me) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const nameOf = who => (who === me ? 'Của bạn' : esc(who || 'Không rõ'));
  const wanted = ctx.query.assignee;
  const tab = wanted === '*' || byUser.has(wanted) ? wanted : (people[0]?.[0] ?? '*');
  const imgs = tab === '*' ? shown : byUser.get(tab) || [];
  const tabHref = (v, f = clsF) => `#/p/${ctx.pid}/review?assignee=${encodeURIComponent(v)}${filterQuery(f)}`;
  const q = `queue=review&assignee=${encodeURIComponent(tab)}${filterQuery(clsF)}`;

  const page = h(`
    <div class="page list-page">
      <div class="listbar">
        <h2 title="Ảnh đã nộp, chờ duyệt. Chỉ ảnh được duyệt mới vào dataset. Mở một ảnh để sửa, duyệt hoặc trả lại kèm ghi chú.">Cần review</h2>
        <span data-cls-filter></span>
        ${people.length ? `<div class="chips" role="tablist" aria-label="Người gán">
          ${people.map(([who, list]) => `<a role="tab" href="${tabHref(who)}" aria-selected="${who === tab}">${nameOf(who)}<span>${list.length}</span></a>`).join('')}
          <a role="tab" href="${tabHref('*')}" aria-selected="${tab === '*'}">Tất cả<span>${shown.length}</span></a>
        </div>
        <span class="spacer"></span>
        <label class="check" title="Bấm ô vuông ở góc ảnh để chọn từng ảnh. Giữ Shift / Ctrl và bấm ảnh để chọn nhanh, Shift để chọn cả dải.">
          <input type="checkbox" data-select-all> Chọn tất cả</label>
        <span class="muted picked" data-picked></span>
        <button class="sm danger" data-del hidden title="Xoá hẳn các ảnh đang chọn khỏi project (mất cả nhãn)">Xoá</button>
        <button class="sm danger" data-del-all title="Xoá hẳn mọi ảnh của tab đang xem khỏi project (mất cả nhãn)">Xoá tất cả</button>
        <button class="sm danger" data-reject disabled>Trả lại</button>
        <button class="sm" data-approve disabled>Duyệt</button>
        <a class="btn sm primary" href="#/p/${ctx.pid}/label/${imgs[0]?.id}?${q}">Review lần lượt</a>` : '<span class="muted">0 ảnh</span>'}
      </div>
      <div class="notice live-notice" data-stale hidden>Có ảnh vừa được nộp hoặc thay đổi.
        <button class="sm" data-reload>Tải lại</button></div>
      <div class="grid"></div>
    </div>`);

  const grid = $('.grid', page);
  const sel = classFilter(project, clsF, f => { location.hash = tabHref(tab, f); });
  if (sel) $('[data-cls-filter]', page).replaceWith(sel);
  if (!shown.length && clsF) {
    grid.innerHTML = `<p class="empty">Không có ảnh chờ duyệt nào khớp bộ lọc (${all.length} ảnh chờ duyệt tất cả). Chọn <b>Mọi lớp</b> để xem hết.</p>`;
    el.replaceChildren(page);
    return { onLive(event, data, mine) { if (!mine && !['lock', 'unlock'].includes(data.kind)) ctx.reload(); } };
  }
  if (!all.length) {
    grid.innerHTML = `<p class="empty">Không có ảnh nào chờ duyệt. Ảnh mới nộp sẽ tự hiện ở đây. Xem tiến độ từng người ở mục <a href="#/p/${ctx.pid}/assign">Phân công</a>.</p>`;
    el.replaceChildren(page);
    // Trang trống vẫn nghe sự kiện: có người nộp ảnh là tự hiện ra.
    return { onLive(event, data, mine) { if (!mine && !['lock', 'unlock'].includes(data.kind)) ctx.reload(); } };
  }

  const picked = new Set();
  const boxes = [];
  const btn = $('[data-approve]', page);
  const rejectBtn = $('[data-reject]', page);
  const selectAll = $('[data-select-all]', page);
  let anchor = -1; // ảnh bấm gần nhất — mốc cho Shift + bấm chọn cả dải

  const sync = () => {
    boxes.forEach(({ box, tile, id }) => { box.checked = picked.has(id); tile.classList.toggle('picked', picked.has(id)); });
    grid.classList.toggle('selecting', picked.size > 0);
    btn.disabled = !picked.size;
    btn.textContent = picked.size ? `Duyệt ${picked.size} ảnh` : 'Duyệt';
    rejectBtn.disabled = !picked.size;
    rejectBtn.textContent = picked.size ? `Trả lại ${picked.size} ảnh` : 'Trả lại';
    const del = $('[data-del]', page);
    del.hidden = !picked.size;
    del.textContent = `Xoá ${picked.size} ảnh`;
    delete del.dataset.armed;
    $('[data-picked]', page).textContent = picked.size ? `Đã chọn ${picked.size} / ${imgs.length}` : `${imgs.length} ảnh`;
    selectAll.checked = picked.size === imgs.length;
    selectAll.indeterminate = picked.size > 0 && picked.size < imgs.length;
  };

  /** Bấm một ảnh: bật/tắt ảnh đó; có Shift thì chọn cả dải từ ảnh bấm trước tới ảnh này. */
  const toggle = (i, shift) => {
    if (shift && anchor >= 0) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      for (let k = a; k <= b; k++) picked.add(imgs[k].id);
    } else if (picked.has(imgs[i].id)) picked.delete(imgs[i].id);
    else picked.add(imgs[i].id);
    anchor = i;
    sync();
  };

  imgs.forEach((img, i) => {
    const tile = imageTile(img, project, { href: `#/p/${ctx.pid}/label/${img.id}?${q}`, assignee: tab === '*' });
    tile.dataset.idx = i;
    // Ô vuông ở góc: trang tự xử lý cả ô (không để trình duyệt tự đổi checkbox), nên bấm vào
    // đâu trên ô cũng được và luôn biết có giữ Shift hay không.
    const pick = h(`<span class="pick" role="checkbox" tabindex="-1" title="Chọn ảnh này"><input type="checkbox" tabindex="-1" aria-label="Chọn ${esc(img.filename)}"></span>`);
    const box = pick.querySelector('input');
    pick.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggle(i, e.shiftKey); });
    tile.appendChild(pick);
    boxes.push({ box, tile, id: img.id });
    grid.appendChild(tile);
  });

  // Bấm vào ảnh: giữ Shift / Ctrl, hoặc đang có ảnh được chọn -> chọn / bỏ chọn thay vì mở ảnh.
  // Chạy ở pha capture để chặn trước khi ô ảnh tự mở trình gán nhãn.
  grid.addEventListener('click', e => {
    const tile = e.target.closest('.tile');
    if (!tile || e.target.closest('.pick')) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || picked.size) {
      e.preventDefault();
      e.stopPropagation();
      toggle(+tile.dataset.idx, e.shiftKey);
    }
  }, true);
  // Giữ Shift khi bấm không bôi đen chữ trên trang.
  grid.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); });

  selectAll.addEventListener('change', () => {
    picked.clear();
    if (selectAll.checked) imgs.forEach(img => picked.add(img.id));
    anchor = -1;
    sync();
  });

  rejectBtn.addEventListener('click', () => {
    if (!picked.size) return;
    const owners = [...new Set(imgs.filter(i => picked.has(i.id)).map(i => i.assigned_to || i.labeled_by).filter(Boolean))];
    const to = owners.length === 1 ? (owners[0] === me ? 'bạn' : esc(owners[0])) : `${owners.length} người gán`;
    openDialog(`
        <h3>Trả lại ${picked.size} ảnh cho ${to}</h3>
        <p class="muted">Các ảnh quay về mục "Việc của tôi" của người đã gán, cùng ghi chú này. Mỗi người nhận một thông báo.</p>
        <label class="field">Cần sửa gì <textarea name="note" required maxlength="1000" rows="3"
          placeholder="Ví dụ: khung chưa sát, thiếu một đối tượng phía sau"></textarea></label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
          <button class="danger" type="submit">Trả lại ${picked.size} ảnh</button></div>`,
      async form => {
        const r = await api.rejectMany(ctx.pid, [...picked], form.note.value.trim());
        toast(`Đã trả lại ${r.rejected} ảnh${r.skipped ? `, bỏ qua ${r.skipped} ảnh không trả được` : ''}`, r.skipped ? 'warn' : 'ok');
        return true;
      }).then(async ok => {
      if (!ok) return;
      await ctx.refreshProject();
      await mount(el, { ...ctx, query: { ...ctx.query, assignee: tab } });
    });
  });

  /** Xoá hẳn ảnh (kèm nhãn, lịch sử, file) rồi dựng lại trang. Ảnh người khác đang mở được giữ lại. */
  async function remove(ids) {
    const r = await api.deleteImages(ctx.pid, ids);
    toast(`Đã xoá ${r.deleted} ảnh${r.skipped ? `, bỏ qua ${r.skipped} ảnh đang có người mở` : ''}`, r.skipped ? 'warn' : 'ok');
    await ctx.refreshProject();
    await mount(el, { ...ctx, query: { ...ctx.query, assignee: tab } });
  }

  $('[data-del]', page).addEventListener('click', async e => {
    const b = e.currentTarget;
    if (!picked.size) return;
    if (!b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = `Bấm lần nữa để xoá ${picked.size} ảnh`;
      setTimeout(() => { if (b.dataset.armed) sync(); }, 3000);
      return;
    }
    b.disabled = true;
    try { await remove([...picked]); } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  });

  $('[data-del-all]', page).addEventListener('click', () => {
    const scope = tab === '*' ? 'đang chờ duyệt' : `chờ duyệt ${tab === me ? 'của bạn' : `của ${esc(tab || 'người gán')}`}`;
    openDialog(`
        <h3>Xoá ${imgs.length} ảnh</h3>
        <p>Xoá hẳn <b>${imgs.length} ảnh ${scope}</b> khỏi project, mất luôn nhãn đã gán và lịch sử. File ảnh trên đĩa bị xoá
          theo, không hoàn tác được.</p>
        <p class="muted small">Muốn người gán làm lại thì dùng <b>Trả lại</b> thay vì xoá. Ảnh đang có người khác mở được giữ lại.</p>
        <label class="field">Gõ <b>${imgs.length}</b> để xác nhận <input type="text" name="confirm" required autocomplete="off" inputmode="numeric"></label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
          <button class="danger" type="submit">Xoá ${imgs.length} ảnh</button></div>`,
      async form => {
        if (form.confirm.value.trim() !== String(imgs.length)) throw new Error(`Gõ đúng ${imgs.length} để xác nhận`);
        return true;
      }).then(async ok => {
      if (!ok) return;
      try { await remove(imgs.map(i => i.id)); } catch (err) { toast(err.message, 'err'); }
    });
  });

  btn.addEventListener('click', async () => {
    if (!picked.size) return;
    btn.disabled = true;
    try {
      const r = await api.approve(ctx.pid, [...picked]);
      toast(`Đã duyệt ${r.approved} ảnh${tab === me ? ' của bạn' : tab !== '*' ? ` của ${tab || 'người gán'}` : ''}`);
      await ctx.refreshProject();
      // Dựng lại trang để số trên các tab cập nhật; vẫn ở tab đang xem nếu người đó còn ảnh.
      await mount(el, { ...ctx, query: { ...ctx.query, assignee: tab } });
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  });

  sync();
  el.replaceChildren(page);
  $('[data-reload]', page)?.addEventListener('click', () => ctx.reload());
  return {
    flash: flashLast,
    onLive(event, data, mine) {
      if (data.kind === 'lock' || data.kind === 'unlock') return setBusy(el, data.image_id, data.locked_by);
      if (mine) return;
      if (picked.size) $('[data-stale]', page).hidden = false;
      else ctx.reload();
    },
  };
}

/** Nháy viền ảnh vừa xem trong trình gán nhãn (khi quay lại danh sách). */
export function flashLast(root) {
  let id = null;
  try { id = sessionStorage.getItem('last-image'); sessionStorage.removeItem('last-image'); } catch { }
  const tile = id && root.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (!tile) return;
  tile.classList.add('flash');
  setTimeout(() => tile.classList.remove('flash'), 1600);
}
