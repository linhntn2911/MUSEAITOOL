# Quickstart Validation: Tự động đăng TikTok

Tài liệu này xác minh feature sau khi implement. Không dùng tài khoản sản xuất cho lần chạy live đầu.

## 1. Điều kiện

- Windows 10/11 x64.
- Một tài khoản Muse thử nghiệm và ít nhất một tài khoản TikTok thử nghiệm.
- Nếu kiểm tra nhiều kênh: hai tài khoản TikTok riêng.
- Một Gemini API key của người dùng để kiểm tra tạo nội dung.
- Hai video mẫu, hai ảnh sản phẩm và một video/file nhạc người dùng có quyền sử dụng.
- FFmpeg/ffprobe được resolver của app nhận diện.
- Sao lưu `data/state.json` và không xóa các Chrome profile hiện có.

## 2. Kiểm tra tự động

Từ `D:\Muse-Automation`:

```powershell
node --test tests
```

Kỳ vọng:

- Unit test scheduler, state machine, content validation và retention đều pass.
- Contract test xác nhận renderer không thể set status/progress hoặc nhận secret.
- Integration test khôi phục state, media pipeline và fake publishing engine đều pass.
- Audio integration kiểm tra sai lệch cuối audio/video không quá 0,05 giây.

## 3. Build và smoke test

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-asar.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1
```

Kỳ vọng:

- Build tạo `resources/app.asar` hoặc `app.pending.asar` an toàn nếu app đang mở.
- Smoke test mở app ẩn, xác nhận cả Xưởng Video và tab TikTok tồn tại rồi thoát mã 0.
- `run.bat` vẫn khởi động ứng dụng và dữ liệu Muse cũ còn nguyên.

## 4. Migration và khôi phục

1. Khởi động với state cũ chỉ có `config`, `queue`, `logs`, `control`.
2. Mở/đóng tool hai lần.
3. Kiểm tra queue Muse không đổi và subtree TikTok chỉ được tạo một lần.
4. Tạo job ở từng trạng thái active giả lập rồi đóng app.

Kỳ vọng:

- Migration idempotent.
- Job trước hành động cuối trở về checkpoint an toàn.
- Job ở `submitting` chuyển `needs_reconciliation`, không tự chạy lại.
- Xóa job rồi mở lại không làm job xuất hiện lại.

## 5. Gemini

1. Mở cấu hình TikTok, nhập API key và bấm kiểm tra.
2. Tạo nội dung cho một job affiliate và một job không giỏ.
3. Làm key sai hoặc mô phỏng rate limit, chạy lại.

Kỳ vọng:

- UI chỉ hiển thị key dạng masked; state/log không chứa key.
- Output khớp [generated-content.schema.json](./contracts/generated-content.schema.json).
- Job không giỏ không nhắc link/giỏ/mua trực tiếp.
- Lỗi giữ nguyên nội dung trước đó và có hướng dẫn retry.

## 6. Audio pipeline

1. Chọn nguồn nhạc dài hơn video đích; đặt offset, tiếng gốc 0%, nhạc 85%, fade cuối 0,5s.
2. Chọn nguồn ngắn hơn video; bật loop.
3. Xử lý hai job có thời lượng thực tế khác cấu hình.

Kỳ vọng:

- File gốc không đổi.
- File processed tồn tại, mở được, đúng streams và kết thúc trong dung sai 0,05s.
- Nguồn ngắn được loop; nguồn dài bị cắt; fade nghe không bị cụt.
- File processed được gán retention +7 ngày; pin làm cleanup bỏ qua.

## 7. Showcase

1. Dùng ID chính xác của sản phẩm có trong Showcase.
2. Dùng tên hoặc ảnh cho sản phẩm khác.
3. Thử chạy job khi candidate tên/ảnh chưa được xác nhận.

Kỳ vọng:

- ID khớp chính xác có thể tự xác nhận.
- Tên/ảnh chỉ tạo candidate và luôn yêu cầu xác nhận tay.
- Job chưa xác nhận bị chặn trước đăng.

## 8. Lịch và xung đột

1. Tạo ba job cùng kênh với giờ trùng, interval 60 phút.
2. Bấm tính lại lịch.

Kỳ vọng:

- Job đầu giữ slot hợp lệ.
- Job sau lần lượt dời +60 phút và UI hiển thị lý do điều chỉnh.
- Không job nào được gửi trước khi người dùng chạy hàng đợi.

## 9. Live TikTok có giám sát

1. Thêm một kênh, đăng nhập thủ công, bấm Check.
2. Chạy một job video thử ở chế độ lên lịch đủ xa trong tương lai.
3. Quan sát upload, caption, sản phẩm và hành động cuối.
4. Mô phỏng mất xác nhận sau submit hoặc đóng tool tại checkpoint thử nghiệm.

Kỳ vọng:

- Đúng handle, video, caption, sản phẩm và giờ.
- Nút cuối phải là Schedule; nếu không, job dừng.
- Thành công có evidence và progress 100%.
- Mất xác nhận chuyển `Cần đối soát`; Retry bị khóa cho đến khi người dùng quyết định.

## 10. Hết phiên và nhiều kênh

1. Chuẩn bị hai kênh, mỗi kênh một job.
2. Chạy song song.
3. Làm hết phiên một kênh và đăng nhập lại.

Kỳ vọng:

- Hai kênh không lẫn phiên; mỗi kênh chỉ một job thay đổi.
- Kênh hết phiên và các job của nó tạm dừng.
- Check thành công không tự chạy job; người dùng phải bấm Resume.
- Kênh còn lại tiếp tục độc lập.

## 11. Tiêu chí bàn giao

- Tất cả test tự động pass.
- Smoke test mã 0 và `run.bat` hoạt động.
- Một đường đăng/lên lịch live thành công trên tài khoản thử nghiệm.
- Một đường lỗi login, audio, Showcase và reconciliation được quan sát đúng.
- Không secret trong `state.json`, log hoặc IPC snapshot.
- Không video gốc nào bị ghi đè/xóa.
- Những bước live chưa thể kiểm tra phải được ghi rõ trong báo cáo bàn giao.

