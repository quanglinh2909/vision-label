// Màn đăng nhập. Khi chưa có tài khoản nào: màn tạo quản trị viên đầu tiên.

import { api } from '../api.js';
import { $, h, plate, toast } from '../ui.js';

export async function mount(el, { setup, onDone }) {
  const page = h(`
    <div class="auth">
      <form class="auth-card" autocomplete="on">
        ${plate('VisionLabel', 'lg')}
        <div>
          <h2>${setup ? 'Tạo tài khoản quản trị' : 'Đăng nhập'}</h2>
          <p class="muted">${setup
            ? 'Chưa có tài khoản nào. Tài khoản đầu tiên là quản trị viên: tạo project, tải ảnh, xuất dataset và thêm thành viên.'
            : 'Dùng tài khoản do quản trị viên cấp.'}</p>
        </div>
        <label class="field">Tên đăng nhập
          ${setup ? '<span class="hint">Chữ thường không dấu, số, dấu chấm hoặc gạch. Ví dụ: linh, an.nguyen</span>' : ''}
          <input type="text" name="username" required maxlength="64" autocomplete="username" autocapitalize="none" spellcheck="false"
            ${setup ? 'pattern="[a-z0-9._\\-]{2,64}"' : ''}></label>
        <label class="field">Mật khẩu ${setup ? '<span class="hint">Ít nhất 8 ký tự.</span>' : ''}
          <input type="password" name="password" required ${setup ? 'minlength="8"' : ''} maxlength="128"
            autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
        ${setup ? `<label class="field">Nhập lại mật khẩu
          <input type="password" name="confirm" required minlength="8" maxlength="128" autocomplete="new-password"></label>` : ''}
        <p class="auth-error" data-error hidden></p>
        <button class="primary" type="submit">${setup ? 'Tạo tài khoản và vào' : 'Đăng nhập'}</button>
      </form>
    </div>`);

  const form = $('form', page);
  const error = $('[data-error]', page);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.hidden = true;
    const username = form.username.value.trim().toLowerCase();
    const password = form.password.value;
    if (setup && password !== form.confirm.value) {
      error.textContent = 'Hai mật khẩu không khớp.';
      error.hidden = false;
      return;
    }
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      const user = setup ? await api.setup(username, password) : await api.login(username, password);
      if (setup) toast(`Đã tạo quản trị viên "${user.username}"`);
      onDone(user);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      btn.disabled = false;
      form.password.select();
    }
  });

  el.replaceChildren(page);
  form.username.focus();
  return {};
}
