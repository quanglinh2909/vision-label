// Khối tài khoản: tên + vai trò, link Thành viên (quản trị viên), đổi mật khẩu, đăng xuất.

import { api } from './api.js';
import { esc, h, isAdmin, openDialog, session, toast } from './ui.js';

const ROLE = { admin: 'Quản trị viên', labeler: 'Người gán nhãn' };

export function changePassword() {
  return openDialog(`
    <h3>Đổi mật khẩu</h3>
    <p class="muted">Các phiên đăng nhập khác của bạn sẽ bị đăng xuất.</p>
    <label class="field">Mật khẩu hiện tại <input type="password" name="current" required autocomplete="current-password"></label>
    <label class="field">Mật khẩu mới <span class="hint">Ít nhất 8 ký tự.</span>
      <input type="password" name="next" required minlength="8" maxlength="128" autocomplete="new-password"></label>
    <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
      <button class="primary" type="submit">Đổi mật khẩu</button></div>`,
  async form => {
    session.user = await api.changePassword(form.current.value, form.next.value);
    toast('Đã đổi mật khẩu');
  });
}

export async function logout() {
  try { await api.logout(); } catch { /* cookie hết hạn cũng coi như đã đăng xuất */ }
  window.dispatchEvent(new Event('auth-required'));
}

const icon = body => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const MENU_ICONS = {
  users: icon('<circle cx="8" cy="7" r="3"/><path d="M2.5 17c0-3 2.5-5 5.5-5s5.5 2 5.5 5M14 5.5a2.5 2.5 0 010 5M15.5 12.5c1.5.6 2.5 2.2 2.5 4.5"/>'),
  drive: icon('<path d="M7 3h6l5 9h-6z"/><path d="M7 3 2 12l3 5 5-9"/><path d="M5 17h11l2-5"/>'),
  key: icon('<circle cx="7" cy="12" r="3.5"/><path d="M9.5 9.5L17 2M14 5l2 2M12 7l1.5 1.5"/>'),
  out: icon('<path d="M8 3H4v14h4M13 6l4 4-4 4M17 10H8"/>'),
};

/**
 * Một dòng: chữ cái đầu + tên + vai trò; bấm để mở menu (Thành viên, Đổi mật khẩu, Đăng xuất).
 * compact: ở cuối menu trái -> menu bật lên trên, rộng bằng cột.
 */
export function accountBar({ compact = false } = {}) {
  const u = session.user;
  const el = h(`
    <details class="account ${compact ? 'up' : 'down'}">
      <summary title="Tài khoản">
        <span class="avatar" aria-hidden="true">${esc(u.username[0] || '?')}</span>
        <span class="who"><b>${esc(u.username)}</b><span>${ROLE[u.role]}</span></span>
      </summary>
      <div class="menu" role="menu">
        ${isAdmin() ? `<a role="menuitem" href="#/users">${MENU_ICONS.users}Thành viên</a>
        <a role="menuitem" href="#/drive">${MENU_ICONS.drive}Google Drive</a>` : ''}
        <button type="button" role="menuitem" data-pass>${MENU_ICONS.key}Đổi mật khẩu</button>
        <hr>
        <button type="button" role="menuitem" data-out class="out">${MENU_ICONS.out}Đăng xuất</button>
      </div>
    </details>`);
  const close = () => { el.open = false; };
  el.querySelector('[data-pass]').addEventListener('click', () => { close(); changePassword(); });
  el.querySelector('[data-out]').addEventListener('click', () => { close(); logout(); });
  el.querySelectorAll('a[role=menuitem]').forEach(a => a.addEventListener('click', close));
  // Bấm ra ngoài hoặc Esc thì đóng menu.
  const outside = e => { if (el.open && !el.contains(e.target)) close(); };
  const esc_ = e => { if (e.key === 'Escape' && el.open) { close(); el.querySelector('summary').focus(); } };
  el.addEventListener('toggle', () => {
    if (el.open) { document.addEventListener('click', outside, true); document.addEventListener('keydown', esc_); }
    else { document.removeEventListener('click', outside, true); document.removeEventListener('keydown', esc_); }
  });
  return el;
}
