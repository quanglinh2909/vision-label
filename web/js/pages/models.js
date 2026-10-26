// Model AI của một project (chỉ quản trị viên):
//   - Tự gán nhãn: chọn server GPU, model (YOLO hoặc LocateAnything-3B), và mỗi lớp của project khớp
//     với tên lớp / mô tả nào của model. Trình gán nhãn có nút "Tự gán nhãn" dùng cấu hình này.
//   - Train: gửi một phiên bản dataset lên server GPU và train; model xong dùng được ngay để tự gán nhãn.

import { api } from '../api.js';
import { jobList, metricsText } from '../gpu-jobs.js';
import { $, clsLabel, esc, fmtDate, h, openDialog, SHAPES, toast } from '../ui.js';
import { FORMATS } from './datasets.js';

const ENGINES = {
  yolo: {
    label: 'YOLO (Ultralytics)',
    desc: 'Nhanh. Model có sẵn (80 lớp COCO: person, car…) hoặc model bạn train ở dưới. Ra được khung, điểm pose, mask.',
  },
  locate: {
    label: 'LocateAnything-3B',
    desc: 'Tìm theo mô tả bằng chữ, không cần train. Chỉ ra khung. Chậm hơn, cần GPU mạnh. Chỉ dùng phi thương mại.',
  },
};
const YOLO_SIZES = ['n', 's', 'm', 'l', 'x'];
const YOLO_SUFFIX = { detect: '', segment: '-seg', pose: '-pose' };
const LOCATE_MODEL = 'nvidia/LocateAnything-3B';

export async function mount(el, ctx) {
  const { project } = ctx;
  const detect = project.task === 'detect';
  const [servers, datasets, cfg] = await Promise.all([
    api.gpuServers(), api.datasets(ctx.pid), detect ? api.autolabelConfig(ctx.pid) : null,
  ]);
  const serverOptions = sel => servers.map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}${s.gpus.length ? ` (${esc(s.gpus[0].name)})` : ''}</option>`).join('');
  let engine = cfg?.engine || 'yolo';

  const page = h(`
    <div class="page models-page" style="max-width:1100px">
      <div class="page-head"><h2>Model AI</h2>
        <p>Tự gán nhãn và train trên <a href="#/gpu">server GPU</a>.</p></div>
      ${servers.length ? '' : '<p class="notice">Chưa có server GPU nào. Vào <a href="#/gpu">Server GPU</a> (menu tài khoản) để thêm trước.</p>'}

      <form class="panel" data-auto autocomplete="off" ${detect ? '' : 'hidden'}>
        <h3>Tự gán nhãn</h3>
        <p class="muted">Trong trình gán nhãn có nút <b>Tự gán nhãn</b>: model chạy trên server GPU, kết quả được thêm vào ảnh
          (chưa lưu) để người gán sửa rồi lưu như bình thường. Chỉ các lớp bật ở bảng dưới được gán.</p>
        <div class="form-row two">
          <label class="field">Server GPU
            <select name="server_id"><option value="">Tắt tự gán nhãn</option>${serverOptions(cfg?.server_id)}</select></label>
          <div class="field" style="align-self:end;gap:8px;padding-bottom:6px">
            <label class="check"><input type="checkbox" name="on_open" ${cfg?.on_open ? 'checked' : ''}>
              Mở ảnh chưa có nhãn là tự chạy luôn</label>
            <label class="check" title="Ảnh trong Cần review đã có nhãn: chỉ thêm đối tượng model tìm ra mà chưa có (trùng gần khít nhãn sẵn có cùng lớp thì bỏ qua). Chưa lưu cho tới khi bấm Duyệt / D.">
              <input type="checkbox" name="on_open_review" ${cfg?.on_open_review ? 'checked' : ''}>
              Mở ảnh trong Cần review là tự chạy, thêm nhãn còn thiếu</label>
          </div>
        </div>
        <div class="field">Model
          <div class="fmt-pick" role="radiogroup" aria-label="Model">
            ${Object.entries(ENGINES).map(([k, e]) => `<button type="button" role="radio" data-engine="${k}" aria-checked="false">
              <b>${e.label}</b><span>${e.desc}</span></button>`).join('')}
          </div>
        </div>
        <div data-engine-fields></div>
        <div class="table-wrap"><table class="plan">
          <thead><tr><th>Lớp của project</th><th>Kiểu vẽ</th><th data-qhead></th></tr></thead>
          <tbody data-classes></tbody>
        </table></div>
        <p class="muted small" data-qhint></p>
        <div class="row">
          <span class="muted small" data-warm></span><span class="spacer"></span>
          <button type="button" class="sm" data-warmup></button>
          <button class="primary" type="submit">Lưu</button>
        </div>
      </form>
      ${detect ? '' : '<p class="notice">Tự gán nhãn hiện chỉ dùng cho project nhận diện đối tượng. Project phân loại vẫn train được ở dưới.</p>'}

      <form class="panel" data-train autocomplete="off">
        <h3>Train model</h3>
        ${datasets.length ? `
        <div class="form-row two">
          <label class="field">Phiên bản dataset
            <select name="dataset_id">${datasets.map(d => `<option value="${d.id}">${esc(d.name)} · ${FORMATS[d.format]?.label || d.format} · ${d.train_count} train / ${d.val_count} val</option>`).join('')}</select></label>
          <label class="field">Server GPU <select name="server_id">${serverOptions(cfg?.server_id)}</select></label>
        </div>
        <div class="form-row train-row">
          <label class="field" data-base>Model gốc <select name="size"></select></label>
          <label class="field">Epoch <input type="number" name="epochs" min="1" max="5000" value="100"></label>
          <label class="field">Kích thước ảnh <input type="number" name="imgsz" min="32" max="4096" step="32" value="640"></label>
          <label class="field">Batch <span class="hint">-1 = tự chọn</span><input type="number" name="batch" min="-1" max="1024" value="16"></label>
          <label class="field">GPU <span class="hint">VD 0 hoặc 0,1</span><input type="text" name="device" maxlength="32" placeholder="tự chọn"></label>
          <label class="field" title="Số tiến trình đọc dữ liệu song song. Nhiều thì nhanh hơn chút nhưng tốn RAM; server ít RAM bị giết giữa chừng (mã 137) thì giảm xuống">Workers
            <span class="hint">ít = đỡ RAM</span><input type="number" name="workers" min="0" max="32" value="2"></label>
        </div>
        <label class="field" data-custom>Hoặc train tiếp từ trọng số trên server
          <span class="hint">Đường dẫn file .pt trên server, VD best.pt của lần train trước. Để trống = dùng model gốc ở trên.</span>
          <input type="text" name="custom" maxlength="500" spellcheck="false" class="mono" list="trained-list"></label>
        <div class="row"><p class="muted small" data-train-hint></p><span class="spacer"></span>
          <button class="primary" type="submit" ${servers.length ? '' : 'disabled'}>Bắt đầu train</button></div>`
        : `<p class="muted">Chưa có phiên bản dataset nào. Tạo ở mục <a href="#/p/${ctx.pid}/datasets">Dataset</a> trước.</p>`}
      </form>
      <datalist id="trained-list">${(cfg?.trained || []).map(t => `<option value="${esc(t.path)}">${esc(t.title)}</option>`).join('')}</datalist>

      <div class="row"><h3>Model đã lưu</h3>
        <span class="muted small">Chép về máy chạy app: còn nguyên kể cả khi xoá lần train hay xoá server GPU.</span></div>
      <div class="job-list" data-models></div>

      <div class="row"><h3>Các lần train</h3></div>
      <div class="job-list" data-jobs></div>
    </div>`);

  // ---------- tự gán nhãn ----------
  const auto = $('[data-auto]', page);
  const queries = {}; // id lớp -> {enabled, query}, giữ khi đổi qua lại YOLO / LocateAnything
  for (const c of project.classes) queries[c.id] = { enabled: true, query: '', ...(cfg?.classes?.[c.id] || {}) };

  function renderEngine() {
    auto.querySelectorAll('[data-engine]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.engine === engine)));
    const yolo = engine === 'yolo';
    const model = cfg && cfg.engine === engine ? cfg.model : '';
    const suggestions = [
      ...(cfg?.trained || []).map(t => [t.path, `Đã train: ${t.title}`]),
      ...Object.values(YOLO_SUFFIX).flatMap(sfx => YOLO_SIZES.map(sz => [`yolo26${sz}${sfx}.pt`, 'Model gốc (COCO)'])),
    ];
    $('[data-engine-fields]', page).innerHTML = yolo ? `
      <div class="form-row auto-row">
        <label class="field">Trọng số
          <span class="hint">Tên model Ultralytics (tự tải lần đầu) hoặc đường dẫn .pt trên server. Trống = yolo26n.pt.</span>
          <input type="text" name="model" maxlength="500" spellcheck="false" class="mono" list="yolo-models" value="${esc(model)}" placeholder="yolo26n.pt">
          <datalist id="yolo-models">${suggestions.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</datalist></label>
        <label class="field">Ngưỡng tin cậy <input type="number" name="conf" min="0" max="1" step="0.05" value="${cfg?.conf ?? 0.25}"></label>
        <label class="field">IoU (NMS) <input type="number" name="iou" min="0" max="1" step="0.05" value="${cfg?.iou ?? 0.5}"></label>
        <label class="field">Kích thước ảnh <input type="number" name="imgsz" min="32" max="4096" step="32" value="${cfg?.imgsz ?? 640}"></label>
      </div>` : `
      <div class="form-row auto-row">
        <label class="field">Model
          <span class="hint">Repo Hugging Face hoặc thư mục model trên server.</span>
          <input type="text" name="model" maxlength="500" spellcheck="false" class="mono" value="${esc(model)}" placeholder="${LOCATE_MODEL}"></label>
        <label class="field">Chế độ
          <select name="mode">${[['hybrid', 'Hybrid (cân bằng)'], ['fast', 'Fast (nhanh nhất)'], ['slow', 'Slow (chắc nhất)']]
            .map(([v, l]) => `<option value="${v}" ${(cfg?.mode || 'hybrid') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">Token tối đa <input type="number" name="max_new_tokens" min="256" max="8192" step="256" value="${cfg?.max_new_tokens ?? 8192}"></label>
      </div>`;
    $('[data-qhead]', page).textContent = yolo ? 'Tên lớp trong model' : 'Mô tả để tìm';
    $('[data-qhint]', page).innerHTML = yolo
      ? 'Trống = trùng tên lớp của project (cột <code>name</code>). Nhiều tên ngăn bằng dấu phẩy cùng về một lớp, VD <code>car, truck, bus</code>. Model train từ dataset của app thì tên đã khớp sẵn.'
      : 'Viết bằng tiếng Anh cho chính xác nhất, VD <code>license plate</code>, <code>person wearing helmet</code>. Trống = tên hiển thị của lớp. Nhiều mô tả ngăn bằng dấu phẩy. LocateAnything chỉ trả khung: lớp đa giác nhận hình chữ nhật, lớp pose bị bỏ qua.';
    renderClasses();
  }

  function renderClasses() {
    const yolo = engine === 'yolo';
    $('[data-classes]', page).innerHTML = project.classes.map(c => {
      const q = queries[c.id];
      const off = !yolo && c.shape === 'pose';
      const fallback = yolo ? c.name : clsLabel(c);
      return `<tr class="${off || !q.enabled ? 'off' : ''}">
        <td><label class="check"><input type="checkbox" data-en="${c.id}" ${q.enabled && !off ? 'checked' : ''} ${off ? 'disabled' : ''}>
          <b>${esc(clsLabel(c))}</b>${c.label && c.label !== c.name ? ` <code>${esc(c.name)}</code>` : ''}</label></td>
        <td class="muted">${SHAPES[c.shape].label}${c.shape === 'pose' ? ` ${c.keypoints.length} điểm` : ''}</td>
        <td>${off ? '<span class="note">LocateAnything không ra điểm pose</span>'
          : `<input type="text" data-q="${c.id}" maxlength="500" value="${esc(q.query)}" placeholder="${esc(fallback)}">`}</td>
      </tr>`;
    }).join('');
    page.querySelectorAll('[data-en]').forEach(cb => cb.addEventListener('change', () => {
      queries[cb.dataset.en].enabled = cb.checked;
      cb.closest('tr').classList.toggle('off', !cb.checked);
    }));
    page.querySelectorAll('[data-q]').forEach(inp => inp.addEventListener('input', () => { queries[inp.dataset.q].query = inp.value; }));
  }

  function autoBody() {
    const f = auto, num = (name, d) => (f[name] ? +f[name].value : d);
    return {
      server_id: f.server_id.value, engine, model: f.model.value.trim(), on_open: f.on_open.checked,
      on_open_review: f.on_open_review.checked,
      conf: num('conf', cfg?.conf ?? 0.25), iou: num('iou', cfg?.iou ?? 0.5), imgsz: num('imgsz', cfg?.imgsz ?? 640),
      mode: f.mode?.value || cfg?.mode || 'hybrid', max_new_tokens: num('max_new_tokens', cfg?.max_new_tokens ?? 8192),
      classes: queries,
    };
  }

  async function saveAuto(quiet = false) {
    Object.assign(cfg, await api.saveAutolabel(ctx.pid, autoBody()));
    renderWarm(); // đổi model / server thì trạng thái "đã nạp" cũng đổi theo
    if (!quiet) toast(cfg.server_id ? 'Đã lưu cấu hình tự gán nhãn' : 'Đã tắt tự gán nhãn');
  }

  /** Nút nạp / bỏ nạp theo trạng thái thật trên server (cfg.loaded do server hỏi agent). */
  function renderWarm() {
    const b = $('[data-warmup]', page);
    b.textContent = cfg.loaded ? 'Bỏ nạp model' : 'Nạp model lên GPU';
    b.classList.toggle('danger', !!cfg.loaded);
    b.title = cfg.loaded
      ? 'Gỡ model khỏi GPU để trả bộ nhớ khi không dùng. Bấm Tự gán nhãn lần sau sẽ tự nạp lại.'
      : 'Nạp model lên GPU trước (lần đầu có thể phải tải model về server), để người gán khỏi chờ';
  }

  if (detect) {
    auto.querySelectorAll('[data-engine]').forEach(b => b.addEventListener('click', () => { engine = b.dataset.engine; renderEngine(); }));
    auto.addEventListener('submit', async e => {
      e.preventDefault();
      try { await saveAuto(); } catch (err) { toast(err.message, 'err'); }
    });
    $('[data-warmup]', page).addEventListener('click', async e => {
      const b = e.currentTarget, warm = $('[data-warm]', page);
      b.disabled = true;
      try {
        if (cfg.loaded) {
          warm.textContent = 'Đang gỡ model…';
          Object.assign(cfg, await api.unloadAutolabel(ctx.pid));
          warm.textContent = 'Đã gỡ model, GPU được trả bộ nhớ.';
        } else {
          warm.textContent = 'Đang nạp model… lần đầu có thể mất vài phút nếu server phải tải model về.';
          await saveAuto(true);
          const r = await api.warmupAutolabel(ctx.pid);
          cfg.loaded = true;
          warm.textContent = `Model đã nằm trên GPU (nạp mất ${r.seconds.toFixed(1)} giây). ${r.info.gpus?.length ? r.info.gpus.join(', ') : ''}`;
        }
      } catch (err) { warm.textContent = ''; toast(err.message, 'err', 9000); }
      renderWarm();
      b.disabled = false;
    });
    renderEngine();
    renderWarm();
    if (cfg.loaded) $('[data-warm]', page).textContent = 'Model đang nằm trên GPU.';
  }

  // ---------- train ----------
  const train = $('[data-train]', page);
  function renderBase() {
    const d = datasets.find(x => x.id === train.dataset_id.value);
    const f = FORMATS[d.format];
    const box = $('[data-base]', page);
    if (f.yolo) {
      box.hidden = false;
      $('[data-custom]', page).hidden = false;
      const names = { n: 'nano, nhanh nhất', s: 'small', m: 'medium', l: 'large', x: 'xlarge, chính xác nhất' };
      train.size.innerHTML = YOLO_SIZES.map(sz => `<option value="yolo26${sz}${YOLO_SUFFIX[f.yolo]}.pt">yolo26${sz}${YOLO_SUFFIX[f.yolo]} (${names[sz]})</option>`).join('');
      if (+train.imgsz.value === 224) train.imgsz.value = 640;
      $('[data-train-hint]', page).textContent = `Ultralytics YOLO ${f.yolo}. Train xong, model dùng được ngay ở phần Tự gán nhãn.`;
    } else {
      // Phân loại: train.py của dataset (torchvision), kiến trúc đã chọn lúc tạo dataset.
      box.hidden = true;
      $('[data-custom]', page).hidden = true;
      if (+train.imgsz.value === 640) train.imgsz.value = 224;
      $('[data-train-hint]', page).textContent = `Chạy train.py của dataset (${d.arch || f.label}, torchvision).`;
    }
  }

  if (datasets.length) {
    train.dataset_id.addEventListener('change', renderBase);
    renderBase();
    train.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = train.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const yolo = !train.size.closest('[data-base]').hidden;
        await api.train(ctx.pid, {
          dataset_id: train.dataset_id.value, server_id: train.server_id.value,
          model: yolo ? (train.custom.value.trim() || train.size.value) : '',
          epochs: +train.epochs.value, imgsz: +train.imgsz.value, batch: +train.batch.value, device: train.device.value.trim(),
          workers: +train.workers.value,
        });
        toast('Đã bắt đầu train. Theo dõi ở danh sách bên dưới.');
        await jobs.refresh();
      } catch (err) { toast(err.message, 'err'); }
      btn.disabled = false;
    });
  }

  // ---------- model đã lưu ----------
  const TASK_LABEL = { detect: 'Detect', pose: 'Pose', segment: 'Segment', classify: 'Phân loại' };
  const inUse = m => cfg && cfg.engine === 'yolo' && cfg.model?.endsWith(`/models/${m.id}.pt`);
  const mb = n => `${(n / 1e6).toFixed(1)} MB`;

  async function renderModels() {
    const box = $('[data-models]', page);
    let list;
    try { list = await api.models(ctx.pid); } catch (err) { box.innerHTML = `<p class="notice">${esc(err.message)}</p>`; return; }
    if (!list.length) {
      box.innerHTML = '<p class="muted">Chưa lưu model nào. Train xong bấm <b>Lưu model</b> ở danh sách bên dưới.</p>';
      return;
    }
    box.replaceChildren(...list.map(m => {
      const usable = detect && m.task !== 'classify';
      const el = h(`
        <div class="job saved-model ${m.starred ? 'starred' : ''}">
          <div class="row">
            <button class="star ghost sm" data-m="star" title="${m.starred ? 'Bỏ đánh dấu' : 'Đánh dấu (đưa lên đầu danh sách)'}" aria-pressed="${m.starred}">${m.starred ? '★' : '☆'}</button>
            <b class="job-title">${esc(m.name)}</b>
            <span class="tag">${TASK_LABEL[m.task] || esc(m.task)}</span>
            ${inUse(m) ? '<span class="tag labeled">Đang dùng để tự gán nhãn</span>' : ''}
            <span class="spacer"></span>
            <span class="muted small">${esc(m.dataset)} · ${esc(m.base_model)} · ${m.epochs} epoch · ${mb(m.size)} · ${esc(m.created_by)} · ${fmtDate(m.created_at)}</span>
          </div>
          ${m.note ? `<p class="small">${esc(m.note)}</p>` : ''}
          ${metricsText(m.metrics) ? `<p class="small">${metricsText(m.metrics)}</p>` : ''}
          <div class="row">
            <a class="btn sm" href="${api.modelFileUrl(m.id)}" download>Tải về</a>
            ${usable ? '<button class="sm primary" data-m="use">Dùng để tự gán nhãn</button>' : ''}
            <button class="sm ghost" data-m="edit">Sửa</button>
            <span class="spacer"></span>
            <button class="sm ghost" data-m="del">Xoá</button>
          </div>
        </div>`);
      el.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', e => modelAction(e.currentTarget, m)));
      return el;
    }));
  }

  const modelForm = (title, v = {}) => `
    <h3>${title}</h3>
    <label class="field">Tên <input type="text" name="name" required maxlength="100" value="${esc(v.name || '')}"></label>
    <label class="field">Ghi chú <span class="hint">VD dataset nào, train thế nào, khác bản trước ở đâu.</span>
      <textarea name="note" rows="3" maxlength="2000">${esc(v.note || '')}</textarea></label>
    <label class="check"><input type="checkbox" name="starred" ${v.starred ? 'checked' : ''}> Đánh dấu ★</label>
    <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
      <button class="primary" type="submit">Lưu</button></div>`;
  const formValues = f => ({ name: f.name.value.trim(), note: f.note.value.trim(), starred: f.starred.checked });

  /** Server để đưa model lên: hỏi nếu có nhiều server, mặc định server đang dùng để tự gán nhãn. */
  async function pickServer() {
    if (servers.length <= 1) return servers[0]?.id || null;
    const r = await openDialog(`
      <h3>Đưa model lên server nào?</h3>
      <label class="field">Server GPU <select name="server">${serverOptions(cfg?.server_id)}</select></label>
      <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
        <button class="primary" type="submit">Dùng</button></div>`, async f => f.server.value);
    return r;
  }

  async function modelAction(b, m) {
    const a = b.dataset.m;
    try {
      if (a === 'star') {
        await api.updateModel(m.id, { starred: !m.starred });
      } else if (a === 'edit') {
        if (!(await openDialog(modelForm('Sửa model', m), f => api.updateModel(m.id, formValues(f))))) return;
        toast('Đã lưu');
      } else if (a === 'del') {
        if (!b.dataset.armed) {
          b.dataset.armed = '1'; b.textContent = 'Bấm lần nữa để xoá';
          setTimeout(() => { delete b.dataset.armed; b.textContent = 'Xoá'; }, 3000);
          return;
        }
        await api.deleteModel(m.id);
        toast(`Đã xoá model ${m.name}`);
      } else if (a === 'use') {
        const serverId = await pickServer();
        if (!serverId) return servers.length ? null : toast('Chưa có server GPU nào', 'warn');
        b.disabled = true; b.textContent = 'Đang đưa lên server…';
        Object.assign(cfg, await api.useModel(m.id, serverId));
        engine = 'yolo';
        renderEngine();
        auto.server_id.value = cfg.server_id;
        renderWarm();
        toast(`Nút Tự gán nhãn giờ dùng model "${m.name}"`);
        jobs.refresh();
      }
      await renderModels();
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  }

  // ---------- các lần train ----------
  const trainDone = j => j.kind === 'train' && j.status === 'done' && j.weights;
  const jobs = jobList($('[data-jobs]', page), {
    projectId: ctx.pid,
    empty: 'Chưa train lần nào.',
    actions: j => (trainDone(j) ? `
      <a class="btn sm" href="${api.jobWeightsUrl(j.id)}" download title="Tải best.pt về máy (lấy từ server GPU)">Tải model</a>
      <button class="sm" data-x="save" title="Chép best.pt về máy chạy app, đặt tên, ghi chú để lưu trữ">Lưu model</button>` : '')
      + (detect && trainDone(j) && j.params.task !== 'classify'
        ? `<button class="sm primary" data-x="use" title="Dùng model này cho nút Tự gán nhãn">${cfg?.model === j.weights && cfg?.server_id === j.server_id ? 'Đang dùng để tự gán nhãn' : 'Dùng để tự gán nhãn'}</button>`
        : ''),
    async onAction(name, j) {
      if (name === 'save') {
        const p = j.params;
        const saved = await openDialog(modelForm('Lưu model', { name: `${p.dataset || 'model'} · ${p.model || p.task}` }),
          f => api.saveModel(j.id, formValues(f)));
        if (saved) { toast(`Đã lưu model "${saved.name}" (${mb(saved.size)})`); renderModels(); }
        return;
      }
      if (name !== 'use') return;
      engine = 'yolo';
      cfg.engine = 'yolo';
      cfg.model = j.weights;
      renderEngine();
      auto.server_id.value = j.server_id;
      try {
        await saveAuto(true);
        toast('Nút Tự gán nhãn giờ dùng model vừa train');
        jobs.refresh();
        auto.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) { toast(err.message, 'err'); }
    },
  });

  el.replaceChildren(page);
  await Promise.all([jobs.refresh(), renderModels()]);
  return { unmount: () => jobs.stop() };
}
