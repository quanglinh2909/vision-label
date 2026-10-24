// Đọc file .zip ngay trong trình duyệt (không cần thư viện): phân tích danh mục trung tâm của zip,
// giải nén từng file bằng DecompressionStream('deflate-raw') có sẵn trong trình duyệt.
// Đủ cho zip do app (Python zipfile) và các công cụ thông dụng tạo ra; không hỗ trợ zip có mật khẩu
// hay zip64 (> 4 GB / > 65535 file).

const WANTED = /\.(jpe?g|png|bmp|webp|txt|ya?ml|json)$/i;

/**
 * Trả về danh sách File (mỗi file có `relPath` = đường dẫn trong zip, đặt sau `prefix`), chỉ lấy
 * ảnh và file nhãn / cấu hình. `onProgress(done, total)` báo tiến độ giải nén.
 */
export async function unzip(blob, prefix = '', onProgress = null) {
  const tailSize = Math.min(blob.size, 66 * 1024);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Không phải file zip hợp lệ');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('Zip quá lớn (zip64) chưa được hỗ trợ: hãy giải nén rồi chọn thư mục');

  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Danh mục zip bị hỏng');
    const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (flags & 1) throw new Error('Zip có mật khẩu chưa được hỗ trợ');
    if (!name.endsWith('/') && WANTED.test(name) && !/(^|\/)(__MACOSX|\.)/.test(name)) entries.push({ name, method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const files = [];
  for (const [n, e] of entries.entries()) {
    const head = new DataView(await blob.slice(e.local, e.local + 30).arrayBuffer());
    const start = e.local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const raw = blob.slice(start, start + e.csize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    else throw new Error(`${e.name}: kiểu nén ${e.method} chưa được hỗ trợ`);
    const file = new File([data], e.name.slice(e.name.lastIndexOf('/') + 1));
    Object.defineProperty(file, 'relPath', { value: prefix + e.name });
    files.push(file);
    onProgress?.(n + 1, entries.length);
  }
  return files;
}
