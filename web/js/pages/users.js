// Quản lý thành viên (chỉ quản trị viên): thêm, đổi vai trò, khoá/mở, đặt lại mật khẩu, xoá.

import { api } from '../api.js';
import { $, esc, fmtDate, h, openDialog, plate, session, toast } from '../ui.js';

const ROLES = { admin: 'Quản trị viên', labeler: 'Người gán nhãn' };

export async function mount(el) {
  const page = h(`
    <div class="home">
      <header class="home-top">
        <a href="#/" class="plate-link" title="Về trang project">${plate('VisionLabel')}</a>
        <span class="spacer"></span>
        <a class="btn ghost sm" href="#/">‹ Project</a>
      </header>
      <div class="page-head"><h2>Thành viên</h2>
        <p>Quản trị viên tạo project, tải ảnh, xuất dataset và quản lý thành viên. Người gán nhãn chỉ gán nhãn và tải dataset.</p></div>
      <form class="panel" data-add autocomplete="off">
        <h3>Thêm thành viên</h3>
        <div class="user-form">
          <label class="field">Tên đăng nhập <input type="text" name="username" required pattern="[a-z0-9._\\-]{2,64}" placeholder="an.nguyen"
            autocapitalize="none" spellcheck="false"></label>
          <label class="field">Mật khẩu <input type="text" name="password" required minlength="8" maxlength="128" placeholder="Ít nhất 8 ký tự"></label>
          <label class="field">Vai trò <select name="role">
            <option value="labeler">${ROLES.labeler}</option><option value="admin">${ROLES.admin}</option></select></label>
          <button class="primary" type="submit">Thêm</button>
        </div>
        <p class="muted" style="font-size:13.5px">Gửi tên đăng nhập và mật khẩu cho người đó. Họ có thể tự đổi mật khẩu sau khi đăng nhập.</p>
      </form>
      <div class="panel" style="padding:0;overflow-x:auto">
        <table class="users"><thead><tr>
          <th>Tên đăng nhập</th><th>Vai trò</th><th>Trạng thái</th><th>Đăng nhập gần nhất</th><th></th>
        </tr></thead><tbody></tbody></table>
      </div>
    </div>`);

  const tbody = $('tbody', page);

  async function load() {
    const users = await api.users();
    tbody.replaceChildren(...users.map(row));
  }

  function row(u) {
    const self = u.username === session.user?.username;
    const tr = h(`<table><tbody><tr class="${u.active ? '' : 'off'}">
      <td><b>${esc(u.username)}</b>${self ? ' <span class="muted">(bạn)</span>' : ''}</td>
      <td><select data-role ${self ? 'disabled title="Không tự đổi vai trò của mình"' : ''}>
        ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td>${u.active ? '<span class="tag labeled">Đang hoạt động</span>' : '<span class="tag">Đã khoá</span>'}</td>
      <td class="muted">${u.last_login_at ? fmtDate(u.last_login_at) : 'Chưa đăng nhập'}</td>
      <td class="actions">
        <button class="sm ghost" data-reset>Đặt lại mật khẩu</button>
        ${self ? '' : `<button class="sm ghost" data-toggle>${u.active ? 'Khoá' : 'Mở khoá'}</button>
        <button class="sm danger" data-del>Xoá</button>`}
      </td></tr></tbody></table>`).querySelector('tr');

    const update = async (body, msg) => {
      try { await api.updateUser(u.id, body); toast(msg); await load(); }
      catch (err) { toast(err.message, 'err'); await load(); }
    };
    $('[data-role]', tr).addEventListener('change', e => update({ role: e.target.value }, `Đã đổi vai trò của ${u.username}`));
    $('[data-toggle]', tr)?.addEventListener('click', () =>
      update({ active: !u.active }, u.active ? `Đã khoá ${u.username}. Mọi phiên của họ bị đăng xuất.` : `Đã mở khoá ${u.username}`));
    $('[data-reset]', tr).addEventListener('click', () => openDialog(`
        <h3>Đặt lại mật khẩu cho ${esc(u.username)}</h3>
        <p class="muted">Mọi phiên đang đăng nhập của tài khoản này sẽ bị đăng xuất.</p>
        <label class="field">Mật khẩu mới <input type="text" name="password" required minlength="8" maxlength="128"></label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
          <button class="primary" type="submit">Đặt lại</button></div>`,
      async form => { await api.updateUser(u.id, { password: form.password.value }); toast(`Đã đặt lại mật khẩu cho ${u.username}`); }));
    const del = $('[data-del]', tr);
    del?.addEventListener('click', async () => {
      if (!del.dataset.armed) {
        del.dataset.armed = '1'; del.textContent = 'Bấm lần nữa để xoá';
        setTimeout(() => { delete del.dataset.armed; del.textContent = 'Xoá'; }, 3000);
        return;
      }
      try { await api.deleteUser(u.id); toast(`Đã xoá ${u.username}`); await load(); }
      catch (err) { toast(err.message, 'err'); }
    });
    return tr;
  }

  const form = $('[data-add]', page);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const u = await api.createUser({
        username: form.username.value.trim().toLowerCase(),
        password: form.password.value,
        role: form.role.value,
      });
      toast(`Đã thêm ${u.username}`);
      form.reset();
      await load();
    } catch (err) { toast(err.message, 'err'); }
  });

  el.replaceChildren(page);
  await load();
  return {};
}
