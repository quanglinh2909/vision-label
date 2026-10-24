// Tạo dataset theo phiên bản (v1, v2, ...) từ các ảnh đã duyệt.
//   Nhận diện đối tượng: YOLO detect / pose / segment. Mỗi lớp có kiểu vẽ riêng nên trước khi
//   xuất, bảng kế hoạch báo lớp nào xuất nguyên vẹn, lớp nào phải chuyển đổi, lớp nào không xuất được.
//   Phân loại: ImageFolder cho MobileNet / ResNet (kèm train.py), xuất từng câu hỏi một.

import { api } from '../api.js';
import { $, classMap, clsLabel, esc, fmtDate, h, isAdmin, SHAPES, toast, UNKNOWN_LABEL } from '../ui.js';

export const FORMATS = {
  'yolo-detect': { label: 'YOLO detect', yolo: 'detect', model: 'yolo26n.pt', desc: 'Khung bao từng đối tượng.' },
  'yolo-pose': { label: 'YOLO pose', yolo: 'pose', model: 'yolo26n-pose.pt', desc: 'Khung và các điểm. Mọi lớp dùng chung số điểm.' },
  'yolo-segment': { label: 'YOLO segment', yolo: 'segment', model: 'yolo26n-seg.pt', desc: 'Đa giác bao viền đối tượng.' },
  mobilenet: { label: 'MobileNet', desc: 'Nhẹ, nhanh, hợp chạy trên điện thoại / thiết bị yếu.' },
  resnet: { label: 'ResNet', desc: 'Nặng hơn, thường chính xác hơn khi đủ dữ liệu.' },
};
const BY_TASK = { detect: ['yolo-detect', 'yolo-pose', 'yolo-segment'], classify: ['mobilenet', 'resnet'] };
const STATUS = {
  ok: { text: 'Xuất nguyên vẹn', cls: 'ok' },
  convert: { text: 'Chuyển đổi', cls: 'convert' },
  no: { text: 'Không xuất được', cls: 'no' },
};

// Giống Roboflow: đưa link tải công khai + đoạn mã tải/giải nén/train, chạy được ở máy bất kỳ.
function snippets(d) {
  const url = new URL(api.downloadUrl(d), location.origin).href;
  const parts = d.path.split(/[\\/]/);
  const folder = `${parts[parts.length - 2]}-v${d.version}`;
  const f = FORMATS[d.format] || FORMATS['yolo-detect'];
  const fetchSh = `curl -L "${url}" -o ${folder}.zip\nunzip ${folder}.zip`;
  const fetchPy = `import urllib.request, zipfile\n\nurllib.request.urlretrieve("${url}", "${folder}.zip")\nzipfile.ZipFile("${folder}.zip").extractall()`;
  if (!f.yolo) {
    return {
      url,
      terminal: `${fetchSh}\npip install torch torchvision\npython ${folder}/train.py --epochs 30`,
      python: `${fetchPy}\n\nimport subprocess, sys\nsubprocess.run([sys.executable, "${folder}/train.py", "--epochs", "30"], check=True)`,
    };
  }
  return {
    url,
    terminal: `${fetchSh}\nyolo ${f.yolo} train data=${folder}/data.yaml model=${f.model} imgsz=640 epochs=100`,
    python: `${fetchPy}\n\nfrom ultralytics import YOLO\n\nYOLO("${f.model}").train(data="${folder}/data.yaml", imgsz=640, epochs=100)`,
  };
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Đã copy ${what}`); }
  catch { toast('Trình duyệt chặn copy. Hãy bôi đen để copy.', 'warn'); }
}

export async function mount(el, ctx) {
  const { project } = ctx;
  const classify = project.task === 'classify';
  const formats = BY_TASK[project.task];
  let format = formats[0];
  let plan = null;
  const picked = {}; // format -> Set id lớp đang chọn (nhớ khi đổi qua lại)
  // Đã kết nối Google Drive chưa (để hiện nút "Lên Drive" trên từng phiên bản).
  const drive = isAdmin() ? await api.drive().catch(() => null) : null;

  const page = h(`
    <div class="page">
      <div class="page-head">
        <h2>Dataset</h2>
        <p>Mỗi phiên bản là một bản chụp cố định. Sửa nhãn sau này không làm thay đổi các phiên bản đã tạo.</p>
      </div>
      <form class="panel ds-form" autocomplete="off" ${isAdmin() ? '' : 'hidden'}>
        <h3>Tạo phiên bản mới</h3>
        <div class="field">Định dạng
          <div class="fmt-pick" role="radiogroup" aria-label="Định dạng">
            ${formats.map(k => `<button type="button" role="radio" data-format="${k}" aria-checked="false">
              <b>${FORMATS[k].label}</b><span>${FORMATS[k].desc}</span></button>`).join('')}
          </div>
        </div>
        <div class="plan-box" data-plan></div>
        <div class="form-row">
          <label class="field">Tên <input type="text" name="name" maxlength="100" placeholder="Để trống sẽ dùng v1, v2…"></label>
          <label class="field">Tỉ lệ val (%) <input type="number" name="val" min="0" max="90" value="20"></label>
          ${classify ? '<span></span>' : '<label class="check" style="padding-bottom:10px"><input type="checkbox" name="bg" checked> Gồm ảnh nền</label>'}
        </div>
        <label class="field">Ghi chú <input type="text" name="note" placeholder="Ví dụ: thêm 500 ảnh chụp ban đêm"></label>
        <div class="row">
          <p class="muted" data-hint></p><span class="spacer"></span>
          <button class="primary" type="submit">Tạo dataset</button>
        </div>
      </form>
      <div class="ds-list"></div>
    </div>`);

  const form = $('form', page);
  const list = $('.ds-list', page);
  const planBox = $('[data-plan]', page);

  // ---------- kế hoạch xuất ----------
  function renderDetectPlan() {
    const defs = classMap(ctx.project);
    const set = picked[format] ??= new Set(plan.classes.filter(c => c.status !== 'no').map(c => c.id));
    const rows = plan.classes.map(c => {
      const st = STATUS[c.status], off = c.status === 'no';
      return `<tr class="${off ? 'off' : ''}">
        <td><label class="check"><input type="checkbox" data-cls="${c.id}" ${set.has(c.id) && !off ? 'checked' : ''} ${off ? 'disabled' : ''}>
          <b>${esc(clsLabel(defs[c.id] || c))}</b>${defs[c.id]?.label && defs[c.id].label !== c.name ? ` <code>${esc(c.name)}</code>` : ''}</label></td>
        <td class="muted">${SHAPES[c.shape]?.label ?? c.shape}</td>
        <td class="num">${c.objects}</td>
        <td><span class="st ${st.cls}">${st.text}</span>${c.note ? `<span class="note">${esc(c.note)}</span>` : ''}</td>
      </tr>`;
    }).join('');
    const skipped = plan.classes.filter(c => c.status === 'no').length;
    planBox.innerHTML = plan.classes.length ? `
      ${format === 'yolo-pose' && plan.pose_k ? `<p class="muted">Dùng chung <b>${plan.pose_k} điểm</b> theo lớp <b>${esc(plan.pose_from)}</b>.</p>` : ''}
      <div class="table-wrap"><table class="plan">
        <thead><tr><th>Lớp xuất</th><th>Kiểu vẽ</th><th class="num">Đối tượng</th><th>Sang ${FORMATS[format].label}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${skipped ? `<p class="notice">${skipped} lớp không xuất được sang ${FORMATS[format].label}: đối tượng của lớp đó sẽ không có trong dataset. Thử định dạng khác nếu cần lớp này.</p>` : ''}
      <p class="muted small">Bỏ chọn một lớp thì đối tượng của lớp đó không được ghi nhãn, ảnh chứa nó vẫn được xuất.</p>`
      : `<p class="notice">Project chưa có lớp nào. <a href="#/p/${ctx.pid}/classes">Thêm lớp</a> trước.</p>`;
    planBox.querySelectorAll('[data-cls]').forEach(cb => cb.addEventListener('change', () => {
      cb.checked ? set.add(+cb.dataset.cls) : set.delete(+cb.dataset.cls);
    }));
  }

  function renderClassifyPlan() {
    const qs = plan.questions;
    if (!qs.length) {
      planBox.innerHTML = `<p class="notice">Project chưa có lớp nào. <a href="#/p/${ctx.pid}/classes">Thêm lớp</a> trước.</p>`;
      return;
    }
    const prevQ = +(form.question?.value ?? qs[0].id), prevArch = form.arch?.value, prevUnk = form.unknown?.checked ?? false;
    const q = qs.find(x => x.id === prevQ) || qs[0];
    planBox.innerHTML = `
      <div class="form-row two">
        <label class="field">Câu hỏi cần xuất
          <select name="question">${qs.map(x => `<option value="${x.id}" ${x.id === q.id ? 'selected' : ''}>${esc(clsLabel(classMap(ctx.project)[x.id] || x))}</option>`).join('')}</select></label>
        <label class="field">Model
          <select name="arch">${plan.archs.map(a => `<option ${a === prevArch ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      </div>
      <div class="opt-counts">
        ${q.options.map(o => `<span><b>${o.images}</b> ${esc(classMap(ctx.project)[q.id]?.options.find(x => x.id === o.id)?.label || o.name)}</span>`).join('')}
        <span class="unk"><b>${q.unknown}</b> ${UNKNOWN_LABEL}</span>
      </div>
      <label class="check"><input type="checkbox" name="unknown" ${prevUnk ? 'checked' : ''}>
        Thêm lớp "${UNKNOWN_LABEL}" (${q.unknown} ảnh)</label>
      <p class="muted small" data-unkhint></p>`;
    const hint = () => {
      $('[data-unkhint]', planBox).textContent = form.unknown.checked
        ? `"${UNKNOWN_LABEL}" thành một lớp riêng, model học cả trường hợp không xác định được.`
        : `${q.unknown} ảnh "${UNKNOWN_LABEL}" sẽ bị bỏ khỏi dataset (coi như ảnh không thuộc lớp nào).`;
    };
    form.question.addEventListener('change', renderClassifyPlan);
    form.unknown.addEventListener('change', hint);
    hint();
  }

  async function loadPlan() {
    page.querySelectorAll('[data-format]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.format === format)));
    try {
      plan = await api.datasetPlan(ctx.pid, format);
    } catch (err) { planBox.innerHTML = `<p class="notice">${esc(err.message)}</p>`; return; }
    classify ? renderClassifyPlan() : renderDetectPlan();
    $('[data-hint]', page).textContent = `Có ${plan.labeled} ảnh đã duyệt.`;
  }
  page.querySelectorAll('[data-format]').forEach(b => b.addEventListener('click', () => { format = b.dataset.format; loadPlan(); }));

  // ---------- các phiên bản ----------
  function card(d) {
    const sn = snippets(d);
    const f = FORMATS[d.format];
    const isCls = !f?.yolo;
    const c = h(`
      <article class="panel ds">
        <div class="row">
          <span class="ver">v${d.version}</span>
          ${d.name !== `v${d.version}` ? `<h3>${esc(d.name)}</h3>` : ''}
          <span class="fmt-tag">${esc(f?.label ?? d.format)}${d.arch ? ` · ${esc(d.arch)}` : ''}</span>
          <span class="muted">${fmtDate(d.created_at)}</span>
          <span class="spacer"></span>
          <span class="drive-box" data-drive></span>
          <a class="btn sm primary" href="${api.downloadUrl(d)}">Tải zip</a>
          ${isAdmin() ? '<button class="sm danger" data-del>Xoá</button>' : ''}
        </div>
        ${d.note ? `<p>${esc(d.note)}</p>` : ''}
        <p class="classes-line"><span class="muted">${isCls ? `${esc(d.question)}:` : 'Lớp:'}</span> ${d.class_names.map((n, i) => `<code>${i} ${esc(n)}</code>`).join(' ')}</p>
        <div class="nums">
          <span><b>${d.train_count}</b>ảnh train</span>
          <span><b>${d.val_count}</b>ảnh val</span>
          ${isCls ? '' : `<span><b>${d.object_count}</b>đối tượng</span><span><b>${d.background_count}</b>ảnh nền</span>`}
          ${d.skipped_count ? `<span title="${isCls ? `Ảnh trả lời ${UNKNOWN_LABEL}, không xuất` : 'Đối tượng không ghi được ở định dạng này, VD pose chỉ có một điểm'}"><b>${d.skipped_count}</b>${isCls ? 'ảnh không rõ bị bỏ' : 'đối tượng bị bỏ'}</span>` : ''}
          <span><b>${Math.round(d.val_ratio * 100)}%</b>tỉ lệ val</span>
        </div>
        <div class="dl">
          <label class="field">Link tải <span class="hint">Ai có link này đều tải được, kể cả khi không đăng nhập. Chỉ gửi cho người cần.</span>
            <div class="row" style="flex-wrap:nowrap">
              <input type="text" readonly value="${esc(sn.url)}" data-url>
              <button class="sm" type="button" data-copy-url>Copy link</button>
            </div>
          </label>
          <div class="tabs" role="tablist">
            <button class="sm" type="button" role="tab" aria-selected="true" data-tab="terminal">Terminal</button>
            <button class="sm" type="button" role="tab" aria-selected="false" data-tab="python">Python</button>
            <span class="spacer"></span>
            <button class="sm ghost" type="button" data-copy-code>Copy mã</button>
          </div>
          <pre data-code></pre>
        </div>
        <details class="path"><summary>Thư mục trên server</summary>${esc(d.path)}</details>
      </article>`);
    c.dataset.id = d.id;
    renderDrive(c, d);
    let tab = 'terminal';
    const code = $('[data-code]', c);
    const showTab = t => {
      tab = t;
      code.textContent = sn[t];
      c.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    };
    c.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    showTab(tab);
    $('[data-url]', c).addEventListener('focus', e => e.target.select());
    $('[data-copy-url]', c).addEventListener('click', () => copy(sn.url, 'link tải'));
    $('[data-copy-code]', c).addEventListener('click', () => copy(sn[tab], 'đoạn mã'));
    const del = $('[data-del]', c);
    del?.addEventListener('click', async () => {
      if (!del.dataset.armed) {
        del.dataset.armed = '1'; del.textContent = 'Bấm lần nữa để xoá';
        setTimeout(() => { delete del.dataset.armed; del.textContent = 'Xoá'; }, 3000);
        return;
      }
      try { await api.deleteDataset(d.id); c.remove(); toast(`Đã xoá v${d.version}`); ctx.refreshProject(); }
      catch (err) { toast(err.message, 'err'); }
    });
    return c;
  }

  /** Trạng thái bản zip trên Google Drive của một phiên bản: nút tải lên / tiến độ / link / lỗi. */
  function renderDrive(c, d) {
    const box = $('[data-drive]', c);
    if (!isAdmin()) return;
    const st = d.drive_status;
    if (st === 'uploading') {
      const pct = Math.round((d.drive_progress || 0) * 100);
      box.innerHTML = `<span class="drive-prog" title="Đang tải bản zip lên Google Drive"><span class="bar"><span style="width:${pct}%"></span></span>Lên Drive ${pct}%</span>`;
    } else if (st === 'done') {
      box.innerHTML = `<a class="btn sm" href="${esc(d.drive_link)}" target="_blank" rel="noopener" title="Tải lên lúc ${d.drive_uploaded_at ? fmtDate(d.drive_uploaded_at) : ''}">Mở trên Drive</a>`
        + (drive?.connected ? '<button class="sm ghost" data-up title="Tải lại bản zip lên Drive">↻</button>' : '');
    } else if (st === 'error') {
      box.innerHTML = `<span class="drive-err" title="${esc(d.drive_error)}">Lỗi Drive</span>`
        + (drive?.connected ? '<button class="sm" data-up>Thử lại</button>' : '<a class="btn sm ghost" href="#/drive">Kết nối Drive</a>');
    } else {
      box.innerHTML = drive?.connected
        ? `<button class="sm" data-up title="Đẩy bản zip lên Google Drive (${esc(drive.account_email)})">Lên Drive</button>`
        : '<a class="btn sm ghost" href="#/drive" title="Chưa kết nối Google Drive">Google Drive…</a>';
    }
    $('[data-up]', box)?.addEventListener('click', async () => {
      try { Object.assign(d, await api.driveUpload(d.id)); renderDrive(c, d); }
      catch (err) { toast(err.message, 'err'); }
    });
    const err = $('.drive-err', box);
    if (err) err.addEventListener('click', () => toast(d.drive_error, 'err', 9000));
  }
  const cards = new Map(); // id phiên bản -> [thẻ, dữ liệu]

  async function load() {
    const items = await api.datasets(ctx.pid);
    cards.clear();
    list.replaceChildren(...items.map(d => { const c = card(d); cards.set(d.id, [c, d]); return c; }));
    if (!items.length) list.innerHTML = '<p class="empty">Chưa có phiên bản nào. Duyệt vài ảnh rồi bấm <b>Tạo dataset</b>.</p>';
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      name: form.name.value.trim(),
      note: form.note.value.trim(),
      val_ratio: (+form.val.value || 0) / 100,
      format,
    };
    if (classify) {
      if (!form.question) return toast('Project chưa có lớp nào', 'warn');
      Object.assign(body, { question: +form.question.value, arch: form.arch.value, include_unknown: form.unknown.checked });
    } else {
      const set = picked[format];
      if (!set?.size) return toast('Chọn ít nhất một lớp để xuất', 'warn');
      Object.assign(body, { classes: [...set], include_background: form.bg.checked });
    }
    const btn = $('button[type=submit]', form);
    btn.disabled = true; btn.textContent = 'Đang tạo…';
    try {
      const d = await api.createDataset(ctx.pid, body);
      toast(`Đã tạo dataset v${d.version}: ${d.train_count} ảnh train, ${d.val_count} ảnh val`);
      form.name.value = ''; form.note.value = '';
      await load();
      ctx.refreshProject();
    } catch (err) { toast(err.message, 'err'); }
    btn.disabled = false; btn.textContent = 'Tạo dataset';
  });

  el.replaceChildren(page);
  await Promise.all([load(), isAdmin() ? loadPlan() : null]);
  return {
    onLive(event, data, mine) {
      if (data.kind === 'dataset' && !mine) load().catch(() => { });
      if (data.kind === 'drive' && cards.has(data.dataset_id)) {
        const [c, d] = cards.get(data.dataset_id);
        Object.assign(d, { drive_status: data.status, drive_progress: data.progress, drive_link: data.link, drive_error: data.error });
        renderDrive(c, d);
        if (data.status === 'done' && mine) toast(`Đã đưa v${data.version} lên Google Drive`);
        if (data.status === 'error' && mine) toast(`v${data.version} chưa lên được Drive: ${data.error}`, 'err', 9000);
      }
    },
  };
}
