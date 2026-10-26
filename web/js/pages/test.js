// Kiểm tra model (chỉ quản trị viên): chạy model trên server GPU với ảnh, video hoặc camera RTSP.
//   Ảnh: server trả các đối tượng tìm được, trang tự vẽ lên ảnh (YOLO hoặc LocateAnything).
//   Video / RTSP: server chạy YOLO trên từng khung, vẽ sẵn kết quả, gửi về dạng MJPEG cho thẻ <img>.
//   RTSP do server GPU đọc, nên server GPU phải kết nối được tới camera.

import { api } from '../api.js';
import { $, esc, h, PALETTE, toast } from '../ui.js';

const BASE_MODELS = ['yolo26n.pt', 'yolo26s.pt', 'yolo26m.pt', 'yolo26n-pose.pt', 'yolo26n-seg.pt'];
const colorOf = label => PALETTE[[...String(label)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const newSession = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, '');

/** Vẽ các đối tượng (toạ độ 0..1) lên canvas cùng cỡ ảnh. */
function drawDets(canvas, img, dets) {
  const W = img.naturalWidth, H = img.naturalHeight, c = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;
  c.drawImage(img, 0, 0);
  const lw = Math.max(2, Math.round(Math.max(W, H) / 400));
  c.font = `600 ${Math.max(12, lw * 7)}px system-ui, sans-serif`;
  for (const d of dets) {
    const col = colorOf(d.label);
    c.strokeStyle = col; c.lineWidth = lw;
    if (d.poly?.length) {
      c.fillStyle = `${col}40`;
      c.beginPath();
      d.poly.forEach(([x, y], i) => (i ? c.lineTo(x * W, y * H) : c.moveTo(x * W, y * H)));
      c.closePath(); c.fill(); c.stroke();
    }
    const [x1, y1, x2, y2] = d.box;
    c.strokeRect(x1 * W, y1 * H, (x2 - x1) * W, (y2 - y1) * H);
    (d.kpts || []).forEach(([x, y, v], k) => {
      if (v < 0.5 || (!x && !y)) return;
      c.fillStyle = PALETTE[k % PALETTE.length];
      c.beginPath(); c.arc(x * W, y * H, lw * 2.2, 0, Math.PI * 2); c.fill();
    });
    const text = `${d.label} ${d.conf < 1 ? d.conf.toFixed(2) : ''}`.trim();
    const tw = c.measureText(text).width, th = lw * 9;
    c.fillStyle = col;
    c.fillRect(x1 * W, Math.max(0, y1 * H - th), tw + lw * 3, th);
    c.fillStyle = '#000';
    c.fillText(text, x1 * W + lw * 1.5, Math.max(th, y1 * H) - lw * 2);
  }
}

export async function mount(el, ctx) {
  const { project } = ctx;
  const [servers, saved, jobs, cfg] = await Promise.all([
    api.gpuServers(), api.models(ctx.pid).catch(() => []), api.gpuJobs(ctx.pid).catch(() => []),
    project.task === 'detect' ? api.autolabelConfig(ctx.pid).catch(() => null) : null,
  ]);
  const trained = jobs.filter(j => j.kind === 'train' && j.status === 'done' && j.weights && j.params.task !== 'classify');
  const yoloSaved = saved.filter(m => m.task !== 'classify');
  let session = null; // phiên stream đang chạy
  let statsTimer = null;

  const page = h(`
    <div class="page test-page" style="max-width:1300px">
      <div class="page-head"><h2>Kiểm tra model</h2>
        <p>Chạy model trên <a href="#/gpu">server GPU</a> với ảnh, video hoặc camera RTSP để xem model nhận ra gì.</p></div>
      ${servers.length ? '' : '<p class="notice">Chưa có server GPU nào. Vào <a href="#/gpu">Server GPU</a> để thêm trước.</p>'}
      <section class="panel">
        <div class="form-row test-row">
          <label class="field">Server GPU <select name="server">${servers.map(s => `<option value="${s.id}" ${s.id === cfg?.server_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
          <label class="field">Model <select name="model">
            ${cfg?.server_id ? `<optgroup label="Đang dùng để tự gán nhãn"><option value="cfg">${esc(cfg.engine === 'locate' ? 'LocateAnything-3B' : (cfg.model || 'yolo26n.pt').split('/').pop())}</option></optgroup>` : ''}
            ${yoloSaved.length ? `<optgroup label="Model đã lưu">${yoloSaved.map(m => `<option value="saved:${m.id}">${m.starred ? '★ ' : ''}${esc(m.name)}</option>`).join('')}</optgroup>` : ''}
            ${trained.length ? `<optgroup label="Các lần train">${trained.map(j => `<option value="job:${j.id}">${esc(j.title)} (${esc(j.server_name)})</option>`).join('')}</optgroup>` : ''}
            <optgroup label="Model gốc (COCO, tự tải lần đầu)">${BASE_MODELS.map(m => `<option value="base:${m}">${m}</option>`).join('')}</optgroup>
            <optgroup label="Khác"><option value="locate">LocateAnything-3B (tìm theo mô tả, chỉ ảnh)</option><option value="custom">Nhập đường dẫn .pt trên server…</option></optgroup>
          </select></label>
          <label class="field">Ngưỡng tin cậy <input type="number" name="conf" min="0" max="1" step="0.05" value="${cfg?.conf ?? 0.25}"></label>
          <label class="field">Kích thước ảnh <input type="number" name="imgsz" min="32" max="4096" step="32" value="${cfg?.imgsz ?? 640}"></label>
        </div>
        <label class="field" data-custom hidden>Đường dẫn trọng số trên server <input type="text" name="custom" class="mono" spellcheck="false" placeholder="/home/ubuntu/visionlabel/jobs/…/best.pt"></label>
        <label class="field" data-prompts hidden>Mô tả cần tìm <span class="hint">Tiếng Anh, ngăn bằng dấu phẩy. VD: license plate, person, motorbike</span>
          <input type="text" name="prompts" value="${esc(project.classes.map(c => c.label || c.name).join(', '))}"></label>
      </section>

      <div class="tabs" role="tablist">
        <button class="sm" type="button" role="tab" aria-selected="true" data-tab="image">Ảnh</button>
        <button class="sm" type="button" role="tab" aria-selected="false" data-tab="video">Video</button>
        <button class="sm" type="button" role="tab" aria-selected="false" data-tab="rtsp">Camera RTSP</button>
      </div>

      <section class="panel" data-pane="image">
        <label class="drop test-drop" data-drop>
          <input type="file" accept="image/*" multiple hidden data-files>
          <b>Kéo thả ảnh vào đây, hoặc bấm để chọn</b>
          <span class="muted small">Chọn nhiều ảnh cùng lúc được. Ảnh không được lưu vào project.</span>
        </label>
        <div class="test-results" data-results></div>
      </section>

      <section class="panel" data-pane="video" hidden>
        <div class="row">
          <input type="file" accept="video/*" data-video>
          <span class="spacer"></span>
          <label class="row muted small" title="Tốc độ thật: phát đúng nhịp của video. Nhanh nhất: model chạy hết tốc lực, dùng để đo hiệu năng.">Tốc độ phát
            <select data-speed style="width:auto">
              <option value="0.5">0.5× (chậm)</option>
              <option value="1" selected>Tốc độ thật (1×)</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
              <option value="0">Nhanh nhất</option>
            </select></label>
          <button class="primary" data-run-video disabled>Chạy</button>
        </div>
        <div class="row" style="flex-wrap:nowrap">
          <input type="text" class="mono" data-video-url placeholder="Hoặc dán link video: https://…/video.mp4" spellcheck="false" style="flex:1">
          <button class="primary" data-run-url>Chạy link</button>
        </div>
        <p class="muted small">Với link, server GPU tự tải video về (server phải truy cập được link đó). Video được gửi / tải lên server GPU rồi chạy YOLO từng khung hình (LocateAnything quá chậm cho video).
          Video được giữ trên server để chạy lại; gửi lại đúng file đó (hoặc dán lại link đó) thì dùng bản đã có, không gửi lần nữa.</p>
        <div class="video-lib">
          <div class="row"><b>Video có sẵn trên server</b><span class="muted small" data-vlib-total></span>
            <span class="spacer"></span><button class="sm ghost" type="button" data-vlib-reload>Tải lại</button></div>
          <div class="vlib" data-vlib><p class="muted small">Đang tải danh sách…</p></div>
        </div>
      </section>

      <section class="panel" data-pane="rtsp" hidden>
        <div class="row" style="flex-wrap:nowrap">
          <input type="text" class="mono" data-rtsp placeholder="rtsp://user:pass@192.168.1.10:554/stream1" spellcheck="false" style="flex:1">
          <button class="primary" data-run-rtsp>Chạy</button>
        </div>
        <p class="muted small"><b>Server GPU</b> là máy đọc camera, nên phải kết nối được tới địa chỉ này (cùng mạng camera).
          Ảnh trả về đã thu nhỏ còn tối đa 1280 px để nhẹ đường truyền.</p>
      </section>

      <section class="panel stream-box" data-stream hidden>
        <div class="row">
          <b data-stream-title></b><span class="muted small" data-stream-stats></span>
          <span class="spacer"></span><button class="sm danger" data-stop>Dừng</button>
        </div>
        <div class="stream-view"><img alt="Kết quả model" data-stream-img></div>
        <pre class="job-error" data-stream-error hidden></pre>
        <div class="shots">
          <div class="row">
            <b>Khung đã ghi lại</b>
            <div class="tabs" role="tablist" aria-label="Lọc khung">
              <button class="sm" type="button" role="tab" data-f="miss" aria-selected="false">Không nhận dạng được <span class="muted" data-n="miss">0</span></button>
              <button class="sm" type="button" role="tab" data-f="hit" aria-selected="false">Nhận dạng được <span class="muted" data-n="hit">0</span></button>
              <button class="sm" type="button" role="tab" data-f="all" aria-selected="true">Cả hai</button>
            </div>
            <span class="spacer"></span>
            <label class="check small"><input type="checkbox" data-shot-all> Chọn tất cả</label>
            <button class="sm primary" data-import disabled title="Thêm ảnh gốc (chưa vẽ kết quả) của các khung đã chọn vào mục Chưa gán nhãn">Đưa vào gán nhãn</button>
          </div>
          <p class="muted small">Ghi lại tối đa 1 khung mỗi giây có nhận dạng, 1 khung mỗi 5 giây không nhận dạng được (giây của video,
            hoặc thời gian thực với camera). Bấm vào khung để chọn. Đưa vào gán nhãn là ảnh gốc, không có khung vẽ.</p>
          <div class="shot-grid" data-shot-grid></div>
        </div>
      </section>

      <div class="viewer" data-viewer hidden role="dialog" aria-modal="true" aria-label="Xem khung">
        <div class="vbar">
          <b data-vcap></b><span class="muted small" data-vpos></span>
          <span class="spacer"></span>
          <button class="sm" data-vraw title="Phím R">Ảnh gốc</button>
          <button class="sm" data-vpick title="Phím Space">Chọn</button>
          <button class="sm ghost" data-vclose title="Esc" aria-label="Đóng">✕</button>
        </div>
        <div class="vstage">
          <button class="vnav" data-vprev title="Phím ←" aria-label="Ảnh trước">‹</button>
          <img data-vimg alt="">
          <button class="vnav" data-vnext title="Phím →" aria-label="Ảnh sau">›</button>
        </div>
      </div>
    </div>`);

  const form = {
    server: $('[name=server]', page), model: $('[name=model]', page), conf: $('[name=conf]', page),
    imgsz: $('[name=imgsz]', page), custom: $('[name=custom]', page), prompts: $('[name=prompts]', page),
  };
  const syncModelFields = () => {
    $('[data-custom]', page).hidden = form.model.value !== 'custom';
    const locate = form.model.value === 'locate' || (form.model.value === 'cfg' && cfg?.engine === 'locate');
    $('[data-prompts]', page).hidden = !locate;
  };
  form.model.addEventListener('change', syncModelFields);
  syncModelFields();

  // ---------- chọn model -> {engine, model} trên server đang chọn ----------
  const deployed = new Map(); // "<model đã lưu>@<server>" -> đường dẫn trên server
  async function resolveModel() {
    const v = form.model.value, server = form.server.value;
    if (!server) throw new Error('Chưa chọn server GPU');
    if (v === 'cfg') return { engine: cfg.engine, model: cfg.model };
    if (v === 'locate') return { engine: 'locate', model: '' };
    if (v === 'custom') {
      if (!form.custom.value.trim()) throw new Error('Nhập đường dẫn trọng số trên server');
      return { engine: 'yolo', model: form.custom.value.trim() };
    }
    const [kind, id] = [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)];
    if (kind === 'base') return { engine: 'yolo', model: id };
    if (kind === 'job') {
      const j = trained.find(x => x.id === id);
      if (j.server_id !== server) throw new Error(`Trọng số của lần train này nằm trên server "${j.server_name}". Chọn server đó, hoặc lưu model rồi chọn ở nhóm Model đã lưu.`);
      return { engine: 'yolo', model: j.weights };
    }
    const key = `${id}@${server}`;
    if (!deployed.has(key)) deployed.set(key, (await api.deployModel(id, server)).path); // model đã lưu: đưa lên server
    return { engine: 'yolo', model: deployed.get(key) };
  }

  // ---------- tab ----------
  page.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    page.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    page.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  }));

  // ---------- ảnh ----------
  const results = $('[data-results]', page);
  async function runImages(files) {
    const list = [...files].filter(f => f.type.startsWith('image/'));
    if (!list.length) return;
    let m;
    try { m = await resolveModel(); } catch (err) { return toast(err.message, 'err'); }
    for (const file of list) {
      const url = URL.createObjectURL(file);
      const card = h(`<div class="test-card"><canvas></canvas><div class="test-meta"><b>${esc(file.name)}</b> <span class="muted small" data-st>Đang chạy…</span><div class="test-dets" data-dets></div></div></div>`);
      results.prepend(card);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
        const fd = new FormData();
        fd.append('file', file, file.name);
        fd.append('server_id', form.server.value);
        fd.append('engine', m.engine);
        fd.append('model', m.model || '');
        fd.append('conf', form.conf.value || '0.25');
        fd.append('imgsz', form.imgsz.value || '640');
        fd.append('prompts', form.prompts.value);
        const r = await api.testImage(fd);
        drawDets($('canvas', card), img, r.dets);
        const counts = {};
        r.dets.forEach(d => { counts[d.label] = (counts[d.label] || 0) + 1; });
        $('[data-st]', card).textContent = `${r.dets.length} đối tượng · ${r.seconds.toFixed(2)} giây · ${r.model.split('/').pop()}`;
        $('[data-dets]', card).innerHTML = Object.entries(counts).map(([k, n]) => `<span class="chip-det" style="border-color:${colorOf(k)}"><b>${n}</b> ${esc(k)}</span>`).join('')
          || '<span class="muted small">Không tìm thấy gì. Thử hạ ngưỡng tin cậy.</span>';
      } catch (err) {
        drawDets($('canvas', card), img, []);
        $('[data-st]', card).textContent = '';
        $('[data-dets]', card).innerHTML = `<span class="auth-error">${esc(err.message)}</span>`;
      } finally { URL.revokeObjectURL(url); }
    }
  }
  const drop = $('[data-drop]', page), fileInput = $('[data-files]', page);
  fileInput.addEventListener('change', () => { runImages(fileInput.files); fileInput.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); runImages(e.dataTransfer.files); });

  // ---------- video / RTSP: stream MJPEG ----------
  const box = $('[data-stream]', page), view = $('[data-stream-img]', page), statsEl = $('[data-stream-stats]', page);
  const errEl = $('[data-stream-error]', page);

  // ---------- khung đã ghi lại (có / không nhận dạng được) -> đưa vào gán nhãn ----------
  const grid = $('[data-shot-grid]', page), importBtn = $('[data-import]', page), shotAll = $('[data-shot-all]', page);
  let shotSession = null, shotName = '', shots = [], lastShot = 0, shotFilter = 'all';
  const picked = new Set();
  const visible = () => shots.filter(s => shotFilter === 'all' || (shotFilter === 'hit') === s.hit);

  function renderShots() {
    $('[data-n=hit]', page).textContent = shots.filter(s => s.hit).length;
    $('[data-n=miss]', page).textContent = shots.filter(s => !s.hit).length;
    const list = visible();
    grid.innerHTML = list.length ? list.map(s => `
      <div class="shot ${picked.has(s.id) ? 'picked' : ''} ${s.hit ? 'hit' : 'miss'}" data-id="${s.id}" title="Khung ${s.frame}">
        <img loading="lazy" src="${api.testShotUrl(shotSession, s.id)}" alt="">
        <span class="pick"><input type="checkbox" tabindex="-1" ${picked.has(s.id) ? 'checked' : ''}></span>
        <span class="cap">${s.t.toFixed(1)} s · ${s.hit ? esc(Object.entries(s.counts).map(([k, n]) => `${n} ${k}`).join(', ')) : 'không nhận dạng được'}
          ${s.imported ? '<span class="tag labeled">đã đưa vào</span>' : ''}</span>
      </div>`).join('') : '<p class="muted small">Chưa có khung nào.</p>';
    const ids = list.map(s => s.id);
    shotAll.checked = ids.length > 0 && ids.every(id => picked.has(id));
    importBtn.disabled = !picked.size;
    importBtn.textContent = picked.size ? `Đưa ${picked.size} khung vào gán nhãn` : 'Đưa vào gán nhãn';
  }

  async function loadShots() {
    if (!shotSession) return;
    const mine = shotSession;
    const r = await api.testShots(mine, lastShot).catch(() => null);
    if (!r || mine !== shotSession) return;
    const kept = new Set(r.ids), done = new Set(r.imported);
    shots = shots.filter(s => kept.has(s.id)).concat(r.items); // khung cũ bị server bỏ khi quá nhiều thì bỏ theo
    shots.forEach(s => { s.imported = done.has(s.id); });
    [...picked].forEach(id => { if (!kept.has(id)) picked.delete(id); });
    if (r.items.length) lastShot = r.items[r.items.length - 1].id;
    if (r.items.length || r.imported.length) renderShots();
  }

  page.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => {
    shotFilter = b.dataset.f;
    page.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    renderShots();
  }));
  // Bấm ô vuông ở góc = chọn để đưa vào gán nhãn; bấm vào ảnh = xem lớn.
  grid.addEventListener('click', e => {
    const el = e.target.closest('.shot');
    if (!el) return;
    const id = +el.dataset.id;
    if (e.target.closest('.pick')) {
      picked.has(id) ? picked.delete(id) : picked.add(id);
      renderShots();
    } else openViewer(id);
  });

  // ---------- xem lớn: ‹ › / ← → sang khung khác (theo bộ lọc đang xem), R = ảnh gốc, Space = chọn, Esc = đóng ----------
  const viewer = $('[data-viewer]', page), vimg = $('[data-vimg]', page);
  let vId = null, vRaw = false;
  const vUrl = (id, raw = vRaw) => api.testShotUrl(shotSession, id, raw ? 'raw' : 'full');

  function showViewer() {
    const list = visible(), i = list.findIndex(s => s.id === vId);
    if (i < 0) return closeViewer();
    const s = list[i];
    vimg.src = vUrl(s.id);
    $('[data-vcap]', page).textContent = `${s.t.toFixed(1)} s · khung ${s.frame} · ${s.hit ? Object.entries(s.counts).map(([k, n]) => `${n} ${k}`).join(', ') : 'không nhận dạng được'}`;
    $('[data-vpos]', page).textContent = `${i + 1} / ${list.length}${s.imported ? ' · đã đưa vào gán nhãn' : ''}`;
    $('[data-vraw]', page).textContent = vRaw ? 'Ảnh có kết quả' : 'Ảnh gốc';
    const pickBtn = $('[data-vpick]', page);
    pickBtn.textContent = picked.has(s.id) ? '✓ Đã chọn' : 'Chọn';
    pickBtn.classList.toggle('primary', picked.has(s.id));
    $('[data-vprev]', page).disabled = i === 0;
    $('[data-vnext]', page).disabled = i === list.length - 1;
    [list[i - 1], list[i + 1]].forEach(n => { if (n) new Image().src = vUrl(n.id); }); // tải trước ảnh kề
  }
  function openViewer(id) { vId = id; viewer.hidden = false; showViewer(); }
  function closeViewer() { viewer.hidden = true; vimg.removeAttribute('src'); vId = null; }
  function step(d) {
    const list = visible(), i = list.findIndex(s => s.id === vId);
    if (list[i + d]) { vId = list[i + d].id; showViewer(); }
  }
  function togglePick() {
    picked.has(vId) ? picked.delete(vId) : picked.add(vId);
    renderShots();
    showViewer();
  }
  $('[data-vprev]', page).addEventListener('click', () => step(-1));
  $('[data-vnext]', page).addEventListener('click', () => step(1));
  $('[data-vclose]', page).addEventListener('click', closeViewer);
  $('[data-vraw]', page).addEventListener('click', () => { vRaw = !vRaw; showViewer(); });
  $('[data-vpick]', page).addEventListener('click', togglePick);
  viewer.addEventListener('click', e => { if (e.target === viewer || e.target.classList.contains('vstage')) closeViewer(); });
  const onKey = e => {
    if (viewer.hidden) return;
    const k = e.key;
    if (k === 'ArrowLeft') step(-1);
    else if (k === 'ArrowRight') step(1);
    else if (k === 'Escape') closeViewer();
    else if (k === ' ') togglePick();
    else if (k.toLowerCase() === 'r') { vRaw = !vRaw; showViewer(); }
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  shotAll.addEventListener('change', () => {
    visible().forEach(s => (shotAll.checked ? picked.add(s.id) : picked.delete(s.id)));
    renderShots();
  });
  importBtn.addEventListener('click', async () => {
    if (!picked.size) return;
    importBtn.disabled = true;
    try {
      const r = await api.testImport({ session: shotSession, project_id: ctx.pid, ids: [...picked], name: shotName });
      toast(`Đã thêm ${r.added} ảnh vào Chưa gán nhãn${r.skipped.length ? `, bỏ qua ${r.skipped.length} ảnh đã có` : ''}`, 'ok', 5000);
      picked.clear();
      await ctx.refreshProject();
      await loadShots();
      renderShots();
    } catch (err) { toast(err.message, 'err'); importBtn.disabled = false; }
  });

  async function stopStream() {
    clearInterval(statsTimer);
    if (session) { api.testStop(session).catch(() => { }); session = null; }
    view.removeAttribute('src'); // đóng kết nối MJPEG
  }

  let lastVideo = null; // video đã gửi lên server: đổi tốc độ thì phát lại không cần gửi lại
  async function startStream(source, title, speed = null) {
    await stopStream();
    let m;
    try { m = await resolveModel(); } catch (err) { return toast(err.message, 'err'); }
    if (m.engine === 'locate') return toast('Video / RTSP chỉ chạy được YOLO. Chọn model YOLO.', 'warn');
    session = newSession();
    const mine = session;
    shotSession = session; shotName = /:\/\//.test(source) ? '' : title; shots = []; lastShot = 0; picked.clear(); renderShots();
    box.hidden = false; errEl.hidden = true;
    $('[data-stream-title]', page).textContent = title;
    statsEl.textContent = 'Đang khởi động (nạp model, kết nối nguồn)…';
    view.src = api.testStreamUrl({ session, server_id: form.server.value, source, model: m.model, conf: form.conf.value, imgsz: form.imgsz.value, speed: speed ?? undefined });
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    statsTimer = setInterval(async () => {
      if (session !== mine) return;
      const st = await api.testStats(mine).catch(() => null);
      if (!st || session !== mine) return;
      loadShots();
      if (st.meta) {
        const counts = Object.entries(st.meta.counts).map(([k, n]) => `${n} ${k}`).join(', ');
        const infer = st.meta.infer_ms ? ` · model ${st.meta.infer_ms} ms/khung (≈${Math.round(1000 / st.meta.infer_ms)} FPS tối đa)` : '';
        statsEl.textContent = `${st.meta.fps} FPS · ${st.meta.t !== undefined ? `${st.meta.t.toFixed(1)} s · ` : ''}khung ${st.meta.frame} · ${st.meta.width}×${st.meta.height}${infer}${counts ? ` · ${counts}` : ' · không có đối tượng'}`;
      }
      if (!st.running && (st.error || st.ended || st.meta)) {
        clearInterval(statsTimer);
        setTimeout(loadShots, 300); // lấy nốt các khung cuối
        if (st.error) { errEl.hidden = false; errEl.textContent = st.error; statsEl.textContent = 'Đã dừng do lỗi'; }
        else if (st.ended) statsEl.textContent += ' · hết video';
      }
    }, 1000);
  }

  $('[data-stop]', page).addEventListener('click', async () => { await stopStream(); statsEl.textContent = 'Đã dừng'; });
  view.addEventListener('error', () => { if (session) statsEl.textContent = 'Luồng hình bị ngắt'; });

  const videoInput = $('[data-video]', page), runVideo = $('[data-run-video]', page), speedSel = $('[data-speed]', page);
  const urlInput = $('[data-video-url]', page), runUrl = $('[data-run-url]', page);
  const runLink = async () => {
    const url = urlInput.value.trim();
    if (!/^https?:\/\//i.test(url)) return toast('Dán link bắt đầu bằng http:// hoặc https://', 'warn');
    if (!form.server.value) return toast('Chưa chọn server GPU', 'warn');
    runUrl.disabled = true; runUrl.textContent = 'Server đang tải video…';
    try {
      const r = await api.testVideoUrl(form.server.value, url);
      const title = decodeURIComponent(url.split('?')[0].split('/').pop() || 'video');
      lastVideo = { source: r.source, title };
      loadVideos();
      await startStream(r.source, title, +speedSel.value);
    } catch (err) { toast(err.message, 'err', 9000); }
    runUrl.disabled = false; runUrl.textContent = 'Chạy link';
  };
  runUrl.addEventListener('click', runLink);
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') runLink(); });
  // Đổi tốc độ khi đã có video trên server: phát lại từ đầu với tốc độ mới (không phải gửi lại file).
  speedSel.addEventListener('change', () => { if (lastVideo && !box.hidden) startStream(lastVideo.source, lastVideo.title, +speedSel.value); });
  videoInput.addEventListener('change', () => { runVideo.disabled = !videoInput.files.length; });
  // ---------- video có sẵn trên server (đã gửi / đã tải từ link trước đó) ----------
  let videos = [];
  const vlib = $('[data-vlib]', page);
  const fmtSize = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);
  async function loadVideos() {
    if (!form.server.value) { vlib.innerHTML = ''; return; }
    try { videos = await api.testVideos(form.server.value); } catch (err) { vlib.innerHTML = `<p class="auth-error small">${esc(err.message)}</p>`; return; }
    $('[data-vlib-total]', page).textContent = videos.length ? ` · ${videos.length} video, ${fmtSize(videos.reduce((a, v) => a + v.size, 0))}` : '';
    vlib.innerHTML = videos.length ? videos.map((v, i) => `
      <div class="vlib-row" data-i="${i}">
        <b title="${esc(v.url || v.path)}">${esc(v.name || v.file)}</b>
        <span class="muted small">${fmtSize(v.size)} · ${new Date((v.at || v.mtime) * 1000).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}
          · ${v.source === 'url' ? 'từ link' : v.source === 'upload' ? 'tải lên' : 'chưa rõ nguồn'}${v.by ? ` · ${esc(v.by)}` : ''}</span>
        <span class="spacer"></span>
        <button class="sm primary" data-v="play">Chạy</button>
        <button class="sm ghost" data-v="del">Xoá</button>
      </div>`).join('') : '<p class="muted small">Chưa có video nào trên server.</p>';
  }
  vlib.addEventListener('click', async e => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    const v = videos[+b.closest('[data-i]').dataset.i];
    if (b.dataset.v === 'play') {
      lastVideo = { source: v.path, title: v.name || v.file };
      return startStream(v.path, lastVideo.title, +speedSel.value);
    }
    if (!b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Bấm lần nữa';
      setTimeout(() => { delete b.dataset.armed; b.textContent = 'Xoá'; }, 3000);
      return;
    }
    try {
      if (lastVideo?.source === v.path) { await stopStream(); lastVideo = null; }
      await api.testDeleteVideo(form.server.value, v.path);
      toast(`Đã xoá ${v.name || v.file} trên server`);
      loadVideos();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('[data-vlib-reload]', page).addEventListener('click', loadVideos);
  form.server.addEventListener('change', loadVideos);
  loadVideos();

  runVideo.addEventListener('click', async () => {
    const file = videoInput.files[0];
    if (!file || !form.server.value) return;
    // Đúng file này (cùng tên, cùng dung lượng) đã có trên server: chạy luôn, khỏi gửi lại.
    const have = videos.find(v => v.name === file.name && v.size === file.size);
    if (have) {
      toast('Video này đã có trên server, chạy bản có sẵn (không gửi lại)');
      lastVideo = { source: have.path, title: file.name };
      return startStream(have.path, file.name, +speedSel.value);
    }
    runVideo.disabled = true;
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('server_id', form.server.value);
      const r = await api.testVideo(fd, p => { runVideo.textContent = `Đang gửi ${Math.round(p * 100)}%`; });
      runVideo.textContent = 'Chạy';
      lastVideo = { source: r.source, title: file.name };
      loadVideos();
      await startStream(r.source, file.name, +speedSel.value);
    } catch (err) { toast(err.message, 'err'); runVideo.textContent = 'Chạy'; }
    runVideo.disabled = false;
  });

  $('[data-run-rtsp]', page).addEventListener('click', () => {
    const url = $('[data-rtsp]', page).value.trim();
    if (!/^(rtsps?|https?|rtmp):\/\//i.test(url)) return toast('Nhập link bắt đầu bằng rtsp://', 'warn');
    startStream(url, url.replace(/\/\/[^@/]*@/, '//***@')); // không hiện mật khẩu camera trên màn hình
  });

  el.replaceChildren(page);
  return { unmount() { window.removeEventListener('keydown', onKey); return stopStream(); } };
}
