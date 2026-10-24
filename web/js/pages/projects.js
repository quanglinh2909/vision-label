// Trang đầu: tạo project mới (chọn loại bài toán) + danh sách project đã có.

import { api } from '../api.js';
import { accountBar } from '../account.js';
import { $, $$, esc, fmtDate, h, isAdmin, plate, TASKS, toast } from '../ui.js';

export async function mount(el) {
  const projects = await api.projects();
  const page = h(`
    <div class="home">
      <header>
        ${plate('VisionLabel', 'lg')}
        <p>Gán nhãn ảnh, xuất dataset để train YOLO, MobileNet, ResNet.</p>
        <span class="spacer"></span>
        <div data-account></div>
      </header>

      <div class="home-grid ${isAdmin() ? '' : 'solo'}">
        <form class="create" autocomplete="off" ${isAdmin() ? '' : 'hidden'}>
          <h2>Tạo project</h2>
          <div class="task-pick" role="group" aria-label="Loại bài toán">
            ${Object.entries(TASKS).map(([key, t]) => `
              <button type="button" class="task-opt" data-task="${key}" aria-pressed="false">
                ${t.figure}
                <div><b>${esc(t.label)}</b><span>${esc(t.desc)}</span></div>
              </button>`).join('')}
          </div>
          <label class="field">Tên project
            <input type="text" name="name" required maxlength="100" placeholder="Biển số xe máy Hà Nội"></label>
          <label class="field">Mô tả <span class="hint">Không bắt buộc.</span>
            <input type="text" name="description"></label>
          <p class="muted hint-line">Tạo xong, bạn đặt các lớp ở mục <b>Lớp</b> của project.</p>
          <button class="primary" type="submit">Tạo project</button>
        </form>

        <section class="projects">
          <div class="row"><h2>Project của bạn</h2><span class="muted">${projects.length || ''}</span></div>
          <div class="proj-list"></div>
        </section>
      </div>
    </div>`);

  $('[data-account]', page).replaceWith(accountBar());

  let task = 'detect';
  const form = $('form', page);
  const pick = key => {
    task = key;
    $$('.task-opt', page).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.task === key)));
  };
  $$('.task-opt', page).forEach(b => b.addEventListener('click', () => pick(b.dataset.task)));
  pick(task);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const p = await api.createProject({ name: form.name.value.trim(), task, description: form.description.value.trim() });
      toast(`Đã tạo project "${p.name}". Giờ thêm các lớp.`);
      location.hash = `#/p/${p.id}/classes`;
    } catch (err) { toast(err.message, 'err'); }
  });

  const list = $('.proj-list', page);
  if (!projects.length) {
    list.innerHTML = isAdmin()
      ? '<p class="empty">Chưa có project nào. Chọn loại bài toán và đặt tên ở khung bên cạnh để bắt đầu.</p>'
      : '<p class="empty">Chưa có project nào. Quản trị viên tạo project rồi bạn sẽ thấy ở đây.</p>';
  }
  for (const p of projects) {
    const pct = p.image_count ? Math.round((p.labeled_count / p.image_count) * 100) : 0;
    list.appendChild(h(`
      <a class="proj" href="#/p/${p.id}/${!isAdmin() ? 'todo' : !p.classes.length ? 'classes' : p.image_count ? 'unlabeled' : 'upload'}" title="${esc(p.name)}">
        ${plate(p.name)}
        <span class="tag ${p.task}-task">${esc(TASKS[p.task].label)}${p.classes.length ? `, ${p.classes.length} lớp` : ', chưa có lớp'}</span>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
        <div class="bar"><div style="width:${pct}%"></div></div>
        <div class="stats">
          ${isAdmin() ? `
          <span><b>${p.labeled_count}</b> / ${p.image_count} ảnh đã duyệt</span>
          ${p.review_count ? `<span><b>${p.review_count}</b> chờ duyệt</span>` : ''}
          <span><b>${p.dataset_count}</b> dataset</span>` : `
          <span><b>${p.unlabeled_count + p.rejected_count}</b> ảnh cần gán</span>
          <span><b>${p.labeled_count}</b> / ${p.image_count} đã duyệt</span>`}
          <span>Sửa lúc ${fmtDate(p.updated_at)}</span>
        </div>
      </a>`));
  }
  el.replaceChildren(page);
  return {};
}
