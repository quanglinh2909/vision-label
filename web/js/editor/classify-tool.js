// Công cụ phân loại: không vẽ gì trên ảnh, chỉ chọn câu trả lời cho từng lớp (câu hỏi).
//   1–9 chọn lựa chọn của câu đang chọn rồi sang câu kế tiếp, 0 = Không rõ, Tab / ↑ ↓ đổi câu.
// Câu chưa trả lời mặc định là "Không rõ".

import { UNKNOWN } from '../ui.js';

export class ClassifyTool {
  constructor(classes) {
    this.classes = classes;
    this.objects = []; // [{cls, value}] — đủ mọi lớp, theo thứ tự cấu hình
    this.sel = 0; // câu hỏi đang chọn
    this.noCrosshair = true;
  }

  get help() {
    return {
      draw: [
        ['Chọn câu trả lời, sang câu tiếp', ['1', '…', '9']],
        ['Không rõ', ['0', 'Del']],
        ['Câu hỏi kế tiếp', ['Tab', '↓']],
        ['Câu hỏi trước', ['Shift+Tab', '↑']],
      ],
    };
  }

  setObjects(list) {
    const given = Object.fromEntries(list.map(o => [o.cls, o.value]));
    this.objects = this.classes.map(c => ({ cls: c.id, value: given[c.id] ?? UNKNOWN }));
    this.sel = 0;
  }

  getObjects() { return this.objects.map(o => ({ ...o })); }
  validate() { return null; }

  choose(i, value) {
    const ed = this.editor, o = this.objects[i];
    if (!o) return;
    this.sel = i;
    if (o.value !== value) { ed.pushHistory(); o.value = value; ed.markDirty(); } else ed.changed();
  }

  key(e) {
    const n = this.objects.length;
    if (!n) return false;
    if (this.sel < 0) this.sel = 0; // hoàn tác đặt sel = -1
    const back = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey);
    if (back || e.key === 'Tab' || e.key === 'ArrowDown') {
      this.sel = (this.sel + (back ? -1 : 1) + n) % n;
      this.editor.changed();
      return true;
    }
    if (!/^[0-9]$/.test(e.key)) return false;
    const value = e.key === '0' ? UNKNOWN : this.classes[this.sel].options[+e.key - 1]?.id;
    if (value === undefined) return false;
    this.choose(this.sel, value);
    if (this.sel < n - 1) { this.sel++; this.editor.changed(); }
    return true;
  }

  deleteSelected() { this.choose(Math.max(this.sel, 0), UNKNOWN); }
  select(i) { this.sel = i; this.editor.changed(); }

  // Không có gì để vẽ hay kéo trên ảnh.
  down() { } move() { } up() { } rightClick() { } draw() { }
  cursor() { return 'default'; }
  cancel() { }
  cancelPending() { return false; }
  assignClass() { }
  items() { return []; }
}
