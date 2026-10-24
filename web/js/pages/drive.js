// Kết nối Google Drive (chỉ quản trị viên): nhập OAuth client, cấp quyền, chọn thư mục, bật tự tải lên.
// Sau khi kết nối, mỗi phiên bản dataset có nút "Lên Drive" (xem pages/datasets.js).

import { api } from '../api.js';
import { $, esc, fmtDate, h, plate, toast } from '../ui.js';

const DRIVE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8l6 11h-8z" fill="#f2c230"/><path d="M2 14 8 3l4 7-6 11z" fill="#3fb27f"/><path d="M6 21l3-6h13l-3 6z" fill="#4a8fe7"/></svg>`;

export async function mount(el, ctx) {
  const page = h(`
    <div class="home drive-page">
      <header class="home-top">
        <a href="#/" class="plate-link" title="Về trang project">${plate('VisionLabel')}</a>
        <span class="spacer"></span>
        <a class="btn ghost sm" href="#/">‹ Project</a>
      </header>
      <div class="page-head"><h2>Google Drive</h2>
        <p>Kết nối một tài khoản Google để đẩy bản zip của các phiên bản dataset lên Drive. App chỉ xin quyền
          <code>drive.file</code>: chỉ thấy file và thư mục do chính nó tạo, không đọc được phần còn lại trong Drive của bạn.</p></div>
      <section class="panel drive-status" data-status></section>
      <form class="panel" data-cfg autocomplete="off">
        <h3>OAuth client</h3>
        <ol class="steps">
          <li>Vào <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Cloud Console</a>,
            chọn hoặc tạo một project, bấm <b>Enable</b> cho <b>Google Drive API</b>.</li>
          <li>Mục <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google Auth Platform</a>:
            tạo màn hình đồng ý (loại <b>External</b> nếu dùng Gmail cá nhân), ở <b>Audience</b> thêm email của bạn vào <b>Test users</b>.
            <span class="hint">Ở chế độ <b>Testing</b>, Google hết hạn kết nối sau 7 ngày. Quyền <code>drive.file</code> không thuộc loại nhạy cảm
              nên có thể bấm <b>Publish app</b> (sang Production) mà không cần Google duyệt, kết nối sẽ dùng lâu dài.</span></li>
          <li>Mục <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">Clients</a>: <b>Create client</b>,
            loại <b>Web application</b>, ở <b>Authorized redirect URIs</b> dán địa chỉ dưới đây:
            <div class="row copy-row"><input type="text" readonly data-redirect><button type="button" class="sm" data-copy>Copy</button></div>
            <span class="hint">Phải khớp từng ký tự với địa chỉ bạn đang mở web. Google chỉ nhận <code>http://localhost</code> /
              <code>http://127.0.0.1</code> hoặc HTTPS có tên miền: đang mở bằng IP mạng LAN thì mở lại bằng
              <code>http://localhost:&lt;cổng&gt;</code> trên máy chạy server để kết nối (chỉ cần làm một lần). Chạy sau tên miền / proxy
              HTTPS thì có thể đặt cố định <code>APP_DRIVE__REDIRECT_URI</code> trong .env.</span></li>
          <li>Copy <b>Client ID</b> và <b>Client secret</b> vừa tạo vào đây, bấm <b>Lưu</b>, rồi bấm <b>Kết nối Google Drive</b>.</li>
        </ol>
        <div class="form-row two">
          <label class="field">Client ID <input type="text" name="client_id" spellcheck="false" placeholder="1234-abc.apps.googleusercontent.com"></label>
          <label class="field">Client secret <span class="hint" data-secret-hint></span>
            <input type="password" name="client_secret" spellcheck="false" autocomplete="new-password"></label>
        </div>
        <div class="form-row two">
          <label class="field">Thư mục trên Drive
            <span class="hint">App tạo thư mục này ở gốc Drive, mỗi project một thư mục con bên trong.</span>
            <input type="text" name="folder_name" maxlength="200" required></label>
          <label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" name="auto_upload">
            Tạo dataset xong tự tải lên Drive</label>
        </div>
        <div class="row"><span class="spacer"></span><button class="primary" type="submit">Lưu</button></div>
      </form>
    </div>`);

  const form = $('[data-cfg]', page);
  let cfg = null;

  function render() {
    $('[data-redirect]', page).value = cfg.redirect_uri;
    form.client_id.value = cfg.client_id;
    form.client_secret.value = '';
    form.client_secret.placeholder = cfg.has_secret ? '•••••••• (đã lưu, để trống để giữ nguyên)' : '';
    $('[data-secret-hint]', page).textContent = cfg.has_secret ? 'Đã lưu.' : '';
    form.folder_name.value = cfg.folder_name;
    form.auto_upload.checked = cfg.auto_upload;
    const ready = cfg.client_id && cfg.has_secret;
    $('[data-status]', page).innerHTML = cfg.connected ? `
      <div class="row">
        <span class="drive-icon">${DRIVE_ICON}</span>
        <div class="who-drive"><b>Đã kết nối: ${esc(cfg.account_email || 'tài khoản Google')}</b>
          <span class="muted">bởi ${esc(cfg.connected_by)}${cfg.connected_at ? `, lúc ${fmtDate(cfg.connected_at)}` : ''}.
            Dataset được đưa vào thư mục <b>${esc(cfg.folder_name)}</b>${cfg.folder_link ? ` (<a href="${esc(cfg.folder_link)}" target="_blank" rel="noopener">mở trên Drive</a>)` : ''}.</span></div>
        <span class="spacer"></span>
        <button class="sm" data-connect title="Kết nối lại, hoặc đổi sang tài khoản khác">Kết nối lại</button>
        <button class="sm danger" data-disconnect>Ngắt kết nối</button>
      </div>` : `
      <div class="row">
        <span class="drive-icon off">${DRIVE_ICON}</span>
        <div class="who-drive"><b>Chưa kết nối</b>
          <span class="muted">${ready ? 'Đã có OAuth client. Bấm kết nối rồi đăng nhập tài khoản Google muốn dùng.' : 'Làm theo các bước bên dưới để tạo OAuth client trước.'}</span></div>
        <span class="spacer"></span>
        <button class="primary" data-connect ${ready ? '' : 'disabled'}>Kết nối Google Drive</button>
      </div>`;
    $('[data-connect]', page)?.addEventListener('click', connect);
    $('[data-disconnect]', page)?.addEventListener('click', disconnect);
  }

  async function connect() {
    try { location.href = (await api.driveConnect()).auth_url; } catch (err) { toast(err.message, 'err'); }
  }

  async function disconnect(e) {
    const b = e.currentTarget;
    if (!b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Bấm lần nữa để ngắt';
      setTimeout(() => { delete b.dataset.armed; b.textContent = 'Ngắt kết nối'; }, 3000);
      return;
    }
    try { cfg = await api.driveDisconnect(); render(); toast('Đã ngắt kết nối Google Drive'); }
    catch (err) { toast(err.message, 'err'); }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      client_id: form.client_id.value.trim(),
      folder_name: form.folder_name.value.trim(),
      auto_upload: form.auto_upload.checked,
      ...(form.client_secret.value.trim() ? { client_secret: form.client_secret.value.trim() } : {}),
    };
    const changedClient = cfg.connected && body.client_id !== cfg.client_id;
    try {
      cfg = await api.driveSave(body);
      render();
      toast(changedClient ? 'Đã lưu. Client ID đổi nên cần kết nối lại.' : 'Đã lưu cấu hình Google Drive', changedClient ? 'warn' : 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  $('[data-copy]', page).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cfg.redirect_uri); toast('Đã copy redirect URI'); }
    catch { $('[data-redirect]', page).select(); toast('Trình duyệt chặn copy. Hãy bôi đen để copy.', 'warn'); }
  });

  cfg = await api.drive();
  el.replaceChildren(page);
  render();
  // Google chuyển về đây sau khi cấp quyền: báo kết quả rồi bỏ tham số khỏi địa chỉ.
  if (ctx.query.connected) toast(`Đã kết nối Google Drive: ${cfg.account_email}`, 'ok', 6000);
  if (ctx.query.error) toast(`Không kết nối được: ${ctx.query.error}`, 'err', 9000);
  if (ctx.query.connected || ctx.query.error) history.replaceState(null, '', '#/drive');
  return {};
}
