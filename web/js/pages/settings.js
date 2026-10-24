// Cài đặt project: tên, mô tả; xoá project. Lớp cấu hình ở mục Lớp (pages/classes.js).

import { api } from '../api.js';
import { $, esc, h, TASKS, toast } from '../ui.js';

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

  el.replaceChildren(page);
  return {};
}
