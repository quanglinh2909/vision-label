// Nhận ra một thư mục tải lên là dataset ĐÃ gán nhãn, đọc nhãn và đổi sang định dạng của app.
//   YOLO detect / pose / segment: có data.yaml; nhãn nằm ở labels/... tương ứng với images/...
//     (hoặc file .txt cùng tên, cùng thư mục với ảnh).
//   ImageFolder (phân loại): <train|val|test>/<lớp>/<ảnh> hoặc <lớp>/<ảnh>. Có classes.json (do app
//     xuất) thì lấy tên câu hỏi và tên hiển thị từ đó.
// Toạ độ YOLO đã chuẩn hoá 0..1, giống app, nên chỉ cần đổi cấu trúc.

import { orderCorners } from './editor/object-tool.js';
import { clamp } from './ui.js';

const IMG_EXT = /\.(jpe?g|png|bmp|webp)$/i;
const SPLITS = new Set(['train', 'val', 'valid', 'validation', 'test']);

/** Đường dẫn tương đối của file trong thư mục đã chọn / kéo thả (dùng / làm dấu phân cách). */
export const pathOf = f => (f.relPath || f.webkitRelativePath || f.name).replace(/\\/g, '/');
const dirOf = p => p.slice(0, p.lastIndexOf('/') + 1);
export const baseOf = p => p.slice(p.lastIndexOf('/') + 1);
const unquote = s => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const shortest = list => list.sort((a, b) => a.p.length - b.p.length)[0];

function commonDir(paths) {
  if (!paths.length) return '';
  let pre = dirOf(paths[0]);
  for (const p of paths) while (!p.startsWith(pre)) pre = dirOf(pre.slice(0, -1));
  return pre;
}

/** images/train/a.jpg -> labels/train/a.txt (đổi thư mục "images" gần ảnh nhất). */
function labelPathFor(p) {
  const i = p.lastIndexOf('images/');
  if (i < 0 || (i > 0 && p[i - 1] !== '/')) return null;
  return `${p.slice(0, i)}labels/${p.slice(i + 7).replace(/\.[^./]+$/, '.txt')}`;
}

/** YAML tối giản, đủ cho data.yaml của Ultralytics: names (map hoặc list), kpt_shape, flip_idx. */
export function parseDataYaml(text) {
  const out = { names: [], kpt: null, flip: null, kptNames: null };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], line = raw.replace(/\s+#.*$/, '');
    let m;
    if ((m = line.match(/^kpt_shape:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/))) out.kpt = [+m[1], +m[2]];
    else if ((m = line.match(/^flip_idx:\s*\[([^\]]*)\]/))) out.flip = m[1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
    else if ((m = line.match(/^names:\s*\[(.*)\]\s*$/))) out.names = m[1].split(',').map(unquote).filter(Boolean);
    else if (/^names:\s*$/.test(line)) {
      for (i++; i < lines.length && (/^\s+\S/.test(lines[i]) || /^-\s/.test(lines[i])); i++) {
        const l = lines[i].replace(/\s+#.*$/, '').trim();
        if ((m = l.match(/^(\d+)\s*:\s*(.+)$/))) out.names[+m[1]] = unquote(m[2]);
        else if ((m = l.match(/^-\s*(.+)$/))) out.names.push(unquote(m[1]));
      }
      i--;
    }
    // Tên các điểm do app ghi kèm: "# 4 điểm theo lớp 'plate': 0=TL, 1=TR, 2=BR, 3=BL"
    if ((m = raw.match(/^#.*:\s*((?:\d+=[^,]+,?\s*)+)$/))) out.kptNames = [...m[1].matchAll(/(\d+)=([^,]+)/g)].map(x => x[2].trim());
  }
  out.names = Array.from(out.names, (n, i) => n || `class${i}`);
  return out;
}

/** Tìm dataset trong danh sách file. Trả null nếu chỉ là ảnh thường. */
export function detectDataset(files) {
  const all = files.map(f => ({ f, p: pathOf(f) }));
  const yaml = shortest(all.filter(x => /(^|\/)data\.ya?ml$/i.test(x.p)));
  if (yaml) {
    const root = dirOf(yaml.p);
    const labels = new Map(all.filter(x => x.p.startsWith(root) && x.p.toLowerCase().endsWith('.txt')).map(x => [x.p, x.f]));
    const items = all.filter(x => x.p.startsWith(root) && IMG_EXT.test(x.p)).map(x => ({
      file: x.f, path: x.p,
      label: labels.get(labelPathFor(x.p)) || labels.get(x.p.replace(/\.[^./]+$/, '.txt')) || null,
    }));
    return items.length ? { kind: 'yolo', yamlFile: yaml.f, items } : null;
  }
  const images = all.filter(x => IMG_EXT.test(x.p));
  const cj = shortest(all.filter(x => /(^|\/)classes\.json$/i.test(x.p)));
  const root = cj ? dirOf(cj.p) : commonDir(images.map(x => x.p));
  const items = [];
  for (const x of images) {
    if (!x.p.startsWith(root)) return null;
    const dirs = x.p.slice(root.length).split('/').slice(0, -1).filter(d => !SPLITS.has(d.toLowerCase()));
    if (!dirs.length) return null; // có ảnh nằm ngoài thư mục lớp -> không phải ImageFolder
    items.push({ file: x.f, path: x.p, folder: dirs[dirs.length - 1] });
  }
  const folders = [...new Set(items.map(x => x.folder))];
  return folders.length >= 2 ? { kind: 'imagefolder', classesFile: cj?.f || null, items, folders } : null;
}

// ---------------------------------------------------------------- YOLO

/** Các dòng nhãn YOLO -> [{src, kind, box?, pts?, poly?}] (toạ độ 0..1). */
export function parseYoloLabel(text, meta) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/).filter(Boolean).map(Number);
    if (t.length < 5 || t.some(Number.isNaN)) continue;
    const [src, ...v] = t;
    if (meta.kpt) {
      const [k, d] = meta.kpt, [cx, cy, w, h] = v, kp = v.slice(4);
      const pts = Array.from({ length: k }, (_, j) => {
        const x = kp[j * d], y = kp[j * d + 1];
        const vis = d >= 3 ? kp[j * d + 2] : (x || y ? 2 : 0);
        return x !== undefined && vis > 0 ? [x, y] : null;
      });
      out.push({ src, kind: pts.some(Boolean) ? 'pose' : 'box', box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], pts });
    } else if (v.length === 4) {
      const [cx, cy, w, h] = v;
      out.push({ src, kind: 'box', box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
    } else if (v.length >= 6 && v.length % 2 === 0) {
      out.push({ src, kind: 'polygon', poly: Array.from({ length: v.length / 2 }, (_, j) => [v[2 * j], v[2 * j + 1]]) });
    }
  }
  return out;
}

/** Mỗi lớp nguồn vẽ kiểu gì: pose nếu có điểm thấy được, segment nếu có đa giác, không thì detect. */
export function inferClasses(meta, parsed) {
  const rows = meta.names.map((name, src) => ({ src, name, kinds: new Set(), objects: 0 }));
  for (const objs of parsed) for (const o of objs) {
    rows[o.src] ??= { src: o.src, name: `class${o.src}`, kinds: new Set(), objects: 0 };
    rows[o.src].kinds.add(o.kind);
    rows[o.src].objects++;
  }
  return rows.filter(Boolean).map(r => ({
    ...r,
    shape: r.kinds.has('pose') ? 'pose' : r.kinds.has('polygon') ? 'polygon' : 'box',
    k: meta.kpt?.[0] ?? 0,
  }));
}

/** Lớp nguồn (kiểu vẽ, số điểm) nhập vào lớp đích được không: ok | convert | no. */
export function compat(src, t) {
  if (src.shape === t.shape && (t.shape !== 'pose' || src.k === t.keypoints.length)) {
    return t.auto_corners ? { status: 'ok', note: 'Sắp lại 4 góc theo thứ tự của lớp đích.' } : { status: 'ok', note: '' };
  }
  if (t.shape === 'box') return { status: 'convert', note: 'Chỉ lấy khung, bỏ điểm / đa giác.' };
  if (t.shape === 'pose') {
    return src.shape === 'pose'
      ? { status: 'no', note: `Nguồn có ${src.k} điểm, lớp đích có ${t.keypoints.length} điểm.` }
      : { status: 'no', note: 'Nguồn không có điểm nào để làm pose.' };
  }
  return src.shape === 'box'
    ? { status: 'convert', note: 'Khung thành đa giác 4 đỉnh.' }
    : { status: 'convert', note: 'Nối các điểm thấy được thành đa giác (thiếu điểm thì dùng khung).' };
}

const c01 = v => clamp(v, 0, 1);
const rect = ([x1, y1, x2, y2]) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

/** Một đối tượng nguồn -> đối tượng của app theo kiểu vẽ của lớp đích; null nếu không đổi được. */
export function convertObject(o, t) {
  const pt = p => p && [c01(p[0]), c01(p[1])];
  let box = o.box;
  if (!box) {
    const xs = o.poly.map(p => p[0]), ys = o.poly.map(p => p[1]);
    box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (t.shape === 'box') {
    const b = box.map(c01);
    return b[2] > b[0] && b[3] > b[1] ? { cls: t.id, box: b } : null;
  }
  if (t.shape === 'pose') {
    if (!o.pts || o.pts.length !== t.keypoints.length || !o.pts.some(Boolean)) return null;
    const pts = o.pts.map(pt);
    // Lớp đích tự sắp 4 góc: thứ tự góc của nguồn (VD TL, TR, BL, BR) không quan trọng.
    return { cls: t.id, pts: t.auto_corners && pts.length === 4 && pts.every(Boolean) ? orderCorners(pts) : pts };
  }
  const vis = o.pts?.filter(Boolean) || [];
  const poly = o.poly || (vis.length >= 3 ? vis : rect(box));
  return { cls: t.id, poly: poly.map(pt) };
}

/** Cấu hình lớp mới tạo từ lớp nguồn. */
export function newClassFrom(row, meta) {
  const c = { name: row.name, label: row.name, shape: row.shape };
  if (row.shape === 'pose') {
    const k = row.k;
    const names = meta.kptNames?.length === k ? meta.kptNames : Array.from({ length: k }, (_, i) => `p${i + 1}`);
    const f = meta.flip?.length === k && meta.flip.every((j, i) => meta.flip[j] === i) ? meta.flip : names.map((_, i) => i);
    Object.assign(c, { keypoints: names, flip: f, auto_corners: false });
  }
  return c;
}
