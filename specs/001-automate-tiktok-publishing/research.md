# Phase 0 Research: Tự động đăng TikTok

## 1. Mở rộng kiến trúc hiện có

**Decision**: Giữ Electron/CommonJS hiện tại, tách tính năng TikTok thành controller, engine, adapter,
service và model; `main.js` chỉ ghép phụ thuộc và đăng ký IPC.

**Rationale**: Ứng dụng hiện tại đã có luồng main/preload/renderer, state JSON và CDP controller hoạt
động. Tách module giảm rủi ro làm hỏng Muse, cho phép kiểm thử logic không cần trình duyệt thật và đáp
ứng nguyên tắc selector bên thứ ba nằm trong một adapter.

**Alternatives considered**:

- Viết toàn bộ vào `main.js`: ít file hơn nhưng không thể kiểm thử/đối soát an toàn khi logic lớn.
- Tạo service/web app riêng: tăng vận hành, packaging và bề mặt secret không cần thiết.
- Sao chép mã tool tham chiếu: bị loại; chỉ dùng hành vi quan sát được, triển khai clean-room.

## 2. Điều khiển nhiều tài khoản TikTok

**Decision**: Mỗi kênh có Chrome profile, cổng CDP và mutex riêng. Một worker thay đổi trên mỗi kênh;
nhiều kênh có thể chạy song song.

**Rationale**: Profile riêng giữ cookie/session cách ly. Mutex theo tài khoản ngăn hai job cùng thay
đổi một trang Studio. Cách này phù hợp với controller Muse đang dùng CDP và không cần lấy cookie khỏi
trình duyệt người dùng.

**Alternatives considered**:

- Một profile, nhiều tab: dễ lẫn tài khoản và vi phạm hiến pháp.
- Nhiều job đồng thời trong cùng profile: nhanh hơn nhưng không xác định được tab/nút thuộc job nào.
- API TikTok không được cấp quyền: không giả định quyền truy cập mà người dùng chưa có.

## 3. State machine, checkpoint và chống đăng trùng

**Decision**: Publishing job dùng state machine hữu hạn. Mọi bước lưu checkpoint và evidence. Sau
`submitting`, nếu thiếu xác nhận thì chuyển `needs_reconciliation`; retry bị khóa đến khi người dùng
xác nhận kết quả.

**Rationale**: Đây là cách duy nhất đáp ứng yêu cầu không đăng trùng khi mất mạng hoặc đóng app giữa
lúc TikTok đã nhận hành động nhưng chưa trả kết quả.

**Alternatives considered**:

- Retry tự động sau timeout: có thể đăng trùng.
- Đánh dấu failed chung: làm mất khác biệt giữa lỗi trước và sau hành động cuối.
- Tăng tiến độ theo timer: không phản ánh trạng thái thật.

## 4. Lưu trữ và migration

**Decision**: Mở rộng `data/state.json` với `schemaVersion`, `tiktok.settings`, `tiktok.accounts`,
`tiktok.jobs` và `tiktok.mediaAssets`. Migration phải idempotent và bảo toàn `config`, `queue`, `logs`,
`control` của Muse. Mọi mutation đi qua một StateStore và ghi file tạm rồi rename.

**Rationale**: Một file duy trì cách vận hành/backup hiện tại, trong khi version hóa cho phép nâng cấp
an toàn. Một điểm ghi loại bỏ việc nhiều worker tự ghi cùng file.

**Alternatives considered**:

- SQLite: tốt khi dữ liệu rất lớn nhưng thêm dependency và migration phức tạp cho quy mô 50 job.
- Nhiều file JSON không có transaction: có thể lệch job/account/media khi app bị đóng.
- Ghi trực tiếp state.json: có thể để lại JSON hỏng.

## 5. Gemini và hợp đồng nội dung

**Decision**: Gọi Gemini Developer API từ main process bằng transport HTTP tích hợp, yêu cầu structured
output theo JSON Schema và validate lại mọi trường. Model mặc định cấu hình là `gemini-3.8-flash` cho
project mới; model vẫn có thể đổi trong settings. Chỉ gửi prompt/ảnh cần thiết, không gửi toàn bộ video.

**Rationale**: Tài liệu Google hiện khuyến nghị model mới cho project mới; structured output giảm lỗi
parse nhưng Google vẫn yêu cầu ứng dụng validate giá trị. Không thêm SDK giúp gói Electron hiện tại
nhẹ hơn. Rate limit thay đổi theo project/model, vì vậy 429 dùng backoff giới hạn và không làm mất nội
dung cũ. Nguồn: [Models](https://ai.google.dev/gemini-api/docs/models),
[Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output?lang=rest),
[Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

**Alternatives considered**:

- `gemini-2.5-flash` cố định: tài khoản mới có thể bị hạn chế truy cập; không phù hợp mặc định mới.
- SDK + schema library: tiện lợi nhưng thêm dependency/bundle lớn cho một endpoint nhỏ.
- Tự parse văn bản tự do: dễ hỏng khi model thay đổi câu chữ.

## 6. Lưu API key

**Decision**: Ưu tiên `GEMINI_API_KEY`; nếu người dùng nhập qua UI thì mã hóa bằng cơ chế secret của
Electron/Windows trước khi ghi local. Nếu mã hóa không khả dụng, chỉ giữ key trong phiên và cảnh báo.
Không đưa key qua state broadcast hoặc renderer sau khi lưu.

**Rationale**: Renderer không đáng tin bằng main process và state/log thường được sao chép khi hỗ trợ.
Mã hóa local giảm rủi ro rò rỉ file cấu hình.

**Alternatives considered**:

- Ghi thẳng key vào state.json: bị loại vì vi phạm hiến pháp.
- Chỉ dùng biến môi trường: an toàn nhưng khó dùng với người dùng chạy `run.bat`.
- Đưa key vào renderer: có thể bị đọc qua DevTools/XSS.

## 7. Showcase matching

**Decision**: ID chính xác là đường duy nhất được tự xác nhận. Tìm bằng tên/ảnh chỉ tạo candidate và
luôn cần người dùng duyệt. Nếu có Gemini, ảnh tham chiếu có thể hỗ trợ xếp hạng candidate; thiếu key
thì vẫn cho tìm theo tên và xác nhận tay.

**Rationale**: Khớp ảnh/tên có xác suất sai và người dùng đã chọn chính sách an toàn. Tách candidate
khỏi confirmed giúp acceptance test rõ ràng.

**Alternatives considered**:

- Tự xác nhận theo confidence: confidence không đồng nghĩa sản phẩm đúng tuyệt đối.
- Bắt buộc nhập ID: an toàn nhưng làm mất luồng ảnh/tên mà người dùng yêu cầu.

## 8. Xử lý âm thanh

**Decision**: Dùng ffprobe lấy duration/stream metadata và FFmpeg tạo file MP4 mới. Lệnh được gọi bằng
argument array, không qua shell. Pipeline trim từ offset, loop khi cần, điều chỉnh volume, fade và kết
thúc theo duration video; sau đó probe lại với dung sai 0,05 giây.

**Rationale**: Công cụ được thiết kế để đọc metadata máy được và xử lý media ổn định. File gốc bất
biến; file trung gian có provenance và retention. Tài liệu:
[ffprobe](https://ffmpeg.org/ffprobe.html).

**Alternatives considered**:

- Dùng thời lượng cấu hình: Muse có thể trả file ngắn/dài hơn cấu hình.
- Ghi đè video: mất khả năng phục hồi.
- Ghép nhạc trong TikTok Studio: phụ thuộc UI và không tạo kết quả xác định trước upload.

## 9. Phân phối FFmpeg

**Decision**: Resolver tìm binary theo thứ tự: thư mục `tools` đi cùng app, đường dẫn cấu hình, rồi
PATH. Bản phát hành chỉ bundle binary đã được review license cùng thông báo/bản quyền; nếu không có
binary hợp lệ, tính năng audio dừng với hướng dẫn rõ ràng.

**Rationale**: Máy phát triển có FFmpeg/ffprobe nhưng gói hiện tại chỉ có `ffmpeg.dll`, không phải CLI.
Không được phụ thuộc vào cài đặt tạm của máy phát triển. FFmpeg có thành phần LGPL/GPL tùy build nên
binary phân phối phải được kiểm tra. Nguồn: [FFmpeg legal](https://ffmpeg.org/legal.html).

**Alternatives considered**:

- Copy bản full GPL đang cài mà không review: rủi ro license.
- Chỉ yêu cầu PATH: làm hỏng trải nghiệm chạy bằng `run.bat` trên máy mới.
- Dùng `ffmpeg.dll` của Electron như CLI: không khả dụng theo cách spawn thông thường.

## 10. Lịch và xung đột

**Decision**: Scheduler tính timeline riêng cho mỗi tài khoản. Job được sắp theo thời gian/creation;
nếu trùng hoặc gần hơn interval thì job sau tự dời tới slot hợp lệ tiếp theo và UI hiển thị thay đổi
trước khi chạy.

**Rationale**: Đúng clarification đã chốt, xác định được lịch hàng loạt và tránh hai job cùng tài khoản
tranh nhau.

**Alternatives considered**:

- Giữ lịch trùng: không thể bảo đảm thứ tự.
- Chặn toàn bộ batch: tăng thao tác thủ công không cần thiết.

## 11. Kiểm thử và phát hành

**Decision**: Dùng `node:test` không thêm framework; unit test logic thuần, integration test với fake
Studio adapter, contract test IPC/schema, smoke test Electron và live checklist có giám sát. Build script
đóng `source` thành `resources/app.asar` hoặc `app.pending.asar` nếu app đang mở.

**Rationale**: Phù hợp dependency tối thiểu, cho phép kiểm chứng hầu hết logic không cần tài khoản thật
và giữ cơ chế `run.bat` hiện có.

**Alternatives considered**:

- Chỉ test live: chậm, không ổn định, khó lặp lỗi.
- Không test adapter: selector thay đổi sẽ gây regression khó phát hiện.

