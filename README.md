# VisionLabel

Công cụ gán nhãn ảnh cho YOLO, MobileNet, ResNet, chạy trên trình duyệt. Backend dựng bằng
[fastapi-modular](https://pypi.org/project/fastapi-modular/), database SQLite.

Hai loại project. Tạo project chỉ cần tên và loại; các lớp đặt sau ở mục **Lớp** của project.

| Loại | Lớp | Dataset xuất ra |
|---|---|---|
| **Nhận diện đối tượng** | mỗi lớp tự chọn kiểu vẽ: **Detect** (khung), **Pose** (các điểm theo thứ tự) hoặc **Segment** (đa giác) | YOLO detect / pose / segment |
| **Phân loại ảnh** | mỗi lớp là một câu hỏi cho cả ảnh, kèm các lựa chọn; *Không rõ* luôn có và là mặc định | ImageFolder cho MobileNet / ResNet, kèm `train.py` |

### Lớp của project nhận diện đối tượng

- Lúc gán nhãn, chọn lớp nào (bấm, phím `1`–`9`, hoặc gõ tên lớp một ký tự) thì vẽ theo kiểu của lớp đó:
  khung = kéo chuột; pose = click lần lượt từng điểm (`X` = điểm không thấy); đa giác = click từng
  đỉnh, click lại đỉnh đầu hoặc `Enter` để khép. VD biển số là pose 4 điểm, xe là khung, vạch kẻ là đa giác.
- Pose: đặt tên các điểm, cặp đổi chỗ khi lật ngang (tự đoán từ tên `trai/phai`, `left/right`, `TL/TR`),
  và với 4 điểm có thể bật *tự sắp TL, TR, BR, BL* (click thứ tự nào cũng được).
- Mẫu có sẵn: **Biển số 4 góc**, **Bộ ký tự 0-9, A-Z**. Khi mọi lớp đều tên một ký tự, khung mới vẽ ra là
  `?` (đỏ); vẽ hết khung rồi gõ cả biển, ký tự điền lần lượt theo thứ tự đọc. Còn khung `?` thì chưa lưu được.
- Nhãn trỏ tới lớp bằng id cố định: đổi tên, đổi thứ tự, thêm lớp lúc nào cũng được. Lớp đang có nhãn
  thì không xoá, không đổi kiểu vẽ, không đổi số điểm được.

### Xuất dataset: lớp nào sang định dạng nào

Trước khi tạo, trang Dataset hiện bảng từng lớp: *xuất nguyên vẹn*, *chuyển đổi* (kèm cách đổi), hoặc
*không xuất được* (kèm lý do, không chọn được). Bỏ chọn lớp thì đối tượng lớp đó không ghi nhãn.

| Lớp vẽ bằng | YOLO detect | YOLO pose | YOLO segment |
|---|---|---|---|
| Detect (khung) | nguyên vẹn | chuyển đổi: khung + các điểm ghi `0 0 0` (không thấy); train được nhưng mAP pose của lớp luôn 0 | chuyển đổi: đa giác 4 đỉnh hình chữ nhật |
| Pose (điểm) | chuyển đổi: khung bao các điểm | nguyên vẹn nếu cùng số điểm với lớp pose chuẩn; **khác số điểm thì không xuất được** (YOLO bắt buộc mọi lớp chung `kpt_shape`) | chuyển đổi: nối các điểm thành đa giác (≥ 3 điểm; chỉ đúng khi điểm nằm trên viền vật) |
| Segment (đa giác) | chuyển đổi: khung bao | chuyển đổi: như khung | nguyên vẹn |

Phân loại: xuất từng câu hỏi, mỗi lựa chọn một thư mục (`train/<lua-chon>/`, `val/<lua-chon>/`), kèm
`classes.json` và `train.py` (torchvision: `mobilenet_v3_small/large`, `resnet18/34/50`). Ô
*Thêm lớp "Không rõ"*: bật thì *Không rõ* thành một lớp riêng; tắt thì ảnh *Không rõ* bị bỏ khỏi dataset.

## Chạy

```bash
python -m venv .venv
.venv\Scripts\activate            # Linux/macOS: . .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env            # Linux/macOS: cp .env.example .env
fam dev                           # mở http://localhost:8000
```

API docs: http://localhost:8000/docs

## Luồng làm việc

1. Trang đầu: **tạo project**, chọn loại bài toán, rồi đặt các lớp ở mục **Lớp**.
2. **Tải ảnh lên**: chọn file, chọn thư mục, hoặc kéo thả. Thư mục là **dataset đã gán nhãn** thì được nhận ra
   và nhập kèm nhãn thẳng vào **Cần review** (ghi người nhập là người gán, lịch sử ghi "nhập từ dataset"):
   - Project nhận diện: dataset **YOLO detect / pose / segment** (có `data.yaml`; nhãn ở `labels/…` ứng với
     `images/…`). Bảng ghép lớp: mỗi lớp nguồn chọn *tạo lớp mới* (kiểu vẽ tự đoán từ nhãn), *ghép vào lớp
     có sẵn* (báo nhập nguyên vẹn / chuyển đổi / không nhập được, VD khác số điểm) hoặc *bỏ qua*. Ảnh không có
     file nhãn vào Chưa gán nhãn; file nhãn rỗng là ảnh nền. Lớp đích tự sắp 4 góc thì góc được sắp lại.
   - Project phân loại: **ImageFolder** (`train/<lựa chọn>/ảnh`), mỗi thư mục ghép với một lựa chọn,
     *Không rõ*, lựa chọn mới hoặc bỏ qua. Có `classes.json` (do app xuất) thì lấy luôn tên hiển thị.
   - Ảnh trùng tên với ảnh đã có bị bỏ qua, nên nhập lại cùng thư mục không tạo bản trùng.
3. **Chưa gán nhãn** → *Bắt đầu gán nhãn*. Gán xong bấm `D` / `Enter` để lưu và sang ảnh tiếp (trong **Cần review**:
   duyệt và sang ảnh tiếp). `→` / `←` chỉ lướt sang ảnh sau / trước để xem, không lưu, không duyệt (đang sửa dở thì
   phần sửa vẫn được lưu, ảnh ở nguyên chờ duyệt).
   Ảnh bấm tiếp mà không có đối tượng nào được lưu là *ảnh nền*.
4. **Đã gán nhãn**: xem lại toàn bộ dạng lưới, bấm vào ảnh để sửa.
5. **Dataset**: chọn định dạng, tạo phiên bản (v1, v2…). Mỗi phiên bản là một bản chụp cố định trong
   `dataset/<tên-project>/v<n>/`, dùng thẳng để train:

   ```bash
   yolo pose train data=<thư-mục>/data.yaml model=yolo26n-pose.pt      # detect: yolo26n.pt, segment: yolo26n-seg.pt
   python <thư-mục>/train.py --epochs 30                               # phân loại (MobileNet / ResNet)
   ```

## Đăng nhập và phân quyền

- Lần đầu mở web: tạo **quản trị viên** đầu tiên. Sau đó không có tự đăng ký; quản trị viên
  thêm người ở trang **Thành viên** (link ở đầu trang project).
- **Quản trị viên**: tạo/xoá project, tải ảnh, tạo/xoá dataset, quản lý thành viên.
  **Người gán nhãn**: xem project, gán nhãn, tải dataset.
- Mật khẩu băm PBKDF2; phiên là cookie HttpOnly ký HMAC (khoá trong `data/secret.key`,
  hoặc `APP_AUTH__SECRET`). Đổi mật khẩu / khoá tài khoản thì mọi phiên cũ bị đăng xuất.
  Sai mật khẩu 5 lần thì tạm khoá 60 giây.
- **Link tải dataset** kèm `?key=...` (ký số theo từng phiên bản): curl/Colab tải được không
  cần đăng nhập, như Roboflow. Ai có link đều tải được, nên chỉ gửi cho người cần.
- Public qua HTTPS thì đặt `APP_AUTH__COOKIE_SECURE=true`.

## Google Drive

Menu tài khoản → **Google Drive** (quản trị viên). Làm theo 4 bước trên trang: bật Google Drive API, tạo màn hình
đồng ý OAuth, tạo OAuth client loại *Web application* với redirect URI hiện trên trang
(`http://localhost:8000/api/drive/callback`), dán Client ID / secret rồi bấm **Kết nối Google Drive**.

- App chỉ xin quyền `drive.file`: chỉ thấy file / thư mục do nó tạo. Không cần cài thêm thư viện (gọi API bằng urllib).
- Mỗi phiên bản dataset có nút **Lên Drive**: bản zip được đưa vào `<thư mục gốc>/<tên project>/<project>-v<n>.zip`
  (thư mục gốc mặc định `VisionLabel`), gửi từng phần 8 MB, tiến độ cập nhật trực tiếp; xong thì có nút *Mở trên Drive*.
  Bật *Tạo dataset xong tự tải lên Drive* để khỏi bấm tay.
- Access token hết hạn thì tự làm mới. Người dùng thu hồi quyền / đổi Client ID thì thẻ dataset báo lỗi kèm hướng dẫn kết nối lại.
  Server tắt giữa lúc tải thì lần khởi động sau đánh dấu lỗi để bấm *Thử lại*.
- Refresh token lưu trong `data/app.db`: giữ thư mục `data/` như giữ mật khẩu. Ứng dụng OAuth ở chế độ *Testing* bị Google
  hết hạn kết nối sau 7 ngày; bấm *Publish app* (quyền `drive.file` không cần Google duyệt) để dùng lâu dài.
- Google chỉ nhận redirect `http://localhost` / `127.0.0.1` hoặc HTTPS có tên miền. Chạy sau tên miền thì đặt `APP_DRIVE__REDIRECT_URI`.

## Gán nhãn tiếp ở máy khác (khôi phục từ Google Drive)

Mỗi phiên bản dataset (zip) đều kèm `visionlabel.json`: cấu hình lớp đầy đủ (tên hiển thị, kiểu vẽ, các điểm,
lựa chọn) và **nhãn gốc** của từng ảnh. Ở máy khác (clone code, database trống):

1. Mở trang **Google Drive**, dán **cùng Client ID / secret** như máy cũ (quyền `drive.file` chỉ thấy file do chính
   OAuth client đó tạo) rồi kết nối. Máy mới chạy ở địa chỉ khác thì thêm redirect URI của nó vào OAuth client.
2. Tạo project cùng loại, vào **Tải ảnh lên** → **Lấy từ Google Drive** → chọn bản zip. (Hoặc tải zip từ Drive về
   rồi thả thẳng file .zip vào trang.)
3. Bảng khôi phục tự tạo lại các lớp y như bản gốc (hoặc ghép vào lớp có sẵn cùng tên), chọn đưa ảnh vào
   **Đã duyệt** (mặc định) hay **Cần review**, bấm Khôi phục.

Khôi phục không mất gì kể cả khi định dạng xuất đã phải chuyển đổi (VD lớp khung trong bản YOLO pose vẫn về lại
thành khung), ảnh giữ tên gốc. Chỉ ảnh có trong phiên bản đó mới khôi phục được (ảnh chưa gán / chờ duyệt không
nằm trong dataset). Zip xuất trước khi có tính năng này không có `visionlabel.json`: vẫn nhập được như dataset
YOLO / ImageFolder thường, nhưng nên tạo lại phiên bản mới để có bản khôi phục đầy đủ.

## Server GPU: tự gán nhãn và train

Máy Ubuntu có GPU NVIDIA, app nói chuyện qua **SSH** (paramiko): không cần mở cổng nào khác, ảnh gửi đi đánh nhãn
cũng đi trong kết nối SSH. Thêm được nhiều server.

1. Trên server, làm tay một lần: bật SSH (`sudo apt install openssh-server`; app vào server bằng SSH nên không tự cài
   được) và có driver NVIDIA (`nvidia-smi` thấy GPU; chưa có thì `sudo ubuntu-drivers install` rồi `sudo reboot`. App
   không tự cài driver vì phải khởi động lại máy, máy bật Secure Boot còn phải xác nhận khoá tại chỗ).
2. Menu tài khoản → **Server GPU** → *Thêm server*: IP, cổng, tài khoản, mật khẩu **hoặc** khoá riêng (không passphrase).
   Bỏ trống cả hai thì dùng khoá SSH có sẵn của máy chạy app. Bấm *Kiểm tra kết nối* (đọc GPU, bộ nhớ, Python).
3. *Cài môi trường* (chạy nền): tạo `<thư mục làm việc>/venv` (thiếu `python3-venv` thì tự cài bằng sudo với mật khẩu
   SSH đã lưu), cài `ultralytics`; tuỳ chọn cài thêm và tải sẵn
   `nvidia/LocateAnything-3B` (~7 GB). Xong thì server tự dùng python trong venv.
4. Trong project → **Model AI**:
   - *Tự gán nhãn*: chọn server, model **YOLO** (`yolo26n.pt`…, hoặc model vừa train) hoặc **LocateAnything-3B**
     (tìm theo mô tả chữ, chỉ ra khung), và mỗi lớp của project khớp với tên lớp / mô tả nào. Nhiều tên ngăn bằng dấu
     phẩy cùng về một lớp (`car, truck, bus`). Model tìm ra lớp khác thì bỏ: chỉ gán đúng các lớp của project.
   - *Train*: chọn phiên bản dataset + server. YOLO detect / pose / segment chạy Ultralytics, phân loại chạy `train.py`
     của dataset. Theo dõi epoch, mAP, log; train xong bấm *Dùng để tự gán nhãn*.
5. Trong trình gán nhãn có nút **Tự gán nhãn** (cả quản trị viên lẫn người gán): kết quả được **thêm** vào ảnh, chưa lưu,
   `Ctrl+Z` bỏ được; lưu như bình thường nên vẫn qua Cần review. Bật *Mở ảnh chưa có nhãn là tự chạy luôn* nếu muốn.

Kiểu vẽ của lớp quyết định cách đổi: khung lấy khung; đa giác lấy viền mask (YOLO segment), model chỉ có khung thì
thành hình chữ nhật; pose lấy điểm của YOLO pose (phải đúng số điểm, tự sắp 4 góc nếu lớp bật), LocateAnything bỏ qua lớp pose.

Trên server, mỗi server một thư mục làm việc (mặc định `~/visionlabel`): `agent.py` giữ model trong GPU (tự tắt sau
`APP_GPU__AGENT_IDLE_MINUTES` phút không dùng, hoặc bấm *Giải phóng GPU*), `jobs/<id>/` cho mỗi lần train (dataset,
`log.txt`, `train/weights/best.pt`). Train chạy bằng `nohup`, app tắt hay mất mạng thì vẫn chạy tiếp; app mở lại
theo dõi tiếp. Mật khẩu / khoá SSH lưu trong `data/app.db` như secret của Google Drive.

LocateAnything-3B: GPU từ Ampere (RTX 30xx, A100…), nên từ 12 GB VRAM; giấy phép NVIDIA chỉ cho nghiên cứu,
**phi thương mại**.

## Phân công và review

```
Chưa gán ──(admin phân công)──▶ giao cho An ──(An lưu = nộp)──▶ Chờ duyệt ──(admin duyệt)──▶ Đã duyệt → vào dataset
                                     ▲                                │
                                     └──────(admin trả lại + ghi chú)─┘
```

- **Phân công** (quản trị viên): chọn người + số ảnh, server tự chọn ảnh chưa gán và chưa giao
  cho ai. Mỗi ảnh được giành bằng compare-and-set trên `assigned_to = ''`, nên không bao giờ
  giao một ảnh cho hai người. *Thu hồi* lấy lại các ảnh người đó chưa làm.
- **Người gán nhãn** chỉ thấy ảnh được giao: *Việc của tôi* (chưa làm + bị trả lại, ảnh bị trả
  lại được đưa lên đầu, kèm ghi chú), *Chờ duyệt*, *Đã duyệt* (chỉ xem). Không xem được ảnh của
  người khác, toàn bộ project hay dataset — server trả 403, kể cả khi gọi thẳng file ảnh.
- **Cần review** (quản trị viên): ảnh chờ duyệt nhóm theo từng người. Mở ảnh để sửa rồi
  *Duyệt và tiếp*, hoặc *Trả lại* kèm ghi chú; có nút duyệt hết ảnh của một người.
- **Mọi lần lưu đều vào Cần review**, kể cả của quản trị viên (ảnh họ tự gán nằm trong nhóm
  của họ). Chỉ nút *Duyệt* / *Duyệt và tiếp* mới đưa ảnh sang Đã duyệt. **Chỉ ảnh đã duyệt mới vào dataset.**
- Mỗi ảnh ghi người gán, người sửa cuối, người duyệt và lịch sử từng lần gán / sửa / duyệt /
  trả lại. Ảnh đang mở được giữ chỗ 5 phút (tự gia hạn) để hai người không sửa đè nhau.

## Realtime (WebSocket)

Giao diện giữ một kết nối `/ws/live` (gateway của fastapi-modular, xác thực bằng chính cookie
đăng nhập). Mất mạng / server khởi động lại thì tự nối lại; đèn ở cuối menu trái báo trạng thái.

- **Quản trị viên** nhận mọi thay đổi của project đang xem (`project.changed`): ai mở / đóng
  ảnh, nộp, duyệt, trả lại, giao, thu hồi, tải ảnh, tạo dataset. Số đếm ở menu, trang Cần review,
  Phân công, các lưới ảnh tự cập nhật; nhãn "X đang mở" đổi tại chỗ.
- **Người gán nhãn** chỉ nhận tin về ảnh của mình (`me.changed`, gửi thẳng tới họ): được giao
  ảnh, bị trả lại (kèm ghi chú), được duyệt, bị thu hồi. Không bao giờ nhận tin về ảnh người khác.
- Đang mở một ảnh mà người khác giành quyền / duyệt / trả lại / xoá ảnh đó thì biết ngay.
- Đang chọn ảnh ở Cần review thì trang không tự tải lại (để không mất lựa chọn) mà hiện nút *Tải lại*.
- Phát tin không bao giờ làm hỏng thao tác chính (lỗi chỉ ghi log). Chạy nhiều worker thì đặt
  `APP_WS__ADAPTER=redis` để các worker chuyển tin cho nhau.

## Cấu trúc

```
src/
├── main.py                 lắp ráp app + phục vụ giao diện web/
├── core/
│   ├── config.py           AppSettings (APP_STORAGE__DIR, APP_STORAGE__DATASETS_DIR...)
│   ├── storage.py          đường dẫn file trên đĩa
│   ├── security.py         băm mật khẩu, ký token (thư viện chuẩn)
│   └── lifespan.py
└── api/                    mỗi thư mục con là một module (tự được quét)
    ├── auth/               tài khoản, đăng nhập, guard Authenticated / AdminOnly
    ├── projects/           tạo / sửa / xoá project; classes.py: cấu hình lớp + luật đổi lớp khi đã có nhãn
    ├── images/             upload, duyệt, lưu nhãn; annotations.py: định dạng nhãn + kiểm theo lớp
    ├── datasets/           phiên bản dataset; exporter.py: kế hoạch xuất, YOLO detect/pose/segment, ImageFolder + zip
    ├── drive/              Google Drive: cấu hình OAuth, google_client.py (REST + upload nhiều phần), đẩy zip dataset
    ├── gpu/                Server GPU qua SSH: ssh.py, agent.py (chạy trên server, giữ model), scripts.py (cài đặt / train), autolabel.py (kết quả model -> nhãn)
    ├── live/               WebSocket /ws/live: gateway + LiveEvents (phát sự kiện)
    └── health/

web/                        giao diện (ES modules thuần, không cần build)
├── index.html
├── css/app.css
└── js/
    ├── app.js              router + menu trái
    ├── api.js              gọi REST API
    ├── pages/              projects, upload, gallery, labeler, classes, datasets, settings...
    └── editor/             editor.js (zoom/kéo/kính lúp/hoàn tác), object-tool.js (khung/pose/đa giác), classify-tool.js

data/app.db                 SQLite (tự tạo)
storage/projects/<id>/      ảnh gốc + ảnh thu nhỏ đã upload
dataset/<project>/v<n>/     dataset đã xuất
```

Nhãn lưu trong database với toạ độ chuẩn hoá 0..1; chỉ khi tạo dataset mới đổi sang
định dạng YOLO, nên sửa nhãn không làm hỏng các phiên bản đã xuất.
