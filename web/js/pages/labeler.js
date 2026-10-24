// Trình gán nhãn: duyệt tuần tự trong một hàng đợi (chưa gán / đã gán), lưu qua API.

import { api } from '../api.js';
import { ClassifyTool } from '../editor/classify-tool.js';
import { Editor } from '../editor/editor.js';
import { ObjectTool } from '../editor/object-tool.js';
import { STATUS } from '../tiles.js';
import { $, classColor, clsLabel, esc, fmtDate, h, isAdmin, openDialog, session, SHAPES, toast, UNKNOWN, UNKNOWN_LABEL } from '../ui.js';

/** "Ctrl+S" -> keycap Ctrl + keycap S; "mouse:Kéo chuột" -> chữ thao tác chuột; "…" -> dải phím. */
function keysHtml(alts) {
  const part = p => (p.startsWith('mouse:') ? `<span class="mouse">${esc(p.slice(6))}</span>` : `<kbd>${esc(p)}</kbd>`);
  return alts.map((a, i) => {
    if (a === '…') return '<span class="dash">–</span>';
    const sep = i > 0 && alts[i - 1] !== '…' ? '<span class="dash">/</span>' : '';
    return sep + a.split('+').map(part).join('<span class="plus">+</span>');
  }).join('');
}

function shortcutsHtml(help) {
  const groups = [
    ['Vẽ và chỉnh', help.draw],
    ['Chuyển ảnh', [
      ['Lưu và sang ảnh tiếp', help.next],
      ['Ảnh trước', help.prev],
      ['Lưu', ['Ctrl+S']],
      ['Hoàn tác', ['Ctrl+Z']],
    ]],
    ['Xem', [
      ['Phóng to, thu nhỏ', ['mouse:Lăn chuột']],
      ['Kéo ảnh', ['Space+mouse:kéo', 'mouse:Nút giữa']],
      ['Vừa khung', ['Ctrl+0']],
      ['Ẩn hoặc hiện nhãn', ['\\']],
      ['Bỏ chọn', ['Esc']],
    ]],
  ];
  return groups.map(([title, rows]) => `
    <div class="kgroup">
      <h5>${title}</h5>
      ${rows.map(([desc, alts]) => `<div class="krow"><span>${esc(desc)}</span><span class="kk">${keysHtml(alts)}</span></div>`).join('')}
    </div>`).join('');
}

export async function mount(el, ctx) {
  const { project } = ctx;
  const admin = isAdmin();
  if (!project.classes.length) {
    el.replaceChildren(h(`<div class="page"><p class="empty">Project chưa có lớp nào nên chưa gán nhãn được.
      ${admin ? `<a href="#/p/${ctx.pid}/classes">Thêm lớp</a> trước.` : 'Báo quản trị viên thêm lớp.'}</p></div>`));
    return {};
  }
  const queue = ['unlabeled', 'todo', 'review', 'rejected', 'labeled'].includes(ctx.query.queue) ? ctx.query.queue : (admin ? 'unlabeled' : 'todo');
  // Tab của danh sách đã mở ảnh này ('' = mặc định, '*' = Tất cả, tên = một người).
  // Giữ nguyên để nút quay lại về đúng tab; chỉ lọc API khi là tên một người.
  const fromTab = ctx.query.assignee ?? '';
  const assignee = fromTab === '*' ? '' : fromTab;
  const backHref = `#/p/${ctx.pid}/${queue}${fromTab ? `?assignee=${encodeURIComponent(fromTab)}` : ''}`;
  // Lưu luôn đưa ảnh vào "chờ duyệt". Chỉ trong "Cần review", quản trị viên có nút Duyệt / Trả lại.
  const reviewMode = admin && queue === 'review';
  const BACK = { unlabeled: 'Chưa gán nhãn', todo: 'Việc của tôi', review: admin ? 'Cần review' : 'Chờ duyệt', rejected: 'Bị trả lại', labeled: 'Đã duyệt' };
  const primary = reviewMode ? 'Duyệt và tiếp' : admin ? 'Lưu và tiếp' : 'Nộp và tiếp';
  // Danh sách tự phát ảnh: "tiếp" luôn lưu (ảnh trống = ảnh nền). Cần review: "tiếp" = duyệt.
  // Danh sách xem lại (Đã duyệt, Chờ duyệt của người gán): chỉ lưu khi có sửa, để lướt qua
  // không vô tình đẩy ảnh đã duyệt về chờ duyệt.
  const saveOnNext = queue === 'unlabeled' || queue === 'todo' || reviewMode;
  const classify = project.task === 'classify';
  const tool = classify ? new ClassifyTool(project.classes) : new ObjectTool(project.classes);
  // A / D chuyển ảnh — trừ khi có lớp tên "a" hoặc "d" (gõ tên lớp một ký tự để gán lớp).
  const letterNav = !project.classes.some(c => ['a', 'd'].includes(c.name.toLowerCase()));
  const help = { ...tool.help, next: letterNav ? ['D', '→', 'Enter'] : ['→', 'Enter'], prev: letterNav ? ['A', '←'] : ['←'] };
  // Bảng lớp: chữ to dạng lưới khi mọi tên lớp rất ngắn (bộ ký tự), danh sách khi tên dài.
  const widePalette = project.classes.some(c => c.name.length > 2);
  const unit = n => (classify ? `${n} câu đã trả lời` : `${n} đối tượng`);

  const page = h(`
    <div class="labeler">
      <div class="lbar">
        <a class="btn ghost sm" href="${backHref}" data-back>‹ ${BACK[queue]}</a>
        <span class="pos" data-pos></span>
        <span class="fname" data-name>…</span>
        <span class="tag" data-status></span>
        <span class="muted who-line" data-who></span>
        <span class="savestate" data-save></span>
        <span class="spacer"></span>
        <button class="sm ghost" data-act="clear" title="Đưa ảnh về danh sách chưa gán nhãn">Bỏ nhãn</button>
        <button class="sm ghost" data-act="fit" title="Ctrl+0">Vừa khung</button>
        <button class="sm ghost" data-act="hide" title="Phím \\" ${classify ? 'hidden' : ''}>Ẩn nhãn</button>
        <button class="sm" data-act="prev" title="Phím ←">Ảnh trước</button>
        ${reviewMode ? '<button class="sm danger" data-act="reject" title="Trả ảnh lại cho người gán kèm ghi chú">Trả lại</button>' : ''}
        <button class="sm" data-act="save" title="${reviewMode ? 'Ctrl+S. Lưu nhãn hiện tại và duyệt' : 'Ctrl+S. Lưu xong ảnh vào mục Cần review chờ duyệt'}">${reviewMode ? 'Duyệt' : 'Lưu'}</button>
        <button class="sm primary" data-act="next" title="${letterNav ? 'Phím D, → hoặc Enter' : 'Phím → hoặc Enter'}">${primary}</button>
      </div>
      <div class="noticebar" data-notice hidden></div>
      <div class="lockbar" data-lockbar hidden>
        <span data-lockmsg></span>
        <span class="spacer"></span>
        <button class="sm" data-act="skip">Sang ảnh khác</button>
        <button class="sm primary" data-act="takeover">Giành quyền sửa</button>
      </div>
      <div class="lbody">
        <div class="stage"><canvas></canvas></div>
        <aside class="lside">
          <div class="sec" ${classify ? 'hidden' : ''}><canvas class="loupe" width="290" height="170"></canvas></div>
          ${classify ? `
          <div class="sec">
            <h4>Câu hỏi</h4>
            <div class="attrs" data-attrs></div>
          </div>` : `
          <div class="sec">
            <h4>Lớp</h4>
            <div class="palette ${widePalette ? 'wide' : ''}" data-palette></div>
            <p class="mode-hint" data-mode></p>
          </div>
          <div class="sec">
            <h4 data-objtitle></h4>
            <div class="objs" data-objs></div>
          </div>`}
          <details class="sec" data-history>
            <summary><h4>Lịch sử</h4><span class="muted" data-hcount></span></summary>
            <div class="history" data-hlist></div>
          </details>
          <details class="sec" data-keys>
            <summary><h4>Phím tắt</h4></summary>
            ${shortcutsHtml(help)}
          </details>
        </aside>
      </div>
    </div>`);
  el.replaceChildren(page);

  // Nhớ mục phím tắt đang mở hay thu gọn (mặc định mở cho người mới).
  const keysBox = $('[data-keys]', page);
  try { keysBox.open = localStorage.getItem('labeler-keys-open') !== '0'; } catch { keysBox.open = true; }
  keysBox.addEventListener('toggle', () => { try { localStorage.setItem('labeler-keys-open', keysBox.open ? '1' : '0'); } catch { } });

  const palette = $('[data-palette]', page);
  if (palette) {
    palette.innerHTML = project.classes.map((c, i) => `
      <button data-cls="${c.id}" title="${esc(clsLabel(c))} (${esc(c.name)}): ${SHAPES[c.shape].label}">
        <span class="sw" style="background:${classColor(c.id)}"></span>
        <span class="nm">${widePalette && i < 9 ? `${i + 1}. ` : ''}${esc(widePalette ? clsLabel(c) : c.name)}</span>
        ${widePalette ? `<small>${SHAPES[c.shape].label}${c.shape === 'pose' ? ` ${c.keypoints.length} điểm` : ''}</small>` : ''}
      </button>`).join('');
    palette.addEventListener('click', e => {
      const b = e.target.closest('[data-cls]');
      if (b) editor.tool.assignClass(+b.dataset.cls);
    });
  }
  // Phân loại: bấm nút lựa chọn = trả lời câu hỏi đó.
  $('[data-attrs]', page)?.addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (b) { b.blur(); editor.tool.choose(+b.dataset.q, +b.dataset.v); }
  });

  const editor = new Editor({
    canvas: $('.stage canvas', page),
    loupe: $('.loupe', page),
    tool,
    classes: project.classes,
    onChange: renderSide,
  });

  // Hai kiểu hàng đợi:
  //  - "chưa gán": xin ảnh từ server (claim-next) -> nhiều người gán cùng lúc không bao giờ
  //    nhận trùng ảnh. `list` giữ các ảnh đã đi qua trong phiên để quay lại bằng "Ảnh trước".
  //  - "đã gán": duyệt lại danh sách cố định theo tên file.
  // Ảnh đang mở luôn được giữ chỗ (lock) và gia hạn định kỳ; người khác mở sẽ ở chế độ chỉ xem.
  // "Tự phát ảnh" (claim-next) cho danh sách cần gán; các danh sách khác duyệt theo thứ tự cố định.
  const reviewing = queue === 'review' || queue === 'rejected' || queue === 'labeled';
  const list = reviewing ? (await api.refs(ctx.pid, queue, assignee || undefined)).map(r => r.id) : [];
  let idx = -1;
  let image = null;
  let readOnly = false; // không lưu được: người khác đang giữ, hoặc ảnh đã duyệt (người gán)
  let frozen = false; // ảnh đã duyệt, người gán chỉ xem
  let busy = false;
  let alive = true; // false khi đã rời trang: thao tác tải dở phải dừng và trả chỗ
  // Quản trị viên tự gán: ảnh chưa giao cho ai. Người gán: ảnh được giao chưa làm + bị trả lại.
  const remainingOf = p => (admin ? p.unassigned_count : p.unlabeled_count + p.rejected_count);
  let remaining = remainingOf(project);

  function renderAttrs() {
    const t = editor.tool;
    $('[data-attrs]', page).innerHTML = project.classes.map((c, i) => {
      const value = t.objects[i]?.value ?? UNKNOWN, active = i === Math.max(t.sel, 0);
      const btn = (v, text, key) => `<button type="button" data-q="${i}" data-v="${v}"
        class="${value === v ? 'on' : ''} ${v === UNKNOWN ? 'unk' : ''}">${active ? `<kbd>${key}</kbd>` : ''}${esc(text)}</button>`;
      return `<div class="attr ${active ? 'active' : ''}">
        <div class="q">${esc(clsLabel(c))}</div>
        <div class="opts">${c.options.map((o, k) => btn(o.id, o.label || o.name, k + 1)).join('')}${btn(UNKNOWN, UNKNOWN_LABEL, 0)}</div>
      </div>`;
    }).join('');
  }

  /** Dòng nhắc dưới bảng lớp: lớp đang chọn vẽ kiểu gì, thao tác thế nào. */
  function renderMode() {
    const t = editor.tool, c = t.cfg;
    if (!c) return;
    let how = SHAPES[c.shape].how;
    if (c.shape === 'pose') {
      const next = t.pending ? t.pending.pts.length : 0;
      how = `Click lần lượt: ${c.keypoints.map((k, i) => (i === next && t.pending ? `<b>${esc(k)}</b>` : esc(k))).join(' → ')}.`;
    }
    $('[data-mode]', page).innerHTML = `Đang vẽ <b>${esc(clsLabel(c))}</b> (${SHAPES[c.shape].label}). ${how}`;
  }

  function renderSide() {
    renderCommon();
    if (classify) return renderAttrs();
    renderMode();
    const items = editor.tool.items();
    $('[data-objtitle]', page).textContent = `Đối tượng (${items.length})`;
    const objs = $('[data-objs]', page);
    objs.innerHTML = items.length ? '' : `<span class="muted">${image?.status === 'labeled'
      ? 'Ảnh nền, không có đối tượng.'
      : 'Chưa có đối tượng nào.'}</span>`;
    items.forEach((it, n) => {
      const i = it.index ?? n;
      const row = h(`<div class="${i === editor.tool.sel ? 'on' : ''}"><span class="sw" style="background:${it.color}"></span>
        <span>${esc(it.text)}</span><button class="x sm ghost" title="Xoá" aria-label="Xoá">✕</button></div>`);
      row.addEventListener('click', e => {
        if (e.target.closest('.x')) { editor.tool.sel = i; editor.tool.deleteSelected(); }
        else editor.tool.select(i);
      });
      objs.appendChild(row);
    });
    const selCls = editor.tool.sel >= 0 ? editor.tool.objects[editor.tool.sel]?.cls : editor.currentClass;
    palette.querySelectorAll('[data-cls]').forEach(b => b.classList.toggle('on', +b.dataset.cls === selCls));
  }

  function renderCommon() {
    const st = $('[data-save]', page);
    st.className = 'savestate' + (editor.dirty ? ' dirty' : '');
    st.textContent = editor.dirty ? 'Chưa lưu' : '';
    $('[data-act=hide]', page).textContent = editor.hide ? 'Hiện nhãn' : 'Ẩn nhãn';
  }

  function renderBar() {
    $('[data-name]', page).textContent = image.filename;
    $('[data-name]', page).title = image.filename;
    const s = $('[data-status]', page);
    s.className = `tag ${image.status}`;
    s.textContent = STATUS[image.status] + (admin && image.assigned_to ? `, giao cho ${image.assigned_to}` : '');
    $('[data-who]', page).textContent = whoLine(image);
    $('[data-who]', page).title = whoTitle(image);
    $('[data-pos]', page).textContent = reviewing ? `${idx + 1}/${list.length}` : `Còn ${remaining} ảnh`;
    $('[data-act=clear]', page).hidden = image.status === 'unlabeled' || readOnly;
    $('[data-lockbar]', page).hidden = !readOnly;
    if (readOnly) {
      $('[data-lockmsg]', page).innerHTML = frozen
        ? 'Ảnh này đã được duyệt nên chỉ xem được. Cần sửa thì báo quản trị viên trả lại.'
        : `Ảnh này đang được <b>${esc(image.locked_by || 'người khác')}</b> mở. Bạn đang ở chế độ chỉ xem, thay đổi sẽ không được lưu.`;
      $('[data-act=takeover]', page).hidden = frozen;
    }
    $('[data-act=save]', page).disabled = readOnly;
    $('[data-act=reject]', page)?.toggleAttribute('disabled', readOnly || image.status !== 'in_review');
    // Ghi chú khi bị trả lại: người gán cần biết phải sửa gì; quản trị viên thấy để đối chiếu.
    const note = $('[data-notice]', page);
    const showNote = image.review_note && (image.status === 'rejected' || (reviewMode && image.status === 'in_review'));
    note.hidden = !showNote;
    if (showNote) {
      note.innerHTML = image.status === 'rejected'
        ? `<b>Bị trả lại</b> bởi ${esc(image.reviewed_by)}: ${esc(image.review_note)}`
        : `Lần trước ${esc(image.reviewed_by)} đã trả lại: ${esc(image.review_note)}`;
    }
  }

  /** Giữ chỗ ảnh; nếu người khác đang giữ thì chuyển sang chỉ xem. */
  async function acquire(id, force = false) {
    frozen = false;
    try {
      image = await api.lock(id, force);
      readOnly = false;
    } catch (e) {
      if (e.status !== 409) throw e;
      image = await api.image(id);
      readOnly = true;
    }
    if (!admin && image.status === 'labeled') {
      // Đã duyệt: người gán chỉ xem. Trả chỗ ngay để không giữ ảnh vô ích.
      if (!readOnly) api.unlock(id).catch(() => { });
      readOnly = frozen = true;
    }
  }

  function release() {
    if (image && !readOnly) api.unlock(image.id).catch(() => { });
  }

  // Thanh trên chỉ ghi tên ("Gán bởi an, sửa cuối bởi binh"); thời gian đầy đủ nằm trong tooltip.
  // Chỉ nhắc người sửa khi khác người gán hoặc đã sửa sau lần gán.
  function whoParts(img) {
    const parts = [];
    if (img.labeled_by) parts.push(['Gán bởi', img.labeled_by, img.labeled_at]);
    const editedLater = img.edited_at && img.labeled_at && new Date(img.edited_at) - new Date(img.labeled_at) > 1000;
    if (img.edited_by && (img.edited_by !== img.labeled_by || editedLater || !img.labeled_by)) {
      parts.push([parts.length ? 'sửa cuối bởi' : 'Sửa cuối bởi', img.edited_by, img.edited_at]);
    }
    return parts;
  }
  const whoLine = img => whoParts(img).map(([v, n]) => `${v} ${n}`).join(', ');
  const whoTitle = img => whoParts(img).map(([v, n, t]) => `${v} ${n}${t ? ` lúc ${fmtDate(t)}` : ''}`).join('\n');

  const ACTION = { label: 'gán nhãn', edit: 'sửa nhãn', clear: 'bỏ nhãn', approve: 'duyệt', reject: 'trả lại', import: 'nhập từ dataset' };
  async function renderHistory() {
    const list = $('[data-hlist]', page);
    try {
      const revs = await api.history(image.id);
      $('[data-hcount]', page).textContent = revs.length ? `${revs.length} lần` : '';
      list.innerHTML = revs.length ? revs.map(r => `
        <div class="hrow ${r.action}"><span><b>${esc(r.user)}</b> ${ACTION[r.action]}${['clear', 'reject'].includes(r.action) ? '' : `, ${unit(r.object_count)}`}</span>
          <span class="muted">${fmtDate(r.created_at)}</span></div>`).join('')
        : '<span class="muted">Chưa có ai gán ảnh này.</span>';
    } catch { list.innerHTML = '<span class="muted">Không tải được lịch sử.</span>'; }
  }

  async function open(id) {
    if (image && image.id !== id) release();
    await acquire(id);
    if (!alive) { release(); return; }
    const at = list.indexOf(id);
    if (at >= 0) idx = at;
    else list.splice(++idx, 0, id); // ảnh mới trong phiên: đặt ngay sau ảnh đang xem
    await editor.load(api.fileUrl(id), image.annotations);
    renderBar();
    renderSide();
    renderHistory();
    // Chỉ ghi lại đường dẫn khi người dùng vẫn đang ở trình gán nhãn (ảnh tải xong sau khi họ
    // đã bấm quay lại thì không được kéo họ về trang ảnh).
    if (location.hash.startsWith(`#/p/${ctx.pid}/label/`)) {
      history.replaceState(null, '', `#/p/${ctx.pid}/label/${id}?queue=${queue}${fromTab ? `&assignee=${encodeURIComponent(fromTab)}` : ''}`);
    }
    // Danh sách gốc dùng để nháy viền ảnh vừa xem khi quay lại.
    try { sessionStorage.setItem('last-image', id); } catch { }
    const nxt = list[idx + 1];
    if (nxt) new Image().src = api.fileUrl(nxt);
  }

  async function save({ quiet = false } = {}) {
    if (!image) return true;
    if (readOnly) {
      toast(frozen ? 'Ảnh đã được duyệt, không sửa được nữa.' : `Ảnh đang được ${image.locked_by || 'người khác'} mở. Bấm "Giành quyền sửa" nếu muốn sửa.`, 'warn');
      return false;
    }
    const err = editor.tool.validate();
    if (err) { toast(err, 'warn'); return false; }
    try {
      image = await api.saveAnnotations(image.id, editor.getObjects(), reviewMode);
      editor.dirty = false;
      // Lưu xong server đã trả chỗ; giữ lại vì người gán có thể còn sửa tiếp ảnh này.
      api.lock(image.id).catch(() => { });
      renderBar();
      renderSide();
      renderHistory();
      if (!quiet) {
        const st = $('[data-save]', page);
        st.className = 'savestate ok';
        st.textContent = `${reviewMode ? 'Đã duyệt' : 'Đã lưu, chờ duyệt'}: ${unit(image.object_count)}`;
      }
      ctx.refreshProject().then(p => {
        if (p && !reviewing) { remaining = remainingOf(p); renderBar(); }
      });
      return true;
    } catch (e) {
      if (e.status === 409) { readOnly = true; image = await api.image(image.id); renderBar(); }
      toast('Không lưu được: ' + e.message, 'err');
      return false;
    }
  }

  async function next({ saveFirst }) {
    // "Tiếp" luôn lưu (khi được sửa): ảnh không có gì vẫn được xác nhận là ảnh nền.
    if (!readOnly && (saveFirst || editor.dirty) && !(await save({ quiet: true }))) return;
    if (idx + 1 < list.length) return open(list[idx + 1]);
    if (reviewing) return toast('Đây là ảnh cuối cùng', 'warn');
    const img = await api.claimNext(ctx.pid, list);
    if (img) return open(img.id);
    release();
    toast(admin
      ? 'Không còn ảnh chưa giao để tự gán. Xem mục Cần review hoặc Phân công.'
      : 'Bạn đã làm hết ảnh được giao. Ảnh đang chờ quản trị viên duyệt.', 'ok', 6000);
    ctx.navigate(`#/p/${ctx.pid}/review`);
  }

  async function prev() {
    if (!readOnly && editor.dirty && !(await save({ quiet: true }))) return;
    if (idx <= 0) return toast(reviewing ? 'Đây là ảnh đầu tiên' : 'Đây là ảnh đầu tiên trong phiên', 'warn');
    await open(list[idx - 1]);
  }

  /** Chạy một thao tác chuyển ảnh, không cho bấm chồng lên nhau. */
  const guard = fn => async (...args) => {
    if (busy) return;
    busy = true;
    try { await fn(...args); } catch (e) { toast(e.message, 'err'); } finally { busy = false; }
  };

  const actions = {
    prev: guard(prev),
    next: guard(() => next({ saveFirst: saveOnNext })),
    skip: guard(() => next({ saveFirst: false })),
    save: () => save(),
    fit: () => editor.fit(),
    hide: () => editor.toggleLabels(),
    takeover: guard(async () => {
      await acquire(image.id, true);
      await editor.load(api.fileUrl(image.id), image.annotations);
      renderBar(); renderSide();
      toast('Bạn đã giành quyền sửa ảnh này');
    }),
    reject: () => openDialog(`
        <h3>Trả lại cho ${esc(image.assigned_to || image.labeled_by || 'người gán')}</h3>
        <p class="muted">Ảnh quay về mục "Việc của tôi" của họ, kèm ghi chú này.</p>
        <label class="field">Cần sửa gì <textarea name="note" required maxlength="1000" rows="3"
          placeholder="Ví dụ: điểm dưới trái lệch ra ngoài, thiếu một đối tượng bên phải"></textarea></label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
          <button class="danger" type="submit">Trả lại</button></div>`,
      async form => {
        await api.reject(image.id, form.note.value.trim());
        editor.dirty = false;
        toast(`Đã trả lại ${image.filename}`);
        ctx.refreshProject();
        return true;
      }).then(ok => { if (ok) actions.skip(); }),
    clear: async () => {
      try {
        image = await api.clearAnnotations(image.id);
        await editor.load(api.fileUrl(image.id), []);
        renderBar(); renderSide(); renderHistory();
        toast('Đã đưa ảnh về "chưa gán nhãn"');
        ctx.refreshProject();
      } catch (e) { toast(e.message, 'err'); }
    },
  };
  page.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { b.blur(); actions[b.dataset.act](); }));

  // Gia hạn chỗ giữ mỗi phút khi còn mở ảnh (chỗ giữ tự hết hạn sau 5 phút).
  const heartbeat = setInterval(async () => {
    if (!image || readOnly || document.hidden) return;
    try { await api.lock(image.id); } catch (e) {
      if (e.status !== 409) return;
      readOnly = true;
      image = await api.image(image.id);
      renderBar();
      toast(`${image.locked_by || 'Người khác'} đã giành quyền sửa ảnh này`, 'warn');
    }
  }, 60_000);

  const onKey = e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.closest?.('dialog')) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 's') { e.preventDefault(); actions.save(); return; }
    if (!mod && !e.altKey) {
      // Enter khi đang vẽ dở đa giác / pose: chốt đối tượng, không chuyển ảnh.
      if (k === 'enter' && editor.tool.finishPending?.()) { e.preventDefault(); return; }
      if (k === 'arrowright' || k === 'enter' || (letterNav && k === 'd')) { e.preventDefault(); actions.next(); return; }
      if (k === 'arrowleft' || (letterNav && k === 'a')) { e.preventDefault(); actions.prev(); return; }
    }
    if (e.repeat && k !== 'arrowright' && k !== 'arrowleft') return;
    if (editor.key(e)) e.preventDefault();
  };
  const onKeyUp = e => editor.keyup(e);
  const onUnload = e => {
    if (image && !readOnly) api.unlockOnExit(image.id);
    if (editor.dirty) { e.preventDefault(); e.returnValue = ''; }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('beforeunload', onUnload);

  const teardown = () => {
    clearInterval(heartbeat);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('beforeunload', onUnload);
    editor.destroy();
  };

  // "next" = để server chọn ảnh trống kế tiếp (nút "Bắt đầu gán nhãn").
  const first = ctx.imageId === 'next' ? (await api.claimNext(ctx.pid, []))?.id : ctx.imageId;
  if (!first) {
    teardown();
    toast('Không còn ảnh trống để gán: đã gán hết, hoặc phần còn lại đang có người khác gán.', 'ok', 6000);
    ctx.navigate(`#/p/${ctx.pid}/${queue}`);
    return {};
  }
  await open(first);

  // ---------- realtime ----------
  const VERB = { approved: 'duyệt', rejected: 'trả lại', saved: 'lưu', cleared: 'bỏ nhãn' };
  let countTimer = null;
  const onLive = guard(async (event, data, mine) => {
    // Số "Còn N ảnh" theo kịp khi có người giao / thu hồi / làm xong ảnh.
    if (!reviewing && !mine) {
      clearTimeout(countTimer);
      countTimer = setTimeout(async () => { remaining = remainingOf(await api.project(ctx.pid)); if (image) renderBar(); }, 500);
    }
    if (mine || !image) return;
    const touches = data.image_id === image.id || data.image_ids?.includes(image.id);
    if (!touches) return;
    const by = data.by || 'Quản trị viên';

    if (data.kind === 'lock' && data.locked_by && data.locked_by !== session.user.username) {
      if (readOnly) return;
      readOnly = true;
      image = await api.image(image.id);
      renderBar();
      toast(`${data.locked_by} vừa giành quyền mở ảnh này. Bạn chuyển sang chế độ chỉ xem.`, 'warn', 6000);
      return;
    }
    if (data.kind === 'unlock' && readOnly && !frozen) {
      // Người đang giữ vừa đóng ảnh -> thử lấy quyền sửa luôn.
      await acquire(image.id);
      if (!readOnly && !editor.dirty) await editor.load(api.fileUrl(image.id), image.annotations);
      renderBar(); renderSide();
      if (!readOnly) toast('Ảnh đã trống, bạn có thể sửa.');
      return;
    }
    if (data.kind === 'deleted') {
      toast(`${by} đã xoá ảnh này khỏi project.`, 'warn', 6000);
      editor.dirty = false;
      return actions.skip();
    }
    if (VERB[data.kind]) {
      if (editor.dirty) {
        toast(`${by} vừa ${VERB[data.kind]} ảnh này. Thay đổi của bạn chưa lưu, lưu lại sẽ ghi đè.`, 'warn', 8000);
        return;
      }
      await acquire(image.id); // trạng thái mới (VD đã duyệt -> người gán chỉ xem được)
      await editor.load(api.fileUrl(image.id), image.annotations);
      renderBar(); renderSide(); renderHistory();
      toast(`${by} vừa ${VERB[data.kind]} ảnh này.`, data.kind === 'rejected' ? 'warn' : 'ok', 6000);
    }
  });

  return {
    onLive,
    update: guard(async id => {
      if (!id || id === image?.id) return;
      if (!readOnly && editor.dirty && !(await save({ quiet: true }))) return;
      await open(id);
    }),
    async unmount() {
      alive = false;
      // Rời trang khi còn thay đổi -> tự lưu (nếu hợp lệ), rồi trả chỗ.
      if (!readOnly && editor.dirty && !editor.tool.validate()) await save({ quiet: true });
      release();
      teardown();
    },
  };
}
