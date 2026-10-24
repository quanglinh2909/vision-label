// Cấu hình lớp của project.
//   Nhận diện đối tượng: mỗi lớp chọn kiểu vẽ — khung / pose (các điểm theo thứ tự) / đa giác.
//   Phân loại: mỗi lớp là một câu hỏi cho cả ảnh, kèm các lựa chọn; "Không rõ" luôn có và là mặc định.
// Nhãn trỏ tới lớp bằng id cố định nên đổi tên, đổi thứ tự, thêm lớp lúc nào cũng được. Lớp đang có
// nhãn thì không xoá được, không đổi kiểu vẽ / số điểm được (server cũng chặn).

import { api } from '../api.js';
import { $, classColor, esc, h, openDialog, SHAPES, toast, UNKNOWN_LABEL } from '../ui.js';

const PLATE_PRESET = { name: 'bien_so', label: 'Biển số', shape: 'pose', keypoints: ['TL', 'TR', 'BR', 'BL'], flip: [1, 0, 3, 2], auto_corners: true };
const CHARS = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const MASK_PRESET = { name: 'deo_khau_trang', label: 'Đeo khẩu trang', options: [{ name: 'co', label: 'Có' }, { name: 'khong', label: 'Không' }] };

// Đoán cặp điểm đối xứng trái/phải từ tên: TL-TR, mat_trai-mat_phai, left_eye-right_eye...
const SWAP = { left: 'right', right: 'left', trai: 'phai', phai: 'trai', 'trái': 'phải', 'phải': 'trái', l: 'r', r: 'l' };
function mirror(name) {
  return name.split(/([_\-\s.]+)/).map(tok => {
    const low = tok.toLowerCase();
    if (SWAP[low]) return SWAP[low];
    if (/^[a-z][lr]$/i.test(tok)) return tok[0] + (tok[1].toLowerCase() === 'l' ? 'r' : 'l'); // TL <-> TR
    return low;
  }).join('');
}
function guessFlip(names) {
  const idx = Object.fromEntries(names.map((n, i) => [n.toLowerCase(), i]));
  return names.map((n, i) => idx[mirror(n)] ?? i).map((j, i, a) => (a[j] === i ? j : i));
}
const flipText = (names, flip) => {
  const pairs = [];
  flip.forEach((j, i) => { if (j > i) pairs.push(`${names[i]}-${names[j]}`); });
  return pairs.join(', ');
};
function parseFlip(text, names) {
  const idx = Object.fromEntries(names.map((n, i) => [n.toLowerCase(), i]));
  const flip = names.map((_, i) => i);
  for (const pair of text.split(',').map(s => s.trim()).filter(Boolean)) {
    const [a, b] = pair.split('-').map(s => idx[s.trim().toLowerCase()]);
    if (a === undefined || b === undefined || a === b) throw new Error(`Cặp đổi chỗ "${pair}" không khớp tên điểm nào`);
    if (flip[a] !== a || flip[b] !== b) throw new Error(`Điểm trong cặp "${pair}" đã nằm trong cặp khác`);
    flip[a] = b; flip[b] = a;
  }
  return flip;
}
const splitNames = text => text.split(',').map(s => s.trim()).filter(Boolean);
/** Tên dataset gợi ý từ tên hiển thị: "Biển số xe" -> "bien_so_xe". */
const slug = text => text.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

export async function mount(el, ctx) {
  const { project } = ctx;
  const classify = project.task === 'classify';
  let usage = { classes: {}, options: {} };
  let saved = '';
  // Bản đang sửa. Pose giữ thêm `kpText` / `flipText` (ô nhập thô) đến lúc lưu mới tách.
  let items = [];

  const load = list => {
    items = list.map(c => (classify
      ? { id: c.id, name: c.name, label: c.label || '', nameTouched: true, options: c.options.map(o => ({ ...o, label: o.label || '', nameTouched: true })) }
      : { id: c.id, name: c.name, label: c.label || '', nameTouched: true, shape: c.shape, kpText: (c.keypoints || []).join(', '),
        flipText: c.shape === 'pose' ? flipText(c.keypoints, c.flip) : '', flipTouched: true, auto_corners: !!c.auto_corners }));
    saved = JSON.stringify(payloadSafe());
  };

  const page = h(`
    <div class="page classes-page">
      <div class="page-head">
        <h2>Lớp</h2>
        <p>${classify
          ? 'Mỗi lớp là một câu hỏi cho cả ảnh, kèm các lựa chọn. "Không rõ" luôn có sẵn và là câu trả lời mặc định.'
          : 'Mỗi lớp tự chọn kiểu vẽ. Lúc gán nhãn, chọn lớp nào thì vẽ theo kiểu của lớp đó.'}</p>
      </div>
      <div class="panel add-panel">
        <div class="row">
          <b>Thêm</b>
          ${classify ? '<button class="sm" data-add="question">+ Câu hỏi</button>' : `
          <button class="sm" data-add="box" title="${SHAPES.box.how}">+ Detect</button>
          <button class="sm" data-add="pose" title="${SHAPES.pose.how}">+ Pose</button>
          <button class="sm" data-add="polygon" title="${SHAPES.polygon.how}">+ Segment</button>
          <button class="sm ghost" data-add="many">+ Nhiều lớp một lúc…</button>`}
          <span class="spacer"></span>
          <span class="muted">Mẫu</span>
          ${classify ? '<button class="sm ghost" data-add="mask">Đeo khẩu trang</button>' : `
          <button class="sm ghost" data-add="plate" title="Pose 4 điểm góc, tự sắp TL, TR, BR, BL">Biển số 4 góc</button>
          <button class="sm ghost" data-add="chars" title="36 lớp khung, gõ phím ký tự để gán">Bộ ký tự 0-9, A-Z</button>`}
        </div>
      </div>
      <div class="cls-list" data-list></div>
      <div class="savebar">
        <span class="muted" data-state></span>
        <span class="spacer"></span>
        <button data-reset hidden>Bỏ thay đổi</button>
        <button class="primary" data-save disabled>Lưu thay đổi</button>
      </div>
    </div>`);
  const list = $('[data-list]', page);

  // ---------- dữ liệu gửi lên ----------
  function payload() {
    return items.map(it => {
      const name = it.name.trim(), label = it.label.trim() || name;
      if (!name) throw new Error(label ? `Lớp "${label}": chưa có tên trong dataset` : 'Còn lớp chưa đặt tên');
      const base = { ...(it.id !== undefined ? { id: it.id } : {}), name, label };
      if (classify) {
        const options = it.options.map(o => ({ ...(o.id !== undefined ? { id: o.id } : {}), name: o.name.trim(), label: o.label.trim() || o.name.trim() }));
        if (options.some(o => !o.name)) throw new Error(`Lớp "${label}": còn lựa chọn chưa đặt tên`);
        return { ...base, options };
      }
      const out = { ...base, shape: it.shape };
      if (it.shape === 'pose') {
        const keypoints = splitNames(it.kpText);
        if (!keypoints.length) throw new Error(`Lớp "${label}": nhập tên các điểm pose`);
        Object.assign(out, { keypoints, flip: parseFlip(it.flipText, keypoints), auto_corners: keypoints.length === 4 && it.auto_corners });
      }
      return out;
    });
  }
  function payloadSafe() { try { return payload(); } catch { return items; } }
  const isDirty = () => JSON.stringify(payloadSafe()) !== saved;

  function renderState() {
    const dirty = isDirty();
    $('[data-save]', page).disabled = !dirty;
    $('[data-reset]', page).hidden = !dirty;
    $('[data-state]', page).textContent = dirty ? 'Có thay đổi chưa lưu' : `${items.length} lớp`;
  }

  // ---------- giao diện ----------
  const usedOf = it => (it.id === undefined ? 0 : usage.classes[it.id] || 0);

  function card(it, i) {
    const n = usedOf(it), locked = n > 0;
    const swatch = it.id === undefined
      ? '<span class="sw new" title="Lớp mới, màu được cấp khi lưu"></span>'
      : `<span class="sw" style="background:${classColor(it.id)}" title="Màu của lớp khi vẽ"></span>`;
    const names = (ph, phName) => `
      <label class="mini grow">Tên hiển thị
        <input type="text" data-f="label" value="${esc(it.label)}" maxlength="100" placeholder="${ph}"></label>
      <label class="mini" title="Tên ghi vào dataset (names trong data.yaml, tên thư mục). Tự gợi ý từ tên hiển thị.">Tên trong dataset
        <input type="text" data-f="name" class="mono" value="${esc(it.name)}" maxlength="64" placeholder="${phName}"></label>`;
    const tools = `
      <span class="usage muted">${n ? `${n} ${classify ? 'ảnh đã trả lời' : 'đối tượng'}` : 'chưa dùng'}</span>
      <button class="sm ghost" data-move="-1" title="Lên trên" aria-label="Lên trên" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="sm ghost" data-move="1" title="Xuống dưới" aria-label="Xuống dưới" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="sm danger" data-del ${locked ? `disabled title="Đang có ${n} nhãn dùng lớp này"` : ''}>Xoá</button>`;
    if (classify) {
      const opt = (o, j) => {
        const used = it.id !== undefined && o.id !== undefined ? usage.options[`${it.id}:${o.id}`] || 0 : 0;
        return `<span class="opt-chip">
          <span class="opt-names">
            <input type="text" data-opt="${j}" data-of="label" value="${esc(o.label)}" maxlength="100" placeholder="Tên hiển thị" aria-label="Tên hiển thị lựa chọn ${j + 1}">
            <input type="text" data-opt="${j}" data-of="name" class="mono" value="${esc(o.name)}" maxlength="64" placeholder="ten_dataset" title="Tên thư mục khi xuất dataset" aria-label="Tên trong dataset lựa chọn ${j + 1}">
          </span>
          ${used ? `<span class="muted" title="Số ảnh chọn lựa chọn này">${used}</span>` : ''}
          <button class="sm ghost" data-optdel="${j}" aria-label="Xoá lựa chọn" ${used ? 'disabled title="Đang được dùng"' : ''}>✕</button>
        </span>`;
      };
      return `<div class="cls-card" data-i="${i}">
        <div class="cls-head">
          ${swatch}
          ${names('Câu hỏi, VD: Đeo khẩu trang', 'deo_khau_trang')}
          ${tools}
        </div>
        <div class="opts-edit">
          ${it.options.map(opt).join('')}
          <button class="sm" data-optadd>+ Lựa chọn</button>
          <span class="opt-chip fixed" title="Luôn có, là câu trả lời mặc định. Lúc xuất dataset chọn có gộp thành một lớp hay bỏ các ảnh này.">${UNKNOWN_LABEL}<span class="muted">mặc định</span></span>
        </div>
      </div>`;
    }
    const k = splitNames(it.kpText).length;
    return `<div class="cls-card" data-i="${i}">
      <div class="cls-head">
        ${swatch}
        ${names('VD: Xe máy', 'xe_may')}
        <div class="seg" role="radiogroup" aria-label="Kiểu vẽ" ${locked ? 'title="Đã có nhãn: không đổi kiểu vẽ được"' : ''}>
          ${Object.entries(SHAPES).map(([s, d]) => `<button type="button" role="radio" data-shape="${s}" aria-checked="${it.shape === s}" ${locked && it.shape !== s ? 'disabled' : ''}>${d.label}</button>`).join('')}
        </div>
        ${tools}
      </div>
      ${it.shape === 'pose' ? `
      <div class="cls-pose">
        <label class="field">Các điểm, theo thứ tự đặt
          <span class="hint">Cách nhau bằng dấu phẩy.${locked ? ` Đã có nhãn: chỉ đổi tên được, giữ nguyên ${k} điểm.` : ''}</span>
          <input type="text" data-f="kpText" value="${esc(it.kpText)}" placeholder="VD: mui, mat_trai, mat_phai"></label>
        <label class="field">Đổi chỗ khi lật ngang ảnh
          <span class="hint">Cặp điểm đối xứng trái/phải, VD: TL-TR, BL-BR. Để trống nếu không có. YOLO dùng khi lật ảnh để tăng dữ liệu.</span>
          <input type="text" data-f="flipText" value="${esc(it.flipText)}"></label>
        ${k === 4 ? `<label class="check"><input type="checkbox" data-f="auto_corners" ${it.auto_corners ? 'checked' : ''}>
          Tự sắp 4 điểm thành TL, TR, BR, BL theo chiều kim đồng hồ (click theo thứ tự nào cũng được)</label>` : ''}
      </div>` : ''}
    </div>`;
  }

  function render(focus) {
    list.innerHTML = items.length ? items.map(card).join('') : `<p class="empty">Chưa có lớp nào. ${classify
      ? 'Bấm <b>+ Câu hỏi</b>, hoặc thử mẫu <b>Đeo khẩu trang</b>.'
      : 'Chọn kiểu vẽ ở trên để thêm lớp, hoặc dùng mẫu <b>Biển số 4 góc</b>.'}</p>`;
    renderState();
    if (focus !== undefined) list.querySelector(`[data-i="${focus}"] [data-f=label]`)?.focus();
  }

  function add(item) { items.push(item); render(items.length - 1); }
  const blankOpt = () => ({ name: '', label: '', nameTouched: false });
  const blank = shape => ({ name: '', label: '', nameTouched: false, shape, kpText: '', flipText: '', flipTouched: false, auto_corners: false });

  $('.add-panel', page).addEventListener('click', e => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    const kind = b.dataset.add;
    if (kind === 'question') return add({ name: '', label: '', nameTouched: false, options: [blankOpt(), blankOpt()] });
    if (kind === 'mask') return add({ name: MASK_PRESET.name, label: MASK_PRESET.label, nameTouched: true, options: MASK_PRESET.options.map(o => ({ ...o, nameTouched: true })) });
    if (kind === 'plate') {
      const p = PLATE_PRESET;
      return add({ name: p.name, label: p.label, nameTouched: true, shape: p.shape, kpText: p.keypoints.join(', '), flipText: flipText(p.keypoints, p.flip), flipTouched: true, auto_corners: true });
    }
    if (kind === 'chars') {
      const have = new Set(items.map(it => it.name.trim().toUpperCase()));
      const fresh = CHARS.filter(c => !have.has(c));
      fresh.forEach(c => items.push({ ...blank('box'), name: c, label: c, nameTouched: true }));
      render();
      return toast(fresh.length ? `Đã thêm ${fresh.length} lớp ký tự. Bấm Lưu để áp dụng.` : 'Đã có đủ bộ ký tự', fresh.length ? 'ok' : 'warn');
    }
    if (kind === 'many') {
      return openDialog(`
        <h3>Thêm nhiều lớp</h3>
        <label class="field">Tên các lớp <span class="hint">Cách nhau bằng dấu phẩy hoặc xuống dòng.</span>
          <textarea name="names" rows="4" required placeholder="xe_may, o_to, xe_tai, xe_buyt"></textarea></label>
        <label class="field">Kiểu vẽ
          <select name="shape">${Object.entries(SHAPES).filter(([s]) => s !== 'pose').map(([s, d]) => `<option value="${s}">${d.label}</option>`).join('')}</select></label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button><button class="primary" type="submit">Thêm</button></div>`,
      form => {
        const have = new Set(items.map(it => it.name.trim().toLowerCase()));
        const names = form.names.value.split(/[,\n]/).map(s => s.trim()).filter(n => n && !have.has(n.toLowerCase()));
        [...new Set(names)].forEach(n => items.push({ ...blank(form.shape.value), name: slug(n) || n, label: n, nameTouched: true }));
        render();
        return true;
      });
    }
    add(blank(kind));
  });

  // Gõ vào ô: chỉ cập nhật dữ liệu, không vẽ lại (giữ con trỏ). Đổi cấu trúc: vẽ lại.
  list.addEventListener('input', e => {
    const cardEl = e.target.closest('[data-i]');
    if (!cardEl) return;
    const it = items[+cardEl.dataset.i];
    const f = e.target.dataset.f;
    if (e.target.dataset.opt !== undefined) {
      const o = it.options[+e.target.dataset.opt], which = e.target.dataset.of;
      o[which] = e.target.value;
      if (which === 'name') o.nameTouched = true;
      else if (!o.nameTouched) {
        o.name = slug(o.label);
        e.target.parentElement.querySelector('[data-of=name]').value = o.name;
      }
      return renderState();
    }
    else if (f === 'auto_corners') it.auto_corners = e.target.checked;
    else if (f) it[f] = e.target.value;
    if (f === 'flipText') it.flipTouched = true;
    if (f === 'name') it.nameTouched = true;
    // Chưa tự sửa tên dataset thì gợi ý theo tên hiển thị.
    if (f === 'label' && !it.nameTouched) {
      it.name = slug(it.label);
      cardEl.querySelector('[data-f=name]').value = it.name;
    }
    if (f === 'kpText' && !it.flipTouched) it.flipText = flipText(splitNames(it.kpText), guessFlip(splitNames(it.kpText)));
    renderState();
  });
  list.addEventListener('change', e => {
    // Đổi số điểm có thể làm hiện / ẩn ô "Tự sắp 4 góc", và cập nhật cặp đổi chỗ vừa đoán.
    if (e.target.dataset.f === 'kpText') render();
  });
  list.addEventListener('click', e => {
    const cardEl = e.target.closest('[data-i]');
    if (!cardEl) return;
    const i = +cardEl.dataset.i, it = items[i];
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.shape) { it.shape = b.dataset.shape; return render(); }
    if (b.dataset.move) {
      const j = i + +b.dataset.move;
      [items[i], items[j]] = [items[j], items[i]];
      return render();
    }
    if (b.hasAttribute('data-del')) { items.splice(i, 1); return render(); }
    if (b.hasAttribute('data-optadd')) {
      it.options.push(blankOpt());
      render();
      return list.querySelector(`[data-i="${i}"] [data-opt="${it.options.length - 1}"][data-of=label]`)?.focus();
    }
    if (b.dataset.optdel !== undefined) { it.options.splice(+b.dataset.optdel, 1); return render(); }
  });

  $('[data-reset]', page).addEventListener('click', () => { load(ctx.project.classes); render(); });
  $('[data-save]', page).addEventListener('click', async () => {
    let body;
    try { body = payload(); } catch (err) { return toast(err.message, 'warn'); }
    const btn = $('[data-save]', page);
    btn.disabled = true;
    try {
      const p = await api.updateProject(ctx.pid, { classes: body });
      Object.assign(ctx.project, p);
      load(p.classes);
      render();
      toast('Đã lưu danh sách lớp');
      ctx.refreshProject();
    } catch (err) { toast(err.message, 'err'); renderState(); }
  });

  const onUnload = e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);

  usage = await api.classUsage(ctx.pid);
  load(project.classes);
  el.replaceChildren(page);
  render();
  return {
    unmount() {
      window.removeEventListener('beforeunload', onUnload);
      if (isDirty()) toast('Thay đổi ở mục Lớp chưa được lưu nên đã bị bỏ.', 'warn', 6000);
    },
  };
}
