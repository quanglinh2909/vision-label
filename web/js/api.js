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
  upload(pid, files, annotations = null, approved = false) {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    if (annotations && Object.keys(annotations).length) fd.append('annotations', JSON.stringify(annotations));
    if (approved) fd.append('approved', 'true');
    return req('POST', `/projects/${pid}/images`, fd);
  },
  // queue: unlabeled | todo | review | labeled. assignee: chỉ ảnh giao cho người này (quản trị viên).
  // Bộ lọc (xem filterParams ở tiles.js): cls / missing = có (chưa có) lớp đó; count + op = số đối tượng.
  images: (pid, { queue, assignee, limit = 100, offset = 0, ...filter } = {}) => req('GET', `/projects/${pid}/images${qs({ queue, assignee, limit, offset, ...filter })}`),
  refs: (pid, queue, assignee, filter = {}) => req('GET', `/projects/${pid}/image-refs${qs({ queue, assignee, ...filter })}`),
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
  /** Nhóm ảnh trùng: {images, extra, groups: [[ảnh giữ, ...ảnh thừa]]}. */
  duplicates: (pid, body) => req('POST', `/projects/${pid}/duplicates`, body),
  deleteImages: (pid, ids) => req('POST', `/projects/${pid}/images/delete`, { ids }),
  /** Xoá cả danh sách chưa gán nhãn; assignee như khi xem ('' = chưa giao, undefined = mọi người). */
  deleteAllUnlabeled: (pid, assignee) => req('POST', `/projects/${pid}/images/delete`, { all: true, queue: 'unlabeled', assignee }),
  fileUrl: id => `/api/images/${id}/file`,
  thumbUrl: id => `/api/images/${id}/thumb`,

  datasets: pid => req('GET', `/projects/${pid}/datasets`),
  datasetPlan: (pid, format, includeReview = false) => req('GET', `/projects/${pid}/datasets/plan${qs({ format, include_review: includeReview || undefined })}`),
  createDataset: (pid, body) => req('POST', `/projects/${pid}/datasets`, body),
  deleteDataset: id => req('DELETE', `/datasets/${id}`),
  drive: () => req('GET', '/drive'),
  driveSave: body => req('PUT', '/drive', body),
  driveConnect: () => req('POST', '/drive/connect'),
  driveDisconnect: () => req('POST', '/drive/disconnect'),
  driveUpload: id => req('POST', `/datasets/${id}/drive`),
  driveFiles: () => req('GET', '/drive/files'),
  /** Tải một bản zip từ Drive (qua server) về trình duyệt, báo tiến độ theo byte. */
  async driveDownload(id, onProgress) {
    const r = await fetch(`/api/drive/files/${encodeURIComponent(id)}/download`);
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { msg = (await r.json()).message || msg; } catch { /* không phải JSON */ }
      throw Object.assign(new Error(msg), { status: r.status });
    }
    const total = +r.headers.get('Content-Length') || 0, reader = r.body.getReader(), parts = [];
    for (let got = 0; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress?.(got, total);
    }
    return new Blob(parts, { type: 'application/zip' });
  },
  gpuServers: () => req('GET', '/gpu/servers'),
  createGpuServer: body => req('POST', '/gpu/servers', body),
  updateGpuServer: (id, body) => req('PATCH', `/gpu/servers/${id}`, body),
  deleteGpuServer: id => req('DELETE', `/gpu/servers/${id}`),
  testGpuServer: id => req('POST', `/gpu/servers/${id}/test`),
  setupGpuServer: (id, locate) => req('POST', `/gpu/servers/${id}/setup`, { locate }),
  releaseGpuServer: id => req('POST', `/gpu/servers/${id}/release`),
  gpuJobs: projectId => req('GET', `/gpu/jobs${qs({ project_id: projectId })}`),
  /** Một việc, kèm lịch sử chỉ số theo từng epoch. */
  gpuJob: id => req('GET', `/gpu/jobs/${id}`),
  /** Link tải best.pt của một lần train (server lấy file từ máy GPU rồi gửi về). */
  jobWeightsUrl: id => `/api/gpu/jobs/${id}/weights`,
  saveModel: (jobId, body) => req('POST', `/gpu/jobs/${jobId}/save`, body),
  models: pid => req('GET', `/projects/${pid}/models`),
  updateModel: (id, body) => req('PATCH', `/gpu/models/${id}`, body),
  deleteModel: id => req('DELETE', `/gpu/models/${id}`),
  modelFileUrl: id => `/api/gpu/models/${id}/file`,
  deployModel: (id, serverId) => req('POST', `/gpu/models/${id}/deploy`, { server_id: serverId }),
  /** Kiểm tra model với một ảnh: fd có file, server_id, engine, model, conf, iou, imgsz, prompts. */
  testImage: fd => req('POST', '/gpu/test/image', fd),
  /** Gửi video lên server GPU, báo tiến độ (XHR vì fetch chưa báo được tiến độ upload). Trả {source}. */
  testVideo(fd, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/gpu/test/video');
      x.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => {
        let j = null;
        try { j = JSON.parse(x.responseText); } catch { /* không phải JSON */ }
        if (x.status >= 200 && x.status < 300) resolve(j);
        else reject(Object.assign(new Error(j?.message || `${x.status} ${x.statusText}`), { status: x.status }));
      };
      x.onerror = () => reject(new Error('Mất kết nối khi gửi video'));
      x.send(fd);
    });
  },
  /** Server GPU tự tải video từ link http(s); trả {source} như khi gửi file. */
  testVideoUrl: (serverId, url) => req('POST', '/gpu/test/video-url', { server_id: serverId, url }),
  testVideos: serverId => req('GET', `/gpu/test/videos${qs({ server_id: serverId })}`),
  testDeleteVideo: (serverId, path) => req('POST', '/gpu/test/videos/delete', { server_id: serverId, path }),
  testStreamUrl: params => `/api/gpu/test/stream${qs(params)}`,
  testStats: session => req('GET', `/gpu/test/stats${qs({ session })}`),
  testShots: (session, after = 0) => req('GET', `/gpu/test/shots${qs({ session, after })}`),
  testShotUrl: (session, id, kind = 'thumb') => `/api/gpu/test/shot${qs({ session, id, kind: kind === 'thumb' ? undefined : kind })}`,
  testImport: body => req('POST', '/gpu/test/import', body),
  testStop: session => req('POST', `/gpu/test/stop${qs({ session })}`),
  useModel: (id, serverId) => req('POST', `/gpu/models/${id}/use`, { server_id: serverId }),
  stopGpuJob: id => req('POST', `/gpu/jobs/${id}/stop`),
  recheckGpuJob: id => req('POST', `/gpu/jobs/${id}/recheck`),
  deleteGpuJob: id => req('DELETE', `/gpu/jobs/${id}`),
  train: (pid, body) => req('POST', `/projects/${pid}/train`, body),
  autolabelConfig: pid => req('GET', `/projects/${pid}/autolabel`),
  saveAutolabel: (pid, body) => req('PUT', `/projects/${pid}/autolabel`, body),
  warmupAutolabel: pid => req('POST', `/projects/${pid}/autolabel/warmup`),
  unloadAutolabel: pid => req('POST', `/projects/${pid}/autolabel/unload`),
  autolabelAvailable: pid => req('GET', `/projects/${pid}/autolabel/available`),
  /** Chạy model cho một ảnh; kết quả chưa được lưu. */
  autolabel: id => req('POST', `/images/${id}/autolabel`),
  /** Link tải kèm key: dùng được cả khi không đăng nhập (curl, Colab). */
  downloadUrl: d => `/api/datasets/${d.id}/download?key=${encodeURIComponent(d.download_key)}`,
};
