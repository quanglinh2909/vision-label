// Phân công (quản trị viên): giao N ảnh cho một người, xem tiến độ, thu hồi ảnh chưa làm.

import { api } from '../api.js';
import { $, esc, h, session, toast } from '../ui.js';

export async function mount(el, ctx) {
  const page = h(`
    <div class="page" style="max-width:1100px">
      <div class="page-head">
        <h2>Phân công</h2>
        <p>Server tự chọn ảnh chưa gán và chưa giao cho ai. Ảnh đã giao cho một người thì không giao cho người khác.</p>
      </div>
      <form class="panel assign-panel" autocomplete="off">
        <div class="free-stat" aria-live="polite">
          <span class="num" data-free-num>…</span>
          <span class="label">ảnh chưa gán nhãn<br>chưa giao cho ai</span>
        </div>
        <div class="assign-main">
          <h3>Giao ảnh</h3>
          <div class="assign-form">
            <label class="field">Người gán nhãn <select name="user" required></select></label>
            <label class="field">Số ảnh
              <span class="count-row">
                <input type="number" name="count" min="1" required placeholder="Nhập số ảnh">
                <button class="sm" type="button" data-all title="Điền toàn bộ số ảnh còn lại">Tất cả</button>
              </span></label>
            <button class="primary" type="submit">Giao ảnh</button>
          </div>
          <p class="muted" data-free></p>
        </div>
      </form>
      <div class="panel" style="padding:0;overflow-x:auto">
        <table class="users assign-table"><thead><tr>
          <th>Người gán</th><th>Chưa làm</th><th>Bị trả lại</th><th>Chờ duyệt</th><th>Đã duyệt</th><th>Tiến độ</th><th></th>
        </tr></thead><tbody></tbody></table>
      </div>
    </div>`);

  const form = $('form', page);
  const tbody = $('tbody', page);
  const fmt = n => n.toLocaleString('vi-VN');
  let free = 0;

  // Dòng gợi ý dưới form: còn bao nhiêu sau khi giao số đang nhập.
  function renderHint() {
    const hint = $('[data-free]', page);
    if (!free) {
      hint.textContent = 'Tất cả ảnh chưa gán đều đã được giao. Tải thêm ảnh hoặc thu hồi bớt từ một người.';
      return;
    }
    if (!form.count.value) {
      hint.textContent = `Nhập số ảnh muốn giao, tối đa ${fmt(free)} ảnh. Bấm "Tất cả" để giao hết.`;
      return;
    }
    const n = Math.min(Math.max(+form.count.value || 0, 0), free);
    hint.textContent = +form.count.value > free
      ? `Chỉ còn ${fmt(free)} ảnh, sẽ giao ${fmt(free)} ảnh.`
      : `Sau khi giao còn ${fmt(free - n)} ảnh chưa giao.`;
  }
  form.count.addEventListener('input', renderHint);
  $('[data-all]', page).addEventListener('click', () => { form.count.value = free; renderHint(); });

  async function load() {
    const [stats, users] = await Promise.all([api.assignments(ctx.pid), api.users()]);
    free = stats.unassigned;
    $('[data-free-num]', page).textContent = fmt(free);
    $('.free-stat', page).classList.toggle('zero', !free);
    form.count.max = Math.max(free, 1);
    if (free && +form.count.value > free) form.count.value = free;
    $('[type=submit]', form).disabled = !free;
    $('[data-all]', page).disabled = !free;
    renderHint();

    // Không tự giao cho mình: ảnh chưa giao thì quản trị viên vẫn tự gán được ở "Chưa gán nhãn".
    const keep = form.user.value;
    const people = users.filter(u => u.active && u.username !== session.user.username);
    form.user.innerHTML = people.map(u =>
      `<option value="${esc(u.username)}">${esc(u.username)}${u.role === 'admin' ? ' (quản trị viên)' : ''}</option>`).join('');
    if (keep && people.some(u => u.username === keep)) form.user.value = keep;
    else if (people.some(u => u.role === 'labeler')) form.user.value = people.find(u => u.role === 'labeler').username;
    if (!people.length) {
      $('[data-free]', page).innerHTML = 'Chưa có người gán nhãn nào để giao. Thêm người ở trang <a href="#/users">Thành viên</a>.';
      $('[type=submit]', form).disabled = $('[data-all]', page).disabled = true;
    }

    tbody.replaceChildren(...stats.people.map(row));
    if (!stats.people.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted" style="padding:20px 16px">Chưa giao ảnh cho ai.</td></tr>';
    }
  }

  function row(p) {
    const total = p.unlabeled + p.rejected + p.in_review + p.labeled;
    const pct = total ? Math.round((p.labeled / total) * 100) : 0;
    const tr = h(`<table><tbody><tr>
      <td><b>${esc(p.username)}</b></td>
      <td>${p.unlabeled}</td>
      <td>${p.rejected ? `<a class="tag rejected" href="#/p/${ctx.pid}/rejected?assignee=${encodeURIComponent(p.username)}" title="Xem ảnh bị trả lại của ${esc(p.username)}">${p.rejected}</a>` : 0}</td>
      <td>${p.in_review ? `<a href="#/p/${ctx.pid}/review?assignee=${encodeURIComponent(p.username)}" title="Xem ảnh chờ duyệt của ${esc(p.username)}">${p.in_review}</a>` : 0}</td>
      <td>${p.labeled}</td>
      <td style="min-width:140px"><div class="bar"><div style="width:${pct}%"></div></div>
        <span class="muted" style="font-size:12.5px">${p.labeled} / ${total} ảnh</span></td>
      <td class="actions">
        ${p.unlabeled ? `<button class="sm ghost" data-revoke="unlabeled">Thu hồi ${p.unlabeled} ảnh chưa làm</button>` : ''}
        ${p.rejected ? `<button class="sm ghost" data-revoke="rejected" title="Ảnh về kho chưa giao, giữ nguyên nhãn cũ để người sau sửa tiếp">Thu hồi ${p.rejected} ảnh bị trả lại</button>` : ''}
      </td>
    </tr></tbody></table>`).querySelector('tr');
    tr.querySelectorAll('[data-revoke]').forEach(btn => {
      const scope = btn.dataset.revoke;
      const label = btn.textContent;
      btn.addEventListener('click', async () => {
        if (!btn.dataset.armed) {
          btn.dataset.armed = '1'; btn.textContent = 'Bấm lần nữa để thu hồi';
          setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; }, 3000);
          return;
        }
        try {
          const r = await api.revoke(ctx.pid, p.username, scope);
          toast(`Đã thu hồi ${r.revoked} ảnh ${scope === 'rejected' ? 'bị trả lại' : 'chưa làm'} từ ${p.username}`);
          await load(); ctx.refreshProject();
        } catch (err) { toast(err.message, 'err'); }
      });
    });
    return tr;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      const r = await api.assign(ctx.pid, form.user.value, +form.count.value);
      toast(r.assigned ? `Đã giao ${r.assigned} ảnh cho ${form.user.value}` : 'Không còn ảnh nào để giao', r.assigned ? 'ok' : 'warn');
      form.count.value = ''; // lần giao sau nhập lại số mới, tránh giao nhầm số cũ
      await load(); ctx.refreshProject();
    } catch (err) { toast(err.message, 'err'); }
    btn.disabled = !free; // giao hết rồi thì giữ nút tắt
  });

  el.replaceChildren(page);
  await load();
  let t = null;
  return {
    // Ai đó nộp / được duyệt / bị thu hồi... -> cập nhật bảng tiến độ (không đụng ô đang nhập).
    onLive(event, data) {
      if (data.kind === 'lock' || data.kind === 'unlock') return;
      clearTimeout(t);
      t = setTimeout(() => load().catch(() => { }), 400);
    },
  };
}
