// Server GPU (chỉ quản trị viên): thêm máy Ubuntu có GPU, kiểm tra kết nối SSH, cài môi trường,
// giải phóng GPU, và xem mọi việc đang chạy (cài đặt, train). Model và lớp cho từng project cấu hình
// ở mục Model AI của project (pages/models.js).

import { api } from '../api.js';
import { jobList } from '../gpu-jobs.js';
import { $, esc, fmtDate, h, openDialog, plate, toast } from '../ui.js';

const GPU_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
  <rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1" fill="#f2c230" stroke="#f2c230"/>
  <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>`;

function serverForm(s = null) {
  const v = k => esc(s?.[k] ?? '');
  return `
    <h3>${s ? `Sửa server ${esc(s.name)}` : 'Thêm server GPU'}</h3>
    <div class="form-row two">
      <label class="field">Tên <input type="text" name="name" required maxlength="100" value="${v('name')}" placeholder="VD: RTX 4090 phòng lab"></label>
      <label class="field">Ghi chú <input type="text" name="note" maxlength="1000" value="${v('note')}"></label>
    </div>
    <div class="form-row ssh-row">
      <label class="field">IP / tên máy <input type="text" name="host" required maxlength="255" value="${v('host')}" placeholder="192.168.1.50" spellcheck="false"></label>
      <label class="field">Cổng SSH <input type="number" name="port" min="1" max="65535" value="${s?.port ?? 22}"></label>
      <label class="field">Tài khoản <input type="text" name="username" required maxlength="64" value="${v('username')}" placeholder="ubuntu" spellcheck="false" autocomplete="off"></label>
    </div>
    <label class="field">Mật khẩu SSH
      <span class="hint">${s?.has_password ? 'Đã lưu. Để trống để giữ nguyên.' : 'Hoặc dán khoá riêng ở dưới. Bỏ trống cả hai = dùng khoá SSH sẵn có của máy chạy app (~/.ssh).'}</span>
      <input type="password" name="password" maxlength="300" autocomplete="new-password" ${s?.has_password ? 'placeholder="••••••••"' : ''}></label>
    ${s?.has_password ? '<label class="check small"><input type="checkbox" name="clear_password"> Xoá mật khẩu đã lưu</label>' : ''}
    <label class="field">Khoá riêng SSH
      <span class="hint">${s?.has_key ? 'Đã lưu. Để trống để giữ nguyên.' : 'Nội dung file <code>~/.ssh/id_ed25519</code> (không đặt passphrase), public key tương ứng nằm trong <code>~/.ssh/authorized_keys</code> của server.'}</span>
      <textarea name="private_key" rows="3" spellcheck="false" class="mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>
    ${s?.has_key ? '<label class="check small"><input type="checkbox" name="clear_key"> Xoá khoá đã lưu</label>' : ''}
    <div class="form-row two">
      <label class="field">Thư mục làm việc trên server
        <span class="hint">Chứa agent, môi trường Python, dataset gửi lên và kết quả train.</span>
        <input type="text" name="workdir" required maxlength="255" value="${s ? v('workdir') : '~/visionlabel'}" spellcheck="false"></label>
      <label class="field">Python
        <span class="hint">Bấm "Cài môi trường" xong sẽ tự đổi sang python trong venv.</span>
        <input type="text" name="python" required maxlength="255" value="${s ? v('python') : 'python3'}" spellcheck="false"></label>
    </div>
    <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
      <button class="primary" type="submit">${s ? 'Lưu' : 'Thêm server'}</button></div>`;
}

function formBody(form, editing) {
  const body = {
    name: form.name.value.trim(), host: form.host.value.trim(), port: +form.port.value || 22,
    username: form.username.value.trim(), workdir: form.workdir.value.trim(), python: form.python.value.trim(),
    note: form.note.value.trim(),
  };
  if (form.password.value) body.password = form.password.value;
  if (form.private_key.value.trim()) body.private_key = form.private_key.value;
  if (editing) {
    body.clear_password = !!form.clear_password?.checked;
    body.clear_key = !!form.clear_key?.checked;
  }
  return body;
}

function gpuRows(s) {
  if (!s.gpus.length) return '';
  return `<div class="gpus">${s.gpus.map(g => {
    const pct = g.mem_total ? Math.round((g.mem_used / g.mem_total) * 100) : 0;
    return `<div class="gpu"><b>${esc(g.name)}</b>
      <span class="muted small">${(g.mem_used / 1024).toFixed(1)} / ${(g.mem_total / 1024).toFixed(1)} GB · dùng ${g.util}%</span>
      <div class="bar"><div style="width:${pct}%"></div></div></div>`;
  }).join('')}</div>`;
}

function card(s) {
  const status = !s.checked_at ? '<span class="tag unlabeled">Chưa kiểm tra</span>'
    : s.check_ok ? '<span class="tag labeled">Kết nối được</span>' : '<span class="tag rejected">Không kết nối được</span>';
  return h(`
    <section class="panel server" data-id="${s.id}">
      <div class="row">
        <span class="gpu-icon ${s.check_ok ? '' : 'off'}">${GPU_ICON}</span>
        <div class="who-drive"><b>${esc(s.name)}</b>
          <span class="muted"><code>${esc(s.username)}@${esc(s.host)}${s.port !== 22 ? `:${s.port}` : ''}</code>
            · ${s.has_key ? 'khoá SSH' : s.has_password ? 'mật khẩu' : 'khoá của máy chạy app'}
            ${s.checked_at ? ` · kiểm tra lúc ${fmtDate(s.checked_at)}` : ''}</span></div>
        <span class="spacer"></span>
        ${status}
        ${s.agent_running ? '<span class="tag busy" title="Model đang nằm trong bộ nhớ GPU, tự gán nhãn chạy ngay">Đang giữ model</span>' : ''}
      </div>
      ${s.check_error ? `<pre class="job-error">${esc(s.check_error)}</pre>` : ''}
      ${gpuRows(s)}
      ${s.os_info || s.python_info ? `<p class="small muted">${esc(s.os_info)}${s.python_info ? `<br>${esc(s.python_info)}` : ''}</p>` : ''}
      <p class="small muted">Thư mục <code>${esc(s.workdir)}</code> · Python <code>${esc(s.python)}</code>${s.note ? ` · ${esc(s.note)}` : ''}</p>
      <div class="row">
        <button class="sm" data-act="test">Kiểm tra kết nối</button>
        <button class="sm" data-act="setup" title="Tạo venv, cài ultralytics (và LocateAnything-3B nếu chọn). Chạy nền.">Cài môi trường</button>
        ${s.agent_running ? '<button class="sm" data-act="release" title="Tắt agent, model rời khỏi GPU. Lần tự gán nhãn sau sẽ nạp lại.">Giải phóng GPU</button>' : ''}
        <span class="spacer"></span>
        <button class="sm ghost" data-act="edit">Sửa</button>
        <button class="sm danger" data-act="del">Xoá</button>
      </div>
    </section>`);
}

export async function mount(el) {
  const page = h(`
    <div class="home drive-page">
      <header class="home-top">
        <a href="#/" class="plate-link" title="Về trang project">${plate('VisionLabel')}</a>
        <span class="spacer"></span>
        <a class="btn ghost sm" href="#/">‹ Project</a>
      </header>
      <div class="page-head"><h2>Server GPU</h2>
        <p>Máy Ubuntu có GPU NVIDIA để tự gán nhãn (YOLO, LocateAnything-3B) và train model. App kết nối qua SSH,
          không cần mở thêm cổng nào. Chọn server và model cho từng project ở mục <b>Model AI</b> của project.</p></div>
      <details class="panel steps-box">
        <summary><h3>Chuẩn bị server</h3></summary>
        <ol class="steps">
          <li>Server bật SSH: <code>sudo apt install openssh-server</code>.
            <span class="hint">Đây là đường app dùng để vào server nên phải có trước, app không tự cài được. Máy chạy app phải
              SSH tới được server: cùng mạng LAN, hoặc qua VPN / IP public.</span></li>
          <li>Server có driver NVIDIA: lệnh <code>nvidia-smi</code> thấy GPU. Chưa có thì trên Ubuntu chạy
            <code>sudo ubuntu-drivers install</code> rồi <code>sudo reboot</code>.
            <span class="hint">App không tự cài driver: phải khởi động lại máy, và máy bật Secure Boot còn phải xác nhận khoá ngay tại
              màn hình server lúc khởi động.</span></li>
          <li>Bấm <b>Thêm server</b>, nhập IP, tài khoản và mật khẩu (hoặc khoá riêng), rồi <b>Kiểm tra kết nối</b>.</li>
          <li>Bấm <b>Cài môi trường</b>: app tạo <code>venv</code> trong thư mục làm việc (thiếu <code>python3-venv</code> thì tự cài bằng sudo,
            dùng mật khẩu SSH đã lưu), cài <code>ultralytics</code> kèm PyTorch,
            và tuỳ chọn tải sẵn <code>nvidia/LocateAnything-3B</code>. Chạy nền, theo dõi ở mục <b>Việc đang chạy</b> bên dưới.</li>
        </ol>
      </details>
      <div class="row"><h3>Server</h3><span class="spacer"></span><button class="primary" data-add>+ Thêm server</button></div>
      <div class="server-list" data-servers></div>
      <div class="row"><h3>Việc đang chạy và gần đây</h3><span class="spacer"></span><button class="sm ghost" data-refresh>Tải lại</button></div>
      <div class="job-list" data-jobs></div>
    </div>`);

  const listEl = $('[data-servers]', page);
  let servers = [];
  const jobs = jobList($('[data-jobs]', page), { empty: 'Chưa có việc nào. Cài môi trường hoặc train ở mục Model AI của project.' });

  function render() {
    listEl.replaceChildren(...(servers.length ? servers.map(s => {
      const c = card(s);
      c.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => act(e.currentTarget, s)));
      return c;
    }) : [h('<p class="empty">Chưa có server nào. Bấm <b>+ Thêm server</b>.</p>')]));
  }

  async function load() {
    servers = await api.gpuServers();
    render();
  }

  const replace = s => { servers = servers.map(x => (x.id === s.id ? s : x)); render(); };

  async function act(b, s) {
    const a = b.dataset.act;
    if (a === 'edit') {
      const saved = await openDialog(serverForm(s), form => api.updateGpuServer(s.id, formBody(form, true)));
      if (saved) { replace(saved); toast('Đã lưu server'); }
      return;
    }
    if (a === 'setup') {
      const job = await openDialog(`
        <h3>Cài môi trường trên ${esc(s.name)}</h3>
        <p class="muted">Tạo <code>${esc(s.workdir)}/venv</code> (môi trường riêng, không dùng chung gói Python của hệ thống), cài <code>ultralytics</code> kèm PyTorch.
          Lần đầu có thể mất 5–15 phút. Chạy nền: đóng trang này cũng không sao.</p>
        <label class="check"><input type="checkbox" name="locate"> Cài thêm LocateAnything-3B (transformers 4.57.1, tải model khoảng 7 GB)</label>
        <p class="small muted">LocateAnything-3B của NVIDIA chạy trên GPU từ dòng Ampere trở lên (RTX 30xx, A100…); riêng model đã
          khoảng 7 GB nên dùng GPU từ 12 GB VRAM. Giấy phép chỉ cho nghiên cứu, phi thương mại (NVIDIA License).</p>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
          <button class="primary" type="submit">Bắt đầu cài</button></div>`,
      form => api.setupGpuServer(s.id, form.locate.checked));
      if (job) { toast('Đã bắt đầu cài môi trường. Theo dõi ở mục Việc đang chạy.'); jobs.refresh(); }
      return;
    }
    if (a === 'del' && !b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Bấm lần nữa để xoá';
      setTimeout(() => { delete b.dataset.armed; b.textContent = 'Xoá'; }, 3000);
      return;
    }
    const label = b.textContent;
    b.disabled = true;
    if (a === 'test') b.textContent = 'Đang kiểm tra…';
    try {
      if (a === 'test') {
        const r = await api.testGpuServer(s.id);
        replace(r);
        toast(r.check_ok ? `Kết nối được ${r.name}${r.gpus.length ? `: ${r.gpus.map(g => g.name).join(', ')}` : ''}` : 'Không kết nối được', r.check_ok ? 'ok' : 'err');
      } else if (a === 'release') {
        replace({ ...(await api.releaseGpuServer(s.id)), agent_running: false });
        toast('Đã tắt agent, GPU được giải phóng');
      } else if (a === 'del') {
        await api.deleteGpuServer(s.id);
        servers = servers.filter(x => x.id !== s.id);
        render();
        toast(`Đã xoá server ${s.name}`);
      }
    } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = label; }
  }

  $('[data-add]', page).addEventListener('click', async () => {
    const s = await openDialog(serverForm(), form => api.createGpuServer(formBody(form, false)));
    if (!s) return;
    servers = [...servers, s].sort((x, y) => x.name.localeCompare(y.name));
    render();
    toast(`Đã thêm ${s.name}. Đang kiểm tra kết nối…`);
    listEl.querySelector(`[data-id="${s.id}"] [data-act=test]`)?.click();
  });
  $('[data-refresh]', page).addEventListener('click', () => { load(); jobs.refresh(); });

  await load();
  // Chưa có server thì mở sẵn phần hướng dẫn.
  $('.steps-box', page).open = !servers.length;
  el.replaceChildren(page);
  await jobs.refresh();
  return { unmount: () => jobs.stop() };
}
