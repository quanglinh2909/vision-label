// Router theo hash:
//   #/                                trang chọn / tạo project
//   #/users                           quản lý thành viên (quản trị viên)
//   #/drive                           kết nối Google Drive (quản trị viên)
//   #/p/<pid>/<section>               upload | unlabeled | todo | review | rejected | labeled | assign | datasets | classes | settings
//   #/p/<pid>/label/<imageId>?queue=  trình gán nhãn
// Chưa đăng nhập thì mọi đường dẫn đều hiện màn đăng nhập; đăng nhập xong quay lại đúng chỗ.

import { accountBar } from './account.js';
import { api } from './api.js';
import { isOnline, onLive, startLive, stopLive, watchProject } from './live.js';
import { $, esc, h, ICONS, isAdmin, plate, session, TASKS, toast } from './ui.js';
import * as loginPage from './pages/login.js';
import * as usersPage from './pages/users.js';
import * as drivePage from './pages/drive.js';
import * as projectsPage from './pages/projects.js';
import * as uploadPage from './pages/upload.js';
import * as galleryPage from './pages/gallery.js';
import * as reviewPage from './pages/review.js';
import * as assignPage from './pages/assign.js';
import * as datasetsPage from './pages/datasets.js';
import * as classesPage from './pages/classes.js';
import * as settingsPage from './pages/settings.js';
import * as labelerPage from './pages/labeler.js';

// role: 'admin' = chỉ quản trị viên, 'labeler' = chỉ người gán nhãn, bỏ trống = cả hai.
const SECTIONS = {
  upload: { page: uploadPage, label: 'Tải ảnh lên', role: 'admin' },
  unlabeled: { page: galleryPage, label: 'Chưa gán nhãn', role: 'admin', count: p => p.unlabeled_count },
  todo: { page: galleryPage, label: 'Việc của tôi', role: 'labeler', count: p => p.unlabeled_count + p.rejected_count },
  review: { label: 'Cần review', labelerLabel: 'Chờ duyệt', count: p => p.review_count },
  rejected: { page: galleryPage, label: 'Bị trả lại', role: 'admin', count: p => p.rejected_count },
  labeled: { page: galleryPage, label: 'Đã duyệt', count: p => p.labeled_count },
  assign: { page: assignPage, label: 'Phân công', role: 'admin', count: p => p.unassigned_count, countTitle: 'ảnh chưa giao' },
  datasets: { page: datasetsPage, label: 'Dataset', role: 'admin', count: p => p.dataset_count },
  classes: { page: classesPage, label: 'Lớp', role: 'admin', count: p => p.classes.length, countTitle: 'số lớp' },
  settings: { page: settingsPage, label: 'Cài đặt', role: 'admin' },
};
const allowed = s => !s.role || (s.role === 'admin') === isAdmin();
// "Cần review" của quản trị viên nhóm theo người; người gán xem ảnh mình đã nộp dạng lưới.
const pageOf = (key, s) => (key === 'review' ? (isAdmin() ? reviewPage : galleryPage) : s.page);
const homeSection = () => (isAdmin() ? 'unlabeled' : 'todo');

const app = $('#app');
let current = null; // { key, instance }
// Vị trí cuộn của từng danh sách (theo project + mục + bộ lọc) để quay lại đúng chỗ.
const scrollMemory = new Map();
let shell = null; // { pid, el, project }

function parse() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(query)) };
}

export const navigate = hash => { location.hash = hash; };

async function unmountCurrent() {
  if (current?.scrollKey && shell) scrollMemory.set(current.scrollKey, $('.content', shell.el).scrollTop);
  if (current?.instance?.unmount) await current.instance.unmount();
  current = null;
}

function renderNav() {
  const p = shell.project;
  $('nav', shell.el).innerHTML = Object.entries(SECTIONS).filter(([, s]) => allowed(s)).map(([key, s]) => `
    <a href="#/p/${p.id}/${key}" data-key="${key}" title="${!isAdmin() && s.labelerLabel ? s.labelerLabel : s.label}">
      ${ICONS[key]}<span class="lbl">${!isAdmin() && s.labelerLabel ? s.labelerLabel : s.label}</span>
      ${s.count ? `<span class="count" ${s.countTitle ? `title="${s.countTitle}"` : ''}>${s.count(p)}</span>` : ''}
    </a>`).join('');
  $('.name', shell.el).innerHTML = plate(p.name);
  $('.name', shell.el).title = p.name;
  $('.task', shell.el).innerHTML = `<span class="tag ${p.task}-task">${esc(TASKS[p.task].label)}</span>`;
  const pct = p.image_count ? Math.round((p.labeled_count / p.image_count) * 100) : 0;
  const foot = $('.foot', shell.el);
  foot.innerHTML = `
    <div class="row"><span class="muted">${isAdmin() ? 'Đã duyệt' : 'Ảnh của bạn đã duyệt'}</span><span class="spacer"></span><b>${p.labeled_count} / ${p.image_count}</b></div>
    <div class="bar"><div style="width:${pct}%"></div></div>
    <div class="live-status" data-live></div>`;
  renderLive(isOnline());
  foot.appendChild(accountBar({ compact: true }));
}

function highlight(key) {
  for (const a of shell.el.querySelectorAll('nav a')) a.classList.toggle('on', a.dataset.key === key);
}

// Thu gọn menu trái thành cột icon để lưới ảnh rộng hơn (nhớ cho lần sau).
const menuCollapsed = () => { try { return localStorage.getItem('menu-collapsed') === '1'; } catch { return false; } };

async function ensureShell(pid) {
  // Cùng project: chỉ tải lại số đếm (người khác có thể vừa nộp / duyệt / giao ảnh).
  if (shell?.pid === pid) { await refreshProject(); return; }
  const project = await api.project(pid);
  const el = h(`
    <div class="shell ${menuCollapsed() ? 'collapsed' : ''}">
      <aside class="side">
        <div class="head">
          <button class="sm ghost collapse-btn" data-collapse title="Thu gọn / mở rộng menu" aria-label="Thu gọn menu">«</button>
          <a href="#/" class="back">‹ Tất cả project</a>
          <div class="name" style="max-width:100%"></div>
          <div class="task"></div>
        </div>
        <nav></nav>
        <div class="foot"></div>
      </aside>
      <main class="content"></main>
    </div>`);
  app.replaceChildren(el);
  $('[data-collapse]', el).addEventListener('click', () => {
    const on = !el.classList.contains('collapsed');
    el.classList.toggle('collapsed', on);
    $('[data-collapse]', el).textContent = on ? '»' : '«';
    try { localStorage.setItem('menu-collapsed', on ? '1' : '0'); } catch { }
  });
  if (menuCollapsed()) $('[data-collapse]', el).textContent = '»';
  shell = { pid, el, project };
  watchProject(pid);
  renderNav();
}

/** Tải lại số đếm ở menu trái (gọi sau khi upload / lưu nhãn / tạo dataset). */
async function refreshProject() {
  if (!shell) return null;
  shell.project = await api.project(shell.pid);
  const on = shell.el.querySelector('nav a.on')?.dataset.key;
  renderNav();
  if (on) highlight(on);
  return shell.project;
}

// Mỗi lần điều hướng có một số thứ tự. Trang dựng xong mà người dùng đã đi tiếp (VD bấm quay
// lại khi ảnh còn đang tải) thì huỷ ngay, không để nó chạy ngầm (giữ chỗ, phím tắt...).
let navSeq = 0;
let reloadTimer = null;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => route(), 600);
}
async function mountFresh(seq, mounting) {
  const instance = await mounting;
  if (seq !== navSeq) { await instance?.unmount?.(); return null; }
  return instance;
}

async function route() {
  if (!session.user) return;
  const seq = ++navSeq;
  const { parts, query } = parse();
  try {
    if (parts[0] === 'drive') {
      await unmountCurrent();
      shell = null;
      if (!isAdmin()) return navigate('#/');
      const instance = await mountFresh(seq, drivePage.mount(app, { query }));
      if (instance) current = { key: 'drive', instance };
      return;
    }
    if (parts[0] === 'users') {
      await unmountCurrent();
      shell = null;
      if (!isAdmin()) return navigate('#/');
      const instance = await mountFresh(seq, usersPage.mount(app));
      if (instance) current = { key: 'users', instance };
      return;
    }
    if (parts[0] !== 'p' || !parts[1]) {
      await unmountCurrent();
      shell = null;
      const instance = await mountFresh(seq, projectsPage.mount(app));
      if (instance) current = { key: 'home', instance };
      return;
    }
    const pid = parts[1];
    const section = parts[2] || homeSection();

    // Đang ở trình gán nhãn của cùng project -> chỉ đổi ảnh, không dựng lại trang.
    if (section === 'label' && current?.key === `label:${pid}:${query.queue}` && current.instance.update) {
      await current.instance.update(parts[3]);
      return;
    }
    await unmountCurrent();
    await ensureShell(pid);
    const ctx = { pid, project: shell.project, query, refreshProject, navigate, reload: reloadSoon };
    const content = $('.content', shell.el);
    content.replaceChildren();
    content.scrollTop = 0;

    if (section === 'label') {
      highlight(SECTIONS[query.queue] ? query.queue : homeSection());
      const instance = await mountFresh(seq, labelerPage.mount(content, { ...ctx, imageId: parts[3] }));
      if (instance) current = { key: `label:${pid}:${query.queue}`, instance };
      return;
    }
    const s = SECTIONS[section];
    if (!s || !allowed(s)) return navigate(`#/p/${pid}/${homeSection()}`);
    highlight(section);
    const key = `${section}?${new URLSearchParams(query)}`;
    const scrollKey = `${pid}/${key}`;
    const instance = await mountFresh(seq, pageOf(section, s).mount(content, { ...ctx, section }));
    if (!instance) return;
    current = { key, scrollKey, instance };
    const y = scrollMemory.get(scrollKey);
    if (y) {
      await instance.ensureHeight?.(y + content.clientHeight);
      content.scrollTop = y;
    }
    instance.flash?.(content);
  } catch (e) {
    if (e.status === 401) return; // màn đăng nhập đã được hiện qua sự kiện auth-required
    toast(e.message, 'err');
    if (parts[0] === 'p') { shell = null; navigate('#/'); }
  }
}

async function showLogin(setup = false) {
  stopLive();
  await unmountCurrent().catch(() => { });
  shell = null;
  session.user = null;
  current = {
    key: 'login',
    instance: await loginPage.mount(app, {
      setup,
      onDone: user => { session.user = user; current = null; startLive(); route(); },
    }),
  };
}

// Hết phiên / bị khoá / đăng xuất -> về màn đăng nhập, giữ nguyên đường dẫn để quay lại.
window.addEventListener('auth-required', () => { if (current?.key !== 'login') showLogin(); });

// ---------- realtime ----------
function renderLive(online) {
  const el = shell && $('[data-live]', shell.el);
  if (!el) return;
  el.className = `live-status ${online ? 'on' : 'off'}`;
  el.textContent = online ? 'Đang cập nhật trực tiếp' : 'Mất kết nối, đang nối lại…';
  el.title = online ? 'Thay đổi của người khác hiện ra ngay' : 'Dữ liệu có thể chưa mới nhất';
}

// Thông báo riêng cho người được giao ảnh (kể cả khi đang ở project khác).
function notifyMe(d) {
  const by = d.by || 'Quản trị viên';
  if (d.kind === 'assigned') toast(`Bạn vừa được giao ${d.count} ảnh trong project "${d.project_name}"`, 'ok', 6000);
  else if (d.kind === 'rejected') {
    toast(d.count > 1 ? `${by} trả lại ${d.count} ảnh của bạn: ${d.note}` : `Ảnh ${d.filename || 'của bạn'} bị ${by} trả lại: ${d.note}`, 'warn', 9000);
  }
  else if (d.kind === 'approved') toast(`${by} vừa duyệt ${d.count || 1} ảnh của bạn`, 'ok', 5000);
  else if (d.kind === 'revoked') toast(`${by} đã thu hồi ${d.count} ảnh ${d.scope === 'rejected' ? 'bị trả lại' : 'chưa làm'} của bạn`, 'warn', 6000);
}

// Nhiều sự kiện dồn dập (VD duyệt 100 ảnh) -> gom lại, cập nhật một lần.
let refreshTimer = null;
const refreshSoon = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshProject().catch(() => { }), 400);
};

onLive((event, data) => {
  if (event === 'live.status') return renderLive(data.online);
  if (event === 'me.changed') notifyMe(data);
  if (shell && data.project_id === shell.pid) {
    refreshSoon();
    current?.instance?.onLive?.(event, data, data.by === session.user?.username);
  } else if (current?.key === 'home' && event === 'me.changed') {
    route(); // được giao ảnh ở project mới -> danh sách project đổi
  }
});
window.addEventListener('hashchange', route);

(async function boot() {
  try {
    const st = await api.authStatus();
    if (st.needs_setup) return showLogin(true);
    if (!st.user) return showLogin();
    session.user = st.user;
    startLive();
    route();
  } catch (e) {
    app.replaceChildren(h(`<p class="empty">Không kết nối được server: ${esc(e.message)}</p>`));
  }
})();
