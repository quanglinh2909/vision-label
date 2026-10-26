// Cài đặt project: tên, mô tả; xoá project. Lớp cấu hình ở mục Lớp (pages/classes.js).

import { api } from '../api.js';
import { $, esc, h, openDialog, TASKS, toast } from '../ui.js';
import { STATUS } from '../tiles.js';

export async function mount(el, ctx) {
  const p = ctx.project;
  const page = h(`
    <div class="page" style="max-width:780px">
      <div class="page-head"><h2>Cài đặt</h2></div>
      <form class="panel" autocomplete="off">
        <label class="field">Tên project <input type="text" name="name" maxlength="100" required value="${esc(p.name)}"></label>
        <label class="field">Mô tả <input type="text" name="description" value="${esc(p.description)}"></label>
        <div class="field">Loại bài toán
          <span class="tag ${p.task}-task">${esc(TASKS[p.task].label)}</span>
          <span class="hint">Không đổi được sau khi tạo. Các lớp đặt ở mục <a href="#/p/${p.id}/classes">Lớp</a>.</span></div>
        <div class="row"><button class="primary" type="submit">Lưu thay đổi</button></div>
      </form>
      <section class="panel" data-dups>
        <h3>Ảnh trùng lặp</h3>
        <p class="muted">Tìm ảnh trùng trong project (VD Roboflow xuất cùng một ảnh thành nhiều bản tăng cường
          <code>abc_jpg.rf.1a2b….jpg</code>, <code>abc_jpg.rf.9f8e….jpg</code>), giữ 1 ảnh mỗi nhóm và xoá phần thừa.</p>
        <div class="row">
          <label class="check"><input type="checkbox" name="dup_name" checked> Cùng tên gốc Roboflow</label>
          <label class="check" title="So dấu vân tay ảnh (dHash) và bắt buộc cùng bộ nhãn: bắt được ảnh trùng nhưng khác tên. Lần đầu quét phải đọc mọi ảnh, hơi lâu.">
            <input type="checkbox" name="dup_image" checked> Hình giống nhau và cùng nhãn, lệch tối đa</label>
          <input type="number" name="dup_threshold" min="0" max="12" value="2" style="width:70px" title="Số bit (trên 64) được lệch. 0 = giống hệt; cao hơn = gom cả ảnh hơi khác, dễ gom nhầm">
          <span class="muted small">bit</span>
          <span class="spacer"></span>
          <button class="primary" type="button" data-dup-scan>Tìm ảnh trùng</button>
        </div>
        <div data-dup-result></div>
      </section>
      <section class="panel" style="border-color:#7a3430">
        <h3>Xoá project</h3>
        <p class="muted">Xoá toàn bộ ảnh đã tải lên và nhãn của project. Các dataset đã xuất trong thư mục <code>dataset/</code> vẫn được giữ lại.</p>
        <div class="row">
          <input type="text" data-confirm placeholder="Gõ đúng tên project để xác nhận" style="flex:1;min-width:220px">
          <button class="danger" data-del disabled>Xoá project</button>
        </div>
      </section>
    </div>`);

  const form = $('form', page);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.updateProject(p.id, {
        name: form.name.value.trim(),
        description: form.description.value.trim(),
      });
      toast('Đã lưu thay đổi');
      // Dựng lại menu trái với tên mới, và cập nhật tên dùng cho ô xác nhận xoá.
      Object.assign(p, await ctx.refreshProject());
    } catch (err) { toast(err.message, 'err'); }
  });

  const confirm = $('[data-confirm]', page), del = $('[data-del]', page);
  confirm.addEventListener('input', () => { del.disabled = confirm.value.trim() !== p.name; });
  del.addEventListener('click', async () => {
    try { await api.deleteProject(p.id); toast(`Đã xoá project "${p.name}"`); location.hash = '#/'; }
    catch (err) { toast(err.message, 'err'); }
  });

  // ---------- ảnh trùng lặp ----------
  // Mỗi nhóm: ảnh đầu là ảnh được giữ (server chọn: đã duyệt > chờ duyệt > ..., nhiều nhãn hơn); bấm ảnh khác để đổi.
  const dupBox = $('[data-dup-result]', page);
  let groups = [], keep = [];
  const SHOW = 60;
  const extraIds = () => groups.flatMap((g, i) => g.filter(it => it.id !== keep[i]).map(it => it.id));

  function renderDups(shown = SHOW) {
    const n = extraIds().length;
    if (!groups.length) { dupBox.innerHTML = '<p class="muted">Không tìm thấy ảnh trùng nào.</p>'; return; }
    dupBox.innerHTML = `
      <div class="row"><b>${groups.length} nhóm trùng, ${n} ảnh thừa</b>
        <span class="muted small">Viền vàng = ảnh được giữ; bấm ảnh khác trong nhóm để giữ ảnh đó.</span>
        <span class="spacer"></span><button class="danger" type="button" data-dup-del>Xoá ${n} ảnh thừa</button></div>
      <div class="dup-groups">${groups.slice(0, shown).map((g, i) => `
        <div class="dup-group">${g.map(it => `
          <button type="button" class="dup-item ${it.id === keep[i] ? 'keep' : ''}" data-g="${i}" data-id="${it.id}"
            title="${esc(it.filename)}\n${STATUS[it.status]}, ${it.object_count} đối tượng${it.assigned_to ? `, giao cho ${esc(it.assigned_to)}` : ''}">
            <img loading="lazy" src="${api.thumbUrl(it.id)}" alt="">
            <span>${it.id === keep[i] ? '★ giữ' : 'xoá'} · ${STATUS[it.status]} · ${it.object_count}</span>
          </button>`).join('')}</div>`).join('')}</div>
      ${groups.length > shown ? `<button class="sm" type="button" data-dup-more>Xem thêm ${Math.min(SHOW, groups.length - shown)} nhóm (còn ${groups.length - shown})</button>` : ''}`;
    dupBox.querySelectorAll('.dup-item').forEach(b => b.addEventListener('click', () => { keep[+b.dataset.g] = b.dataset.id; renderDups(shown); }));
    $('[data-dup-more]', dupBox)?.addEventListener('click', () => renderDups(shown + SHOW));
    $('[data-dup-del]', dupBox).addEventListener('click', removeExtra);
  }

  async function removeExtra() {
    const ids = extraIds();
    const ok = await openDialog(`
      <h3>Xoá ${ids.length} ảnh thừa</h3>
      <p>Mỗi nhóm giữ lại 1 ảnh (viền vàng), xoá ${ids.length} ảnh còn lại cùng nhãn và lịch sử của chúng. Không hoàn tác được.</p>
      <label class="field">Gõ <b>${ids.length}</b> để xác nhận <input type="text" name="confirm" required autocomplete="off" inputmode="numeric"></label>
      <div class="row"><span class="spacer"></span><button type="button" data-cancel>Huỷ</button>
        <button class="danger" type="submit">Xoá ${ids.length} ảnh</button></div>`,
    async f => { if (f.confirm.value.trim() !== String(ids.length)) throw new Error(`Gõ đúng ${ids.length} để xác nhận`); return true; });
    if (!ok) return;
    const btn = $('[data-dup-del]', dupBox);
    let done = 0, skipped = 0;
    btn.disabled = true;
    try {
      for (let i = 0; i < ids.length; i += 500) { // từng đợt cho có tiến độ, không chờ một request quá lâu
        const r = await api.deleteImages(p.id, ids.slice(i, i + 500));
        done += r.deleted; skipped += r.skipped;
        btn.textContent = `Đang xoá ${Math.min(i + 500, ids.length)} / ${ids.length}…`;
      }
      toast(`Đã xoá ${done} ảnh trùng${skipped ? `, bỏ qua ${skipped} ảnh đang có người mở` : ''}`, skipped ? 'warn' : 'ok', 6000);
    } catch (err) { toast(err.message, 'err'); }
    await ctx.refreshProject();
    scan();
  }

  async function scan() {
    const btn = $('[data-dup-scan]', page);
    const body = {
      by_name: page.querySelector('[name=dup_name]').checked, by_image: page.querySelector('[name=dup_image]').checked,
      threshold: +page.querySelector('[name=dup_threshold]').value || 0,
    };
    if (!body.by_name && !body.by_image) return toast('Chọn ít nhất một cách tìm', 'warn');
    btn.disabled = true; btn.textContent = 'Đang tìm…';
    dupBox.innerHTML = '<p class="muted small">Đang quét ảnh (lần đầu so hình phải đọc mọi ảnh, có thể mất một lúc)…</p>';
    try {
      const r = await api.duplicates(p.id, body);
      groups = r.groups;
      keep = groups.map(g => g[0].id);
      renderDups();
    } catch (err) { dupBox.innerHTML = ''; toast(err.message, 'err'); }
    btn.disabled = false; btn.textContent = 'Tìm ảnh trùng';
  }
  $('[data-dup-scan]', page).addEventListener('click', scan);

  el.replaceChildren(page);
  return {};
}
