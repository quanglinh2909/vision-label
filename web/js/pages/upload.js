// Tải ảnh lên: chọn file, chọn cả thư mục, hoặc kéo thả (kể cả thư mục).
// Thư mục là dataset đã gán nhãn (YOLO có data.yaml, hoặc ImageFolder cho phân loại) thì hiện bảng
// ghép lớp nguồn -> lớp của project, rồi nhập ảnh kèm nhãn thẳng vào "Cần review" (xem importer.js).

import { api } from '../api.js';
import { baseOf, compat, convertObject, detectDataset, inferClasses, newClassFrom, parseDataYaml, parseYoloLabel } from '../importer.js';
import { $, clsLabel, esc, h, ICONS, SHAPES, toast, UNKNOWN, UNKNOWN_LABEL } from '../ui.js';

const IMG_EXT = /\.(jpe?g|png|bmp|webp)$/i;
const BATCH_FILES = 16;
const BATCH_BYTES = 24 * 1024 * 1024;
const NEW = 'new', SKIP = 'skip';

/** Đọc đệ quy một thư mục được kéo thả vào (FileSystemEntry API), giữ đường dẫn tương đối. */
async function filesFromEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    Object.defineProperty(file, 'relPath', { value: entry.fullPath.replace(/^\//, '') });
    out.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await filesFromEntry(e, out);
    }
  }
}

const shapeText = (shape, k) => `${SHAPES[shape].label}${shape === 'pose' ? ` ${k} điểm` : ''}`;
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const slug = text => text.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

export async function mount(el, ctx) {
  const classify = ctx.project.task === 'classify';
  const page = h(`
    <div class="page">
      <div class="page-head"><h2>Tải ảnh lên</h2></div>
      <div class="drop">
        <span class="muted">${ICONS.drop}</span>
        <h3>Thả ảnh hoặc cả thư mục ảnh vào đây</h3>
        <div class="row" style="justify-content:center">
          <button class="primary" data-pick="files">Chọn ảnh</button>
          <button data-pick="dir">Chọn thư mục</button>
        </div>
        <p class="muted" style="font-size:13.5px;max-width:64ch">Nhận jpg, png, bmp, webp. Ảnh trùng tên với ảnh đã có trong project sẽ được bỏ qua.<br>
          ${classify
            ? 'Thư mục dạng <b>ImageFolder</b> (<code>train/&lt;lớp&gt;/ảnh</code>) sẽ được nhận ra và nhập kèm câu trả lời vào Cần review.'
            : 'Thư mục dataset <b>YOLO</b> (có <code>data.yaml</code>, <code>images/</code>, <code>labels/</code>) sẽ được nhận ra và nhập kèm nhãn vào Cần review.'}<br>
          Khi chọn thư mục, trình duyệt sẽ hỏi xác nhận trước khi tải lên. Kéo thả thư mục vào đây thì không bị hỏi.</p>
        <input type="file" data-in="files" accept=".jpg,.jpeg,.png,.bmp,.webp" multiple hidden>
        <input type="file" data-in="dir" webkitdirectory multiple hidden>
      </div>
      <div class="panel import-panel" data-import hidden></div>
      <div class="panel" data-job hidden>
        <div class="row"><h3 data-title></h3><span class="spacer"></span><span class="muted" data-nums></span></div>
        <div class="bar"><div data-bar></div></div>
        <div class="log" data-log></div>
        <div class="row" data-done hidden>
          <a class="btn" data-review href="#/p/${ctx.pid}/review" hidden>Xem Cần review</a>
          <a class="btn" href="#/p/${ctx.pid}/unlabeled">Xem ảnh chưa gán</a>
          <a class="btn primary" data-start href="#/p/${ctx.pid}/unlabeled">Bắt đầu gán nhãn</a>
        </div>
      </div>
    </div>`);

  const drop = $('.drop', page);
  const box = $('[data-import]', page);
  const inputs = { files: $('[data-in=files]', page), dir: $('[data-in=dir]', page) };
  let busy = false;

  page.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => inputs[b.dataset.pick].click()));
  Object.values(inputs).forEach(inp => inp.addEventListener('change', () => { take([...inp.files]); inp.value = ''; }));

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async e => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = [];
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const en of entries) await filesFromEntry(en, files);
    else files.push(...e.dataTransfer.files);
    take(files);
  });

  /** Nhận file: dataset có nhãn đúng loại project -> bảng nhập; còn lại -> tải ảnh thường. */
  async function take(all) {
    if (busy) return toast('Đang tải lên, đợi xong lượt này đã', 'warn');
    box.hidden = true;
    const ds = detectDataset(all);
    if (ds && (ds.kind === 'yolo') !== classify) {
      try { return await (classify ? showFolderImport(ds) : showYoloImport(ds)); }
      catch (err) { toast(`Không đọc được dataset: ${err.message}`, 'err'); }
    }
    if (ds?.kind === 'yolo' && classify) toast('Thư mục là dataset YOLO nhưng project này là phân loại: chỉ tải ảnh, bỏ nhãn.', 'warn', 6000);
    upload(all.filter(f => IMG_EXT.test(f.name)), null, all.length);
  }

  // ---------------------------------------------------------------- YOLO
  async function showYoloImport(ds) {
    const meta = parseDataYaml(await ds.yamlFile.text());
    const parsed = new Map();
    for (const it of ds.items) if (it.label) parsed.set(it, parseYoloLabel(await it.label.text(), meta));
    const rows = inferClasses(meta, [...parsed.values()]);
    const classes = ctx.project.classes;
    const fmt = meta.kpt ? 'pose' : rows.some(r => r.shape === 'polygon') ? 'segment' : 'detect';
    const labeled = parsed.size;
    // Mặc định: lớp cùng tên (tên dataset hoặc tên hiển thị) thì ghép, không thì tạo lớp mới. Project đã có
    // lớp thì lớp nguồn không có đối tượng nào được bỏ qua, khỏi sinh lớp rỗng.
    const target = rows.map(r => classes.find(c => sameName(c.name, r.name) || sameName(clsLabel(c), r.name))?.id
      ?? (classes.length && !r.objects ? SKIP : NEW));

    const options = (r, sel) => [
      `<option value="${NEW}" ${sel === NEW ? 'selected' : ''}>+ Tạo lớp mới "${esc(r.name)}" (${shapeText(r.shape, r.k)})</option>`,
      ...classes.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(clsLabel(c))} (${shapeText(c.shape, c.keypoints?.length)})</option>`),
      `<option value="${SKIP}" ${sel === SKIP ? 'selected' : ''}>Bỏ qua lớp này</option>`,
    ].join('');
    const noteOf = (r, sel) => {
      if (sel === SKIP) return { status: 'no', note: 'Đối tượng của lớp này không được nhập.' };
      if (sel === NEW) return { status: 'ok', note: '' };
      return compat(r, classes.find(c => c.id === sel));
    };
    const ST = { ok: 'Nhập nguyên vẹn', convert: 'Chuyển đổi', no: 'Không nhập' };

    function render() {
      box.innerHTML = `
        <div class="row"><h3>Dataset YOLO ${fmt}</h3>
          <span class="muted">${ds.items.length} ảnh · ${labeled} ảnh có nhãn${ds.items.length - labeled ? ` · ${ds.items.length - labeled} ảnh không có file nhãn` : ''}</span></div>
        <p class="muted">Ảnh có file nhãn vào thẳng <b>Cần review</b>, ghi bạn là người gán; duyệt xong mới vào dataset.
          Ảnh không có file nhãn vào <b>Chưa gán nhãn</b>. File nhãn rỗng là ảnh nền.</p>
        <div class="table-wrap"><table class="plan">
          <thead><tr><th>Lớp trong dataset</th><th>Kiểu</th><th class="num">Đối tượng</th><th>Nhập vào lớp</th><th></th></tr></thead>
          <tbody>${rows.map((r, i) => {
            const n = noteOf(r, target[i]);
            return `<tr class="${n.status === 'no' ? 'off' : ''}">
              <td><b>${esc(r.name)}</b></td>
              <td class="muted">${shapeText(r.shape, r.k)}</td>
              <td class="num">${r.objects}</td>
              <td><select data-map="${i}">${options(r, target[i])}</select></td>
              <td><span class="st ${n.status}">${ST[n.status]}</span>${n.note ? `<span class="note">${esc(n.note)}</span>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
        <div class="row">
          <button data-cancel>Huỷ</button><span class="spacer"></span>
          <button data-plain title="Tải ảnh vào Chưa gán nhãn, không lấy nhãn">Chỉ tải ảnh, bỏ nhãn</button>
          <button class="primary" data-go>Nhập ${ds.items.length} ảnh</button>
        </div>`;
      box.querySelectorAll('[data-map]').forEach(s => s.addEventListener('change', () => {
        const v = s.value;
        target[+s.dataset.map] = v === NEW || v === SKIP ? v : +v;
        render();
      }));
      $('[data-cancel]', box).addEventListener('click', () => { box.hidden = true; });
      $('[data-plain]', box).addEventListener('click', () => { box.hidden = true; upload(ds.items.map(it => it.file)); });
      $('[data-go]', box).addEventListener('click', go);
    }

    async function go() {
      // 1. Tạo các lớp mới (một lần, trước khi tải), rồi ghép lớp nguồn -> id lớp của project.
      const fresh = rows.filter((_, i) => target[i] === NEW).map(r => newClassFrom(r, meta));
      let list = ctx.project.classes;
      if (fresh.length) {
        try {
          const p = await api.updateProject(ctx.pid, { classes: [...list, ...fresh] });
          Object.assign(ctx.project, p);
          list = p.classes;
          ctx.refreshProject();
        } catch (err) { return toast(`Không tạo được lớp mới: ${err.message}`, 'err'); }
      }
      const bySrc = {};
      rows.forEach((r, i) => {
        const t = target[i] === NEW ? list.find(c => sameName(c.name, r.name)) : target[i] === SKIP ? null : list.find(c => c.id === target[i]);
        bySrc[r.src] = t || null;
      });
      // 2. Đổi nhãn từng ảnh.
      const annotations = {};
      let dropped = 0;
      for (const [it, objs] of parsed) {
        const out = [];
        for (const o of objs) {
          const t = bySrc[o.src];
          const obj = t && convertObject(o, t);
          if (obj) out.push(obj); else if (t) dropped++;
        }
        annotations[baseOf(it.path)] ??= out;
      }
      box.hidden = true;
      upload(ds.items.map(it => it.file), annotations, 0, dropped);
    }
    render();
    box.hidden = false;
  }

  // ---------------------------------------------------------------- ImageFolder (phân loại)
  async function showFolderImport(ds) {
    let info = null;
    try { info = ds.classesFile ? JSON.parse(await ds.classesFile.text()) : null; } catch { info = null; }
    const pretty = Object.fromEntries((info?.classes || []).map(c => [c.folder, c.label || c.name]));
    const folders = ds.folders.map(f => ({ folder: f, label: pretty[f] || f, count: ds.items.filter(it => it.folder === f).length }));
    const qs = ctx.project.classes;
    const qName = info?.label || info?.question || '';
    let q = qs.find(c => qName && (sameName(c.name, info.question || '') || sameName(clsLabel(c), qName)))?.id ?? qs[0]?.id ?? NEW;
    let newQ = qName || 'Câu hỏi mới';
    let target = [];

    const guess = (f, cls) => {
      if (/^(khong[-_ ]?ro|unknown)$/i.test(f.folder)) return UNKNOWN;
      const o = cls?.options.find(o => sameName(o.name, f.folder) || sameName(o.label || '', f.label) || slug(o.label || o.name) === slug(f.folder));
      return o ? o.id : NEW;
    };
    const resetTargets = () => { const cls = qs.find(c => c.id === q); target = folders.map(f => guess(f, cls)); };
    resetTargets();

    function render() {
      const cls = qs.find(c => c.id === q);
      const opts = sel => [
        ...(cls?.options || []).map(o => `<option value="${o.id}" ${sel === o.id ? 'selected' : ''}>${esc(o.label || o.name)}</option>`),
        `<option value="${UNKNOWN}" ${sel === UNKNOWN ? 'selected' : ''}>${UNKNOWN_LABEL}</option>`,
        `<option value="${NEW}" ${sel === NEW ? 'selected' : ''}>+ Tạo lựa chọn mới</option>`,
        `<option value="${SKIP}" ${sel === SKIP ? 'selected' : ''}>Bỏ qua (không tải các ảnh này)</option>`,
      ].join('');
      const n = folders.reduce((s, f, i) => s + (target[i] === SKIP ? 0 : f.count), 0);
      box.innerHTML = `
        <div class="row"><h3>Dataset ImageFolder</h3><span class="muted">${ds.items.length} ảnh · ${folders.length} thư mục lớp</span></div>
        <p class="muted">Mỗi thư mục là một câu trả lời. Ảnh được nhập vào <b>Cần review</b> kèm câu trả lời, ghi bạn là người gán.</p>
        <div class="form-row two">
          <label class="field">Câu hỏi
            <select data-q>${qs.map(c => `<option value="${c.id}" ${q === c.id ? 'selected' : ''}>${esc(clsLabel(c))}</option>`).join('')}
              <option value="${NEW}" ${q === NEW ? 'selected' : ''}>+ Tạo câu hỏi mới</option></select></label>
          ${q === NEW ? `<label class="field">Tên câu hỏi mới <input type="text" data-newq value="${esc(newQ)}" maxlength="100"></label>` : '<span></span>'}
        </div>
        <div class="table-wrap"><table class="plan">
          <thead><tr><th>Thư mục</th><th class="num">Ảnh</th><th>Câu trả lời</th></tr></thead>
          <tbody>${folders.map((f, i) => `<tr class="${target[i] === SKIP ? 'off' : ''}">
            <td><b>${esc(f.label)}</b>${f.label !== f.folder ? ` <code>${esc(f.folder)}</code>` : ''}</td>
            <td class="num">${f.count}</td>
            <td><select data-map="${i}">${opts(target[i])}</select></td></tr>`).join('')}</tbody>
        </table></div>
        <div class="row">
          <button data-cancel>Huỷ</button><span class="spacer"></span>
          <button data-plain title="Tải ảnh vào Chưa gán nhãn, không lấy câu trả lời">Chỉ tải ảnh, bỏ nhãn</button>
          <button class="primary" data-go ${n ? '' : 'disabled'}>Nhập ${n} ảnh</button>
        </div>`;
      $('[data-q]', box).addEventListener('change', e => { q = e.target.value === NEW ? NEW : +e.target.value; resetTargets(); render(); });
      $('[data-newq]', box)?.addEventListener('input', e => { newQ = e.target.value; });
      box.querySelectorAll('[data-map]').forEach(s => s.addEventListener('change', () => {
        const v = s.value;
        target[+s.dataset.map] = v === NEW || v === SKIP ? v : +v;
        render();
      }));
      $('[data-cancel]', box).addEventListener('click', () => { box.hidden = true; });
      $('[data-plain]', box).addEventListener('click', () => { box.hidden = true; upload(ds.items.map(it => it.file)); });
      $('[data-go]', box).addEventListener('click', go);
    }

    async function go() {
      // Thêm câu hỏi / lựa chọn mới (nếu có) trước, rồi ghép thư mục -> id lựa chọn.
      const freshOpts = folders.filter((_, i) => target[i] === NEW).map(f => ({ name: slug(f.folder) || f.folder, label: f.label }));
      let list = ctx.project.classes;
      if (q === NEW || freshOpts.length) {
        const label = newQ.trim() || 'Câu hỏi mới';
        const next = q === NEW
          ? [...list, { name: slug(info?.question || label) || 'cau_hoi', label, options: freshOpts }]
          : list.map(c => (c.id === q ? { ...c, options: [...c.options, ...freshOpts] } : c));
        try {
          const p = await api.updateProject(ctx.pid, { classes: next });
          Object.assign(ctx.project, p);
          list = p.classes;
          ctx.refreshProject();
        } catch (err) { return toast(`Không thêm được câu hỏi / lựa chọn: ${err.message}`, 'err'); }
      }
      const cls = q === NEW ? list[list.length - 1] : list.find(c => c.id === q);
      const value = folders.map((f, i) => (target[i] === NEW ? cls.options.find(o => o.label === f.label)?.id : target[i]));
      const annotations = {};
      const files = [];
      ds.items.forEach(it => {
        const i = folders.findIndex(f => f.folder === it.folder);
        if (value[i] === SKIP || value[i] === undefined) return;
        files.push(it.file);
        annotations[baseOf(it.path)] ??= [{ cls: cls.id, value: value[i] }];
      });
      box.hidden = true;
      upload(files, annotations);
    }
    render();
    box.hidden = false;
  }

  // ---------------------------------------------------------------- tải lên
  async function upload(files, annotations = null, total = files.length, dropped = 0) {
    if (busy) return toast('Đang tải lên, đợi xong lượt này đã', 'warn');
    const ignored = total - files.length;
    if (!files.length) return toast('Không có file ảnh nào', 'warn');
    busy = true;

    const job = $('[data-job]', page), log = $('[data-log]', page), bar = $('[data-bar]', page);
    job.hidden = false; $('[data-done]', page).hidden = true; log.innerHTML = '';
    $('[data-title]', page).textContent = `Đang tải ${files.length} ảnh…`;
    const line = (msg, cls = 'muted') => log.appendChild(h(`<div class="${cls}">${esc(msg)}</div>`));
    if (ignored > 0) line(`Bỏ qua ${ignored} file không phải ảnh`);
    if (dropped) line(`${dropped} đối tượng không nhập được (lớp đích khác kiểu, xem bảng ghép lớp)`, 'err');

    let sent = 0, added = 0, imported = 0, skipped = 0, errors = 0;
    const batches = [];
    for (let i = 0, cur = [], size = 0; i < files.length; i++) {
      cur.push(files[i]); size += files[i].size;
      if (cur.length >= BATCH_FILES || size >= BATCH_BYTES || i === files.length - 1) { batches.push(cur); cur = []; size = 0; }
    }
    for (const batch of batches) {
      try {
        const labels = annotations && Object.fromEntries(batch.map(f => [f.name, annotations[f.name]]).filter(([, v]) => v));
        const r = await api.upload(ctx.pid, batch, labels);
        added += r.added; imported += r.imported || 0; skipped += r.skipped.length; errors += r.errors.length;
        r.errors.forEach(m => line(m, 'err'));
      } catch (err) {
        errors += batch.length;
        line(`Lỗi lô ${batch[0].name}…: ${err.message}`, 'err');
      }
      sent += batch.length;
      bar.style.width = `${(sent / files.length) * 100}%`;
      $('[data-nums]', page).textContent = `${sent} / ${files.length} ảnh`;
    }
    $('[data-title]', page).textContent = `Đã thêm ${added} ảnh${imported ? ` (${imported} ảnh kèm nhãn vào Cần review)` : ''}${skipped ? `, bỏ qua ${skipped} ảnh trùng tên` : ''}${errors ? `, ${errors} lỗi` : ''}`;
    $('[data-done]', page).hidden = false;
    $('[data-review]', page).hidden = !imported;
    busy = false;
    const p = await ctx.refreshProject();
    // "next": server phát ảnh chưa ai giữ, nhiều người cùng bắt đầu không bị trùng ảnh.
    if (p && p.unlabeled_count) $('[data-start]', page).href = `#/p/${ctx.pid}/label/next?queue=unlabeled`;
  }

  el.replaceChildren(page);
  return {};
}
