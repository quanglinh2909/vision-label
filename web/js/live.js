// Kênh realtime /ws/live. Tự nối lại khi rớt mạng (chờ tăng dần, tối đa 30 giây), tự trả lời
// ping của server, và theo dõi lại project đang mở sau mỗi lần nối.
//
//   startLive() / stopLive()      bật khi đăng nhập, tắt khi đăng xuất
//   watchProject(pid)             báo server mình đang xem project nào
//   onLive((event, data) => ...)  nghe sự kiện: 'project.changed', 'me.changed', 'live.status'

const listeners = new Set();
let ws = null;
let watching = null;
let retry = 0;
let timer = null;
let stopped = true;

const emit = (event, data) => listeners.forEach(fn => { try { fn(event, data); } catch (e) { console.error(e); } });
const send = (event, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data })); };

function open() {
  clearTimeout(timer);
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    retry = 0;
    if (watching) send('project.watch', { project_id: watching });
    emit('live.status', { online: true });
  };
  ws.onmessage = e => {
    let f;
    try { f = JSON.parse(e.data); } catch { return; }
    if (f.event === 'ping') return send('pong', f.data);
    if (f.event === 'connected' || f.ack !== undefined) return;
    emit(f.event, f.data);
  };
  ws.onclose = e => {
    ws = null;
    emit('live.status', { online: false });
    // 4401 = hết phiên đăng nhập: không nối lại, app sẽ đưa về màn đăng nhập.
    if (stopped || e.code === 4401 || e.code === 4403) return;
    timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** retry++));
  };
}

export function startLive() {
  if (!stopped) return;
  stopped = false;
  open();
}

export function stopLive() {
  stopped = true;
  clearTimeout(timer);
  watching = null;
  ws?.close();
}

export function watchProject(pid) {
  if (watching === pid) return;
  watching = pid;
  if (pid) send('project.watch', { project_id: pid });
}

export const isOnline = () => ws?.readyState === WebSocket.OPEN;

export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
