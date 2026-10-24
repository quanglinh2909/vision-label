// Gọi REST API của backend (src/api/...). Mọi lỗi ném ra Error có message đọc được
// (kèm .status để phân biệt 401 = hết phiên, 409 = ảnh đang có người khác giữ).
// Phiên đăng nhập nằm trong cookie HttpOnly, trình duyệt tự gửi kèm — JS không chạm vào.

// Các API được phép trả 401 mà không đẩy người dùng về màn đăng nhập.
const AUTH_PATHS = ['/auth/status', '/auth/login', '/auth/setup', '/auth/password'];

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch('/api' + path, opts);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      msg = j.message || (Array.isArray(j.detail) ? j.detail.map(d => d.msg).join('; ') : j.detail) || msg;
    } catch { /* body không phải JSON */ }
    if (r.status === 401 && !AUTH_PATHS.includes(path)) window.dispatchEvent(new Event('auth-required'));
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r.status === 204 ? null : r.json();
}

const qs = params => {
  // Chỉ bỏ undefined/null; chuỗi rỗng vẫn gửi (assignee='' = ảnh chưa giao cho ai).
  const p = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  return p.toString() ? '?' + p : '';
};

export const api = {
  authStatus: () => req('GET', '/auth/status'),
  login: (username, password) => req('POST', '/auth/login', { username, password }),
  setup: (username, password) => req('POST', '/auth/setup', { username, password }),
  logout: () => req('POST', '/auth/logout'),
  changePassword: (current_password, new_password) => req('POST', '/auth/password', { current_password, new_password }),

  users: () => req('GET', '/users'),
  createUser: body => req('POST', '/users', body),
  updateUser: (id, body) => req('PATCH', `/users/${id}`, body),
  deleteUser: id => req('DELETE', `/users/${id}`),

  projects: () => req('GET', '/projects'),
  project: id => req('GET', `/projects/${id}`),
  createProject: body => req('POST', '/projects', body),
  updateProject: (id, body) => req('PATCH', `/projects/${id}`, body),
  deleteProject: id => req('DELETE', `/projects/${id}`),
  classUsage: id => req('GET', `/projects/${id}/class-usage`),

  /** annotations (nhập dataset có sẵn): {tên file: [đối tượng]} -> ảnh đó vào thẳng Cần review. */
  upload(pid, files, annotations = null) {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    if (annotations && Object.keys(annotations).length) fd.append('annotations', JSON.stringify(annotations));
    return req('POST', `/projects/${pid}/images`, fd);
  },
  // queue: unlabeled | todo | review | labeled. assignee: chỉ ảnh giao cho người này (quản trị viên).
  images: (pid, { queue, assignee, limit = 100, offset = 0 } = {}) => req('GET', `/projects/${pid}/images${qs({ queue, assignee, limit, offset })}`),
  refs: (pid, queue, assignee) => req('GET', `/projects/${pid}/image-refs${qs({ queue, assignee })}`),
  assignments: pid => req('GET', `/projects/${pid}/assignments`),
  assign: (pid, username, count) => req('POST', `/projects/${pid}/assignments`, { username, count }),
  revoke: (pid, username, scope = 'unlabeled') => req('POST', `/projects/${pid}/assignments/revoke`, { username, scope }),
  approve: (pid, ids) => req('POST', `/projects/${pid}/approve`, { ids }),
  reject: (id, note) => req('POST', `/images/${id}/reject`, { note }),
  rejectMany: (pid, ids, note) => req('POST', `/projects/${pid}/reject`, { ids, note }),
  image: id => req('GET', `/images/${id}`),
  claimNext: (pid, exclude = []) => req('POST', `/projects/${pid}/claim-next`, { exclude }),
  lock: (id, force = false) => req('POST', `/images/${id}/lock`, { force }),
  unlock: id => req('POST', `/images/${id}/unlock`),
  /** Trả ảnh khi đóng tab: keepalive để request vẫn đi sau khi trang đã tắt. */
  unlockOnExit: id => fetch(`/api/images/${id}/unlock`, { method: 'POST', keepalive: true }),
  history: id => req('GET', `/images/${id}/history`),
  labelerStats: pid => req('GET', `/projects/${pid}/labelers`),
  saveAnnotations: (id, objects, approve = false) => req('PUT', `/images/${id}/annotations`, { objects, approve }),
  clearAnnotations: id => req('DELETE', `/images/${id}/annotations`),
  deleteImage: id => req('DELETE', `/images/${id}`),
  fileUrl: id => `/api/images/${id}/file`,
  thumbUrl: id => `/api/images/${id}/thumb`,

  datasets: pid => req('GET', `/projects/${pid}/datasets`),
  datasetPlan: (pid, format) => req('GET', `/projects/${pid}/datasets/plan${qs({ format })}`),
  createDataset: (pid, body) => req('POST', `/projects/${pid}/datasets`, body),
  deleteDataset: id => req('DELETE', `/datasets/${id}`),
  drive: () => req('GET', '/drive'),
  driveSave: body => req('PUT', '/drive', body),
  driveConnect: () => req('POST', '/drive/connect'),
  driveDisconnect: () => req('POST', '/drive/disconnect'),
  driveUpload: id => req('POST', `/datasets/${id}/drive`),
  /** Link tải kèm key: dùng được cả khi không đăng nhập (curl, Colab). */
  downloadUrl: d => `/api/datasets/${d.id}/download?key=${encodeURIComponent(d.download_key)}`,
};
