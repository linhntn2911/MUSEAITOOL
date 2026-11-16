<!--
Sync Impact Report
- Version change: template chưa ban hành -> 1.0.0
- Modified principles:
  - Nguyên tắc mẫu 1 -> I. Trạng thái thật, không giả lập tiến trình
  - Nguyên tắc mẫu 2 -> II. An toàn phiên đăng nhập và dữ liệu bí mật
  - Nguyên tắc mẫu 3 -> III. Tự động hóa có khả năng phục hồi
  - Nguyên tắc mẫu 4 -> IV. Toàn vẹn sản phẩm và media
  - Nguyên tắc mẫu 5 -> V. Thay đổi nhỏ, kiểm chứng được
- Added sections:
  - Ràng buộc kỹ thuật và an toàn
  - Quy trình phát triển và cổng chất lượng
- Removed sections: Không có
- Follow-up TODOs: Không có
-->

# Muse Automation Constitution

## Core Principles

### I. Trạng thái thật, không giả lập tiến trình

Mọi trạng thái và phần trăm tiến độ MUST được suy ra từ bằng chứng quan sát được của hệ thống,
trình duyệt hoặc file đầu ra. Hệ thống MUST NOT tự tăng tiến độ theo thời gian khi bước thực tế
chưa hoàn thành. Một job chỉ được đánh dấu hoàn tất khi kết quả đã tồn tại, có thể mở được và đã
được liên kết đúng với job. Sau khi khởi động lại, các job đang dở MUST chuyển sang trạng thái cần
đối soát trước khi tiếp tục; hệ thống MUST NOT tự đăng hoặc tạo lại nội dung có nguy cơ trùng lặp.

Lý do: người dùng cần biết chính xác tool đang làm gì và không được mất quyền kiểm soát chỉ vì giao
diện hiển thị một tiến độ ước lượng.

### II. An toàn phiên đăng nhập và dữ liệu bí mật

Mỗi tài khoản Muse hoặc TikTok MUST sử dụng profile trình duyệt riêng và MUST NOT chia sẻ cookie,
local storage hoặc khóa điều khiển với tài khoản khác. Cookie, API key và thông tin xác thực MUST
không xuất hiện trong log, giao diện HTML phía người dùng hoặc mã nguồn. API key MUST được đọc từ
biến môi trường hoặc kho secret cục bộ. Tool MUST NOT vượt CAPTCHA, OTP, cơ chế kích hoạt, giới hạn
tài khoản hoặc biện pháp bảo mật của dịch vụ; các bước đó MUST được bàn giao cho người dùng.

Lý do: phiên đăng nhập và secret là dữ liệu nhạy cảm; cách ly profile cũng ngăn job chạy nhầm tài
khoản.

### III. Tự động hóa có khả năng phục hồi

Mỗi luồng tự động hóa MUST có timeout hữu hạn, thông báo lỗi cụ thể, checkpoint an toàn và đường
chạy lại rõ ràng. Pause MUST ngăn bắt đầu bước mới nhưng không được đóng trình duyệt đột ngột giữa
lúc upload. Stop MUST giải phóng khóa tài khoản và giữ đủ dữ liệu để đối soát. Retry MUST kiểm tra
trạng thái từ xa trước khi lặp một hành động có thể tạo nội dung hoặc đăng bài. Selector và quy tắc
nhận diện giao diện bên thứ ba MUST được gom vào lớp adapter để có thể sửa mà không thay đổi toàn bộ
engine.

Lý do: Muse và TikTok Studio thay đổi giao diện thường xuyên; lỗi giao diện không được làm hỏng hàng
đợi hoặc gây hành động trùng.

### IV. Toàn vẹn sản phẩm và media

Ảnh sản phẩm tham chiếu MUST đi cùng job từ lúc tạo nội dung đến lúc xuất video và đăng TikTok.
Hệ thống MUST NOT tuyên bố đã tải ảnh, gắn sản phẩm Showcase hoặc tạo video khi chưa có bằng chứng
tương ứng. Job có giỏ hàng MUST dừng trước bước đăng nếu sản phẩm chưa được xác minh hoặc chưa được
người dùng xác nhận. Xử lý âm thanh MUST dùng thời lượng thực tế đọc từ file video đầu ra, MUST không
ghi đè media gốc và MUST kiểm tra lại file trung gian trước khi upload. Mọi thao tác xóa media MUST
có mục tiêu cụ thể và xác nhận rõ ràng.

Lý do: sai ảnh, sai sản phẩm, âm thanh dư hoặc xóa nhầm file đều tạo thiệt hại trực tiếp cho nội dung
và hoạt động bán hàng.

### V. Thay đổi nhỏ, kiểm chứng được

Mỗi thay đổi MUST có phạm vi hữu hạn, tiêu chí nghiệm thu và cách kiểm chứng tương ứng. Trước khi sửa,
người thực hiện MUST đọc luồng hiện tại và bảo toàn dữ liệu người dùng cũng như các thay đổi không
liên quan. Sau khi sửa, MUST chạy kiểm tra phù hợp với rủi ro: kiểm tra cú pháp cho mọi thay đổi mã,
kiểm tra đơn vị cho logic thuần, kiểm tra tích hợp cho lưu trạng thái và media, và chạy thử trình duyệt
cho selector hoặc luồng Muse/TikTok. Bản build phát hành MUST chạy được bằng `run.bat` và MUST không
phụ thuộc vào thư mục phát triển tạm thời.

Lý do: công cụ desktop và automation khó phục hồi khi một thay đổi lớn làm hỏng nhiều lớp cùng lúc;
thay đổi nhỏ giúp xác định nguyên nhân và quay lui an toàn.

## Ràng buộc kỹ thuật và an toàn

- Ứng dụng desktop hiện tại dùng Electron/Node.js; tính năng mới MUST ưu tiên tái sử dụng kiến trúc
  trong `source` trước khi thêm framework hoặc dịch vụ mới.
- Dữ liệu hàng đợi MUST được lưu bền vững sau mỗi chuyển trạng thái quan trọng. Ghi file trạng thái
  MUST dùng file tạm và thay thế an toàn để tránh file JSON dở dang khi mất điện hoặc đóng tool.
- Mỗi tài khoản chỉ được có một thao tác gây thay đổi đang chạy tại một thời điểm. Các tài khoản khác
  có thể chạy song song nếu mỗi tài khoản dùng profile và khóa riêng.
- FFmpeg/ffprobe MUST được kiểm tra tồn tại trước khi xử lý media. File đầu ra MUST được xác minh thời
  lượng, codec/container và khả năng mở trước khi thay thế đường dẫn upload của job.
- Automation bên thứ ba MUST dừng an toàn khi không xác định chắc chắn nút cuối là hành động mong muốn.
  Ví dụ, yêu cầu lên lịch MUST NOT bấm nút đăng ngay.
- Log MUST có thời gian, mã job rút gọn, tài khoản, bước và lỗi có thể hành động; log MUST NOT chứa
  cookie, API key hoặc toàn bộ dữ liệu cá nhân không cần thiết.
- Mã nguồn MUST không chứa cơ chế key kích hoạt, máy chủ điều khiển từ xa hoặc thu thập dữ liệu ngoài
  những gì được mô tả và người dùng đồng ý.

## Quy trình phát triển và cổng chất lượng

1. Mọi tính năng bắt đầu bằng đặc tả mô tả kết quả người dùng, phạm vi, trạng thái, lỗi và tiêu chí
   nghiệm thu. Chi tiết triển khai không được thay thế yêu cầu quan sát được.
2. Kế hoạch MUST chỉ ra dữ liệu nào được đọc/ghi, ranh giới giữa UI, engine, browser adapter và media
   pipeline, cùng phương án phục hồi khi bước bên ngoài thất bại.
3. Task MUST đủ nhỏ để kiểm tra độc lập và MUST nêu rõ file dự kiến thay đổi. Không trộn refactor lớn
   với thay đổi hành vi nếu không có lý do và kế hoạch kiểm chứng riêng.
4. Trước khi implement, MUST kiểm tra working tree hoặc sao lưu các file không có Git. Không được ghi
   đè thay đổi của người dùng hoặc dùng lệnh phá hủy để làm sạch dự án.
5. Trước khi bàn giao, MUST kiểm tra ít nhất: khởi động bằng `run.bat`, lưu/khôi phục hàng đợi, hành vi
   Pause/Resume/Stop liên quan và một đường thành công cùng một đường lỗi của tính năng mới.
6. Tính năng điều khiển Muse/TikTok MUST có log đủ để phân biệt lỗi đăng nhập, selector, upload,
   xử lý media, timeout và xác minh người dùng.
7. Nếu không thể chạy kiểm thử thực tế vì cần tài khoản hoặc xác minh, phần chưa kiểm thử MUST được
   ghi rõ; không được báo hoàn tất chỉ dựa trên suy luận từ mã.

## Governance

Hiến pháp này là nguồn quy tắc cao nhất cho đặc tả, kế hoạch, task, triển khai và review của dự án.
Khi tài liệu hoặc thực hành khác xung đột, hiến pháp này được ưu tiên cho đến khi được sửa đổi chính
thức.

Sửa đổi hiến pháp MUST gồm: lý do, tác động, kế hoạch chuyển đổi nếu hành vi hiện tại bị ảnh hưởng và
phiên bản mới theo Semantic Versioning. MAJOR áp dụng khi bỏ hoặc định nghĩa lại nguyên tắc theo cách
không tương thích; MINOR áp dụng khi thêm nguyên tắc hoặc mở rộng nghĩa vụ; PATCH áp dụng cho làm rõ
không thay đổi ý nghĩa. Ngày sửa đổi MUST dùng định dạng ISO `YYYY-MM-DD`.

Mọi đặc tả và kế hoạch MUST có Constitution Check trước khi triển khai. Mọi lần bàn giao MUST báo rõ
những kiểm tra đã chạy, những kiểm tra chưa thể chạy và mọi ngoại lệ. Ngoại lệ MUST có phạm vi, lý do,
người chấp thuận và thời hạn xem xét; ngoại lệ không tự trở thành tiền lệ.

Sync Impact Report ở đầu file là tài liệu phục vụ review và SHOULD được xóa trước khi commit bản hiến
pháp đã được chấp thuận.

**Version**: 1.0.0 | **Ratified**: 2026-11-16 | **Last Amended**: 2026-11-16
