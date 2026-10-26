// Danh sách việc chạy trên server GPU (cài môi trường, train), dùng ở trang Server GPU và mục Model AI.
// Tự hỏi lại server mỗi vài giây khi còn việc đang chạy. Log mở / đóng được giữ nguyên khi vẽ lại.

import { api } from './api.js';
import { esc, fmtDate, h, toast } from './ui.js';

export const JOB_STATUS = {
  uploading: { text: 'Đang gửi dữ liệu', cls: 'busy' },
  running: { text: 'Đang chạy', cls: 'busy' },
  done: { text: 'Xong', cls: 'labeled' },
  error: { text: 'Lỗi', cls: 'rejected' },
  stopped: { text: 'Đã dừng', cls: 'unlabeled' },
};
const active = j => j.status === 'uploading' || j.status === 'running';

// ---------- chỉ số train (cột của results.csv Ultralytics, hoặc train.py phân loại) ----------
const KIND = { B: 'khung', P: 'điểm', M: 'mask' };
const LOSS = {
  box_loss: ['khung', 'Lệch vị trí / kích thước khung'],
  cls_loss: ['lớp', 'Đoán nhầm lớp'],
  dfl_loss: ['DFL', 'Độ sắc của cạnh khung (Distribution Focal Loss)'],
  pose_loss: ['điểm', 'Lệch vị trí các điểm pose'],
  kobj_loss: ['điểm thấy', 'Đoán sai điểm thấy / không thấy'],
  seg_loss: ['mask', 'Lệch đường viền mask'],
  loss: ['tổng', 'Loss của model phân loại'],
};
const fmt = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '–' : Number(v).toFixed(Number(v) >= 10 ? 1 : 3));

/** Dòng tóm tắt: loss khung, loss lớp (loss tổng với phân loại), mAP50-95 của từng loại; phân loại: độ chính xác val. */
export function metricsText(m) {
  if (!m || !Object.keys(m).length) return '';
  const parts = [];
  for (const k of ['box_loss', 'cls_loss', 'pose_loss', 'seg_loss', 'loss']) {
    if (`train/${k}` in m) parts.push(`loss ${LOSS[k][0]} <b>${fmt(m[`train/${k}`])}</b>`);
  }
  const maps = Object.keys(KIND).filter(t => `metrics/mAP50-95(${t})` in m);
  if (maps.length) parts.push(`mAP50-95 ${maps.map(t => `${maps.length > 1 ? `${KIND[t]} ` : ''}<b>${fmt(m[`metrics/mAP50-95(${t})`])}</b>`).join(' · ')}`);
  if ('val/acc' in m) parts.push(`độ chính xác val <b>${fmt(m['val/acc'])}</b>`);
  if ('val_acc' in m) parts.push(`độ chính xác val <b>${fmt(m.val_acc)}</b>`); // việc cũ
  return parts.join(' · ');
}

/** Biểu đồ đường nhỏ cho một chỉ số theo từng epoch. */
function spark(values, better) {
  const pts = (values || []).map((v, i) => [i, v]).filter(([, v]) => v !== null && Number.isFinite(v));
  if (pts.length < 2) return '<span class="spark"></span>';
  const W = 96, H = 22, ys = pts.map(p => p[1]), lo = Math.min(...ys), hi = Math.max(...ys), n = values.length - 1 || 1;
  const xy = pts.map(([i, v]) => `${((i / n) * W).toFixed(1)},${(H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`);
  // Hướng tốt: loss phải giảm, chỉ số chất lượng phải tăng. Đi sai hướng ở đoạn cuối thì tô cam.
  const tail = ys.slice(-Math.max(3, Math.ceil(ys.length / 5)));
  const bad = tail.length >= 3 && (better === 'down' ? tail[tail.length - 1] > tail[0] : tail[tail.length - 1] < tail[0]);
  return `<svg class="spark ${bad ? 'bad' : ''}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${xy.join(' ')}"/></svg>`;
}

/** Bảng chỉ số đầy đủ: loss train / val cạnh nhau, rồi precision, recall, mAP theo khung / điểm / mask. */
function metricsTable(m, hist) {
  const cell = (key, better) => (key in m ? `<td class="num">${fmt(m[key])}</td><td>${spark(hist?.[key], better)}</td>` : '<td></td><td></td>');
  const losses = Object.keys(LOSS).filter(k => `train/${k}` in m || `val/${k}` in m);
  const kinds = Object.keys(KIND).filter(t => Object.keys(m).some(k => k.endsWith(`(${t})`)));
  const QUAL = [['precision', 'Precision', 'Trong các đối tượng model báo, bao nhiêu phần đúng'],
    ['recall', 'Recall', 'Trong các đối tượng thật, model tìm ra bao nhiêu phần'],
    ['mAP50', 'mAP50', 'Độ chính xác trung bình, tính đúng khi khớp ≥ 50%'],
    ['mAP50-95', 'mAP50-95', 'Chỉ số chính: trung bình ở các ngưỡng khớp 50–95%. Ultralytics chọn best.pt theo chỉ số này']];
  return `
    ${losses.length ? `<table class="plan metrics"><thead><tr><th>Loss</th><th class="num">Train</th><th></th><th class="num">Val</th><th></th></tr></thead><tbody>
      ${losses.map(k => `<tr><td title="${esc(LOSS[k][1])}">${esc(LOSS[k][0])} <code>${k}</code></td>${cell(`train/${k}`, 'down')}${cell(`val/${k}`, 'down')}</tr>`).join('')}
    </tbody></table>` : ''}
    ${kinds.length ? `<table class="plan metrics"><thead><tr><th>Chất lượng (tập val)</th>${kinds.map(t => `<th class="num">${KIND[t]}</th><th></th>`).join('')}</tr></thead><tbody>
      ${QUAL.map(([q, name, tip]) => `<tr><td title="${esc(tip)}">${name}</td>${kinds.map(t => cell(`metrics/${q}(${t})`, 'up')).join('')}</tr>`).join('')}
    </tbody></table>` : ''}
    ${'val/acc' in m ? `<table class="plan metrics"><tbody><tr><td>Độ chính xác val</td>${cell('val/acc', 'up')}</tr></tbody></table>` : ''}
    <p class="muted small">Loss train phải giảm dần. Loss val tăng trở lại trong khi loss train vẫn giảm là model bắt đầu học thuộc
      (overfit), nên dừng. Đường tô cam = đoạn cuối đang đi sai hướng. Rê chuột lên tên chỉ số để xem giải thích.</p>`;
}

/** Mức dùng GPU lúc này (nvidia-smi, cập nhật mỗi lần app hỏi tiến độ). Việc chỉ chạy trên một số GPU thì đánh dấu. */
function gpuStats(j) {
  if (j.status !== 'running' || !j.gpu_stats?.length) return '';
  const used = String(j.params.device ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const bar = (pct, hot) => `<span class="bar"><span style="width:${Math.min(100, Math.max(0, pct))}%" class="${hot ? 'hot' : ''}"></span></span>`;
  return `<div class="gpu-live">${j.gpu_stats.map(g => {
    const memPct = g.mem_total ? (g.mem_used / g.mem_total) * 100 : 0;
    const mine = !used.length || used.includes(String(g.index));
    return `<div class="gpu-row ${mine ? '' : 'other'}" title="${mine ? '' : 'Việc này không chạy trên GPU này'}">
      <b>${j.gpu_stats.length > 1 ? `GPU ${g.index} · ` : ''}${esc(g.name.replace(/^NVIDIA /, ''))}</b>
      <span>Dùng ${g.util ?? '?'}%</span>${bar(g.util ?? 0, (g.util ?? 0) >= 95)}
      <span>VRAM ${(g.mem_used / 1024).toFixed(1)} / ${(g.mem_total / 1024).toFixed(1)} GB</span>${bar(memPct, memPct >= 95)}
      ${g.temp !== null ? `<span class="${g.temp >= 85 ? 'warn' : ''}">${g.temp}°C</span>` : ''}
      ${g.power !== null ? `<span>${Math.round(g.power)}${g.power_limit ? ` / ${Math.round(g.power_limit)}` : ''} W</span>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function line(j) {
  if (j.status === 'uploading') return `Đang gửi dữ liệu lên server: ${Math.round(j.progress * 100)}%`;
  if (j.kind === 'train' && (j.status === 'running' || j.epoch)) {
    const m = metricsText(j.metrics);
    return `Epoch ${j.epoch}/${j.epochs}${m ? ` · ${m}` : ''}`;
  }
  if (j.status === 'running') return 'Đang chạy…';
  return '';
}

/**
 * container: phần tử chứa danh sách. projectId: chỉ việc của project này (bỏ trống = mọi việc).
 * actions(job) -> HTML các nút riêng (data-x="..."), onAction(name, job): xử lý các nút đó.
 */
export function jobList(container, { projectId, empty = 'Chưa có việc nào.', actions = () => '', onAction } = {}) {
  let jobs = [];
  let timer = null;
  let stopped = false; // trang đã đóng: không hẹn hỏi lại nữa
  const openLogs = new Set();
  const openMetrics = new Set();
  const histories = new Map(); // id việc -> {epoch, history}: lịch sử chỉ số tải khi mở mục "Chỉ số"

  function render() {
    container.replaceChildren(...(jobs.length ? jobs.map(card) : [h(`<p class="muted">${esc(empty)}</p>`)]));
  }

  function card(j) {
    const st = JOB_STATUS[j.status];
    const el = h(`
      <div class="job ${j.status}">
        <div class="row">
          <b class="job-title">${esc(j.title)}</b>
          <span class="tag ${st.cls}">${st.text}</span>
          <span class="spacer"></span>
          <span class="muted small">${esc(j.server_name || '(server đã xoá)')} · ${esc(j.created_by)} · ${fmtDate(j.created_at)}</span>
        </div>
        ${active(j) || j.status === 'done' ? `<div class="bar"><div style="width:${Math.round(j.progress * 100)}%"></div></div>` : ''}
        ${line(j) ? `<p class="small">${line(j)}</p>` : ''}
        ${gpuStats(j)}
        ${j.error ? `<pre class="job-error ${j.status === 'done' ? 'warn' : ''}">${esc(j.error)}</pre>` : ''}
        ${j.weights ? `<p class="small muted">Trọng số trên server: <code>${esc(j.weights)}</code></p>` : ''}
        ${Object.keys(j.metrics || {}).length ? `<details class="job-log job-metrics" data-metrics ${openMetrics.has(j.id) ? 'open' : ''}>
          <summary>Chỉ số (loss, precision, recall, mAP)</summary><div data-mbody></div></details>` : ''}
        <details class="job-log" data-log ${openLogs.has(j.id) ? 'open' : ''}><summary>Log</summary><pre>${esc(j.log || '(chưa có)')}</pre></details>
        <div class="row">
          ${actions(j)}
          <span class="spacer"></span>
          ${j.status === 'error' ? '<button class="sm" data-act="recheck" title="Đọc lại kết quả trên server (VD train đã xong và có best.pt nhưng bị báo lỗi)">Kiểm tra lại</button>' : ''}
          ${active(j) ? '<button class="sm danger" data-act="stop">Dừng</button>'
            : '<button class="sm ghost" data-act="del" title="Xoá việc và thư mục của nó trên server (dataset đã gửi, trọng số)">Xoá</button>'}
        </div>
      </div>`);
    const metrics = el.querySelector('[data-metrics]');
    if (metrics) {
      const body = metrics.querySelector('[data-mbody]');
      const show = () => { body.innerHTML = metricsTable(j.metrics, histories.get(j.id)?.history); };
      const load = async () => {
        try {
          const full = await api.gpuJob(j.id);
          histories.set(j.id, { epoch: full.epoch, history: full.history || {} });
          if (body.isConnected) show();
        } catch { /* giữ bảng không có biểu đồ */ }
      };
      metrics.addEventListener('toggle', () => {
        if (!metrics.open) return openMetrics.delete(j.id);
        openMetrics.add(j.id);
        show();
        if (histories.get(j.id)?.epoch !== j.epoch) load();
      });
      if (metrics.open) { show(); if (histories.get(j.id)?.epoch !== j.epoch) load(); }
    }
    const details = el.querySelector('[data-log]');
    details.addEventListener('toggle', () => {
      if (details.open) {
        openLogs.add(j.id);
        const pre = details.querySelector('pre');
        pre.scrollTop = pre.scrollHeight;
      } else openLogs.delete(j.id);
    });
    if (openLogs.has(j.id)) requestAnimationFrame(() => { const pre = details.querySelector('pre'); pre.scrollTop = pre.scrollHeight; });
    el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => act(e.currentTarget, j)));
    el.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => onAction?.(b.dataset.x, j)));
    return el;
  }

  async function act(b, j) {
    if (b.dataset.act === 'del' && !b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Bấm lần nữa để xoá';
      setTimeout(() => { delete b.dataset.armed; b.textContent = 'Xoá'; }, 3000);
      return;
    }
    b.disabled = true;
    try {
      if (b.dataset.act === 'stop') { await api.stopGpuJob(j.id); toast('Đã dừng'); }
      else if (b.dataset.act === 'recheck') {
        const r = await api.recheckGpuJob(j.id);
        toast(r.status === 'done' ? 'Đã đọc lại: việc này thực ra đã xong, model dùng được' : 'Đã đọc lại: việc này vẫn lỗi', r.status === 'done' ? 'ok' : 'warn', 6000);
      }
      else { await api.deleteGpuJob(j.id); toast('Đã xoá việc'); }
      await refresh();
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  }

  async function refresh() {
    clearTimeout(timer);
    try {
      jobs = await api.gpuJobs(projectId);
      // Đang bôi đen chữ trong log thì không vẽ lại kẻo mất vùng chọn. (Bấm mở "Log" cũng để lại con
      // trỏ chọn rỗng trong danh sách — cái đó không tính, nếu không danh sách sẽ đứng yên mãi.)
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !container.contains(sel.anchorNode)) render();
    } catch (err) { if (err.status !== 401) toast(err.message, 'err'); }
    // Có việc đang chạy: hỏi lại mỗi 2 giây. Không có: vẫn hỏi thưa (việc có thể được bắt đầu ở tab khác).
    if (!stopped) timer = setTimeout(refresh, jobs.some(active) ? 2000 : 15000);
    return jobs;
  }

  return { refresh, stop() { stopped = true; clearTimeout(timer); }, get jobs() { return jobs; } };
}
