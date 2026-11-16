# Feature Specification: Tự động đăng TikTok

**Feature Branch**: `001-automate-tiktok-publishing`

**Created**: 2026-11-16

**Status**: Draft

**Input**: User description: "Tự động nhận video đã sản xuất, viết nội dung, gắn đúng sản phẩm,
xử lý nhạc lấy từ video khác và đăng hoặc lên lịch trên nhiều kênh TikTok."

## Clarifications

### Session 2026-11-16

- Q: Khi nhiều job của cùng một kênh có giờ đăng trùng hoặc gần nhau hơn khoảng giãn cách đã đặt,
  tool nên xử lý thế nào? → A: Tự động dời job sau sang khung giờ hợp lệ tiếp theo và hiển thị giờ
  đã điều chỉnh.
- Q: Nếu tool mất xác nhận sau khi đã bấm đăng hoặc lên lịch, job nên được xử lý thế nào? → A: Chuyển
  job sang `Cần đối soát`, mở đúng kênh để người dùng xác nhận đã đăng/chưa đăng trước khi cho phép
  chạy lại.
- Q: Sau khi bài đăng hoặc lên lịch thành công, các file video trung gian đã ghép nhạc nên được giữ
  bao lâu? → A: Giữ 7 ngày rồi tự xóa; luôn giữ video gốc và cho phép người dùng ghim file trung gian
  để giữ lâu dài.
- Q: Khi tool tìm sản phẩm Showcase, trường hợp nào được phép tự xác nhận mà không cần người dùng
  kiểm tra? → A: Chỉ kết quả có ID sản phẩm khớp chính xác được tự xác nhận; kết quả tìm bằng tên
  hoặc ảnh luôn cần người dùng xác nhận.
- Q: Nếu phiên đăng nhập của một kênh hết hạn khi kênh còn nhiều job đang chờ, tool nên tiếp tục thế
  nào sau khi người dùng đăng nhập lại? → A: Giữ nguyên và tạm dừng toàn bộ job của kênh; sau khi
  đăng nhập và kiểm tra thành công, người dùng phải bấm Resume để tiếp tục.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Đưa video hoàn tất vào hàng đợi TikTok (Priority: P1)

Người vận hành có thể tự động chuyển video vừa sản xuất hoặc chọn video từ máy vào một hàng đợi
đăng TikTok. Mỗi video giữ được ảnh sản phẩm đối chiếu, prompt nguồn và các dữ liệu cần thiết để
chuẩn bị bài đăng.

**Why this priority**: Đây là điểm nối bắt buộc giữa quy trình sản xuất video và quy trình đăng bài;
không có hàng đợi thì các chức năng còn lại không có đầu vào đáng tin cậy.

**Independent Test**: Tạo xong một video, bật tự động chuyển, rồi xác minh một job xuất hiện đúng một
lần với đúng video và ảnh sản phẩm. Lặp lại bằng một video chọn từ máy.

**Acceptance Scenarios**:

1. **Given** một video vừa hoàn tất và tùy chọn tự đưa vào hàng đợi đang bật, **When** kết quả được
   xác nhận hoàn tất, **Then** hệ thống tạo đúng một job TikTok chứa video và dữ liệu đối chiếu.
2. **Given** người dùng chọn nhiều video từ máy, **When** bấm `Đưa vào hàng đợi`, **Then** mỗi video
   tạo thành một job riêng và có thể chỉnh sửa độc lập.
3. **Given** một video đã có trong hàng đợi, **When** nguồn phát lại cùng sự kiện hoàn tất, **Then**
   hệ thống không tạo job trùng.

---

### User Story 2 - Đăng hoặc lên lịch an toàn (Priority: P1)

Người vận hành chọn kênh, chế độ đăng ngay hoặc lên lịch và thời gian mong muốn. Hệ thống chuẩn bị
bài đăng, kiểm tra điều kiện an toàn, thực hiện trên đúng tài khoản và xác nhận kết quả.

**Why this priority**: Giá trị chính của tính năng là giảm thao tác đăng thủ công nhưng không được
đăng nhầm tài khoản, nhầm thời gian hoặc đăng trùng.

**Independent Test**: Dùng một kênh thử nghiệm để đăng một video ngay và lên lịch một video khác,
sau đó đối chiếu kênh, nội dung, thời gian và trạng thái kết quả.

**Acceptance Scenarios**:

1. **Given** một job hợp lệ đã chọn đúng kênh và chế độ đăng ngay, **When** người dùng chạy job,
   **Then** bài được gửi tới đúng kênh và job chỉ đạt 100% sau khi có xác nhận thành công.
2. **Given** một job có thời gian hợp lệ trong tương lai, **When** người dùng chọn lên lịch, **Then**
   bài xuất hiện trong lịch của đúng kênh với thời gian đã chọn.
3. **Given** người dùng yêu cầu lên lịch nhưng màn hình cuối chỉ cho phép đăng ngay, **When** hệ thống
   kiểm tra hành động cuối, **Then** job dừng với cảnh báo và không bấm đăng.
4. **Given** job đang ở trạng thái không rõ sau khi tool khởi động lại, **When** người dùng tiếp tục,
   **Then** hệ thống đối soát trước và không tự động đăng lại.
5. **Given** hai job của cùng một kênh có giờ đăng trùng hoặc không đủ khoảng giãn cách, **When** hệ
   thống tính lịch, **Then** job sau được dời tới khung giờ hợp lệ tiếp theo và giờ mới được hiển thị.
6. **Given** hệ thống đã bấm đăng hoặc lên lịch nhưng không nhận được xác nhận cuối, **When** job kết
   thúc chờ hoặc tool được mở lại, **Then** job chuyển sang `Cần đối soát`, mở được đúng kênh để kiểm
   tra và không cho phép chạy lại trước khi người dùng xác nhận kết quả.

---

### User Story 3 - Dùng nhạc lấy từ video hoặc file khác (Priority: P1)

Người vận hành chọn một video hoặc file âm thanh làm nguồn nhạc, chọn điểm bắt đầu, âm lượng tiếng
gốc, âm lượng nhạc và cách xử lý khi nguồn ngắn hơn. Hệ thống tạo video đăng có âm thanh khớp đúng
thời lượng thực tế của từng video.

**Why this priority**: Người dùng không muốn phụ thuộc vào nhạc đề xuất ngẫu nhiên và cần bảo đảm
không có phần âm thanh thừa hoặc kết thúc đột ngột.

**Independent Test**: Áp dụng một nguồn nhạc dài hơn và một nguồn ngắn hơn cho hai video có thời
lượng khác nhau, rồi kiểm tra thời lượng, điểm bắt đầu, âm lượng và phần kết thúc.

**Acceptance Scenarios**:

1. **Given** nguồn nhạc dài hơn video đích, **When** xử lý âm thanh, **Then** phần dư bị cắt và âm
   thanh kết thúc cùng video.
2. **Given** nguồn nhạc ngắn hơn video đích và tự lặp được bật, **When** xử lý âm thanh, **Then** nhạc
   được lặp đủ và cắt chính xác theo video.
3. **Given** người dùng đặt tiếng gốc bằng 0% và nhạc bằng 85%, **When** mở file kết quả, **Then** không
   nghe tiếng gốc và mức nhạc phản ánh cấu hình đã chọn.
4. **Given** xử lý âm thanh thất bại, **When** job chuẩn bị upload, **Then** hệ thống dừng, giữ video
   gốc nguyên vẹn và hiển thị lỗi có thể hành động.
5. **Given** bài đã đăng hoặc lên lịch thành công và file trung gian không được ghim, **When** đủ 7
   ngày, **Then** hệ thống tự xóa file trung gian nhưng vẫn giữ nguyên video gốc.

---

### User Story 4 - AI chuẩn bị nội dung bài đăng (Priority: P2)

Người vận hành có thể yêu cầu hệ thống viết tiêu đề, caption, hashtag và tên hiển thị giỏ hàng dựa
trên video, ảnh sản phẩm và phong cách đã chọn. Người dùng luôn có thể sửa trực tiếp hoặc khôi phục
phiên bản trước.

**Why this priority**: Tự động viết nội dung giảm thời gian chuẩn bị hàng loạt, nhưng video vẫn có thể
đăng thủ công nếu dịch vụ viết nội dung tạm thời không hoạt động.

**Independent Test**: Chọn ba phong cách khác nhau cho cùng một sản phẩm, tạo nội dung, chỉnh sửa
một bản và khôi phục bản trước mà không ảnh hưởng video hay job khác.

**Acceptance Scenarios**:

1. **Given** job có ảnh và mô tả sản phẩm, **When** người dùng bấm `AI viết chọn`, **Then** hệ thống
   tạo nội dung có cấu trúc, không bỏ trống tiêu đề/caption và không lặp hashtag.
2. **Given** job ở chế độ không giỏ hàng, **When** nội dung được tạo, **Then** nội dung không nhắc giỏ
   hàng, link mua hoặc lời kêu gọi mua hàng trực tiếp.
3. **Given** dịch vụ viết nội dung lỗi, **When** yêu cầu hoàn tất, **Then** nội dung cũ vẫn được giữ và
   người dùng nhận thông báo lỗi rõ ràng.

---

### User Story 5 - Gắn đúng sản phẩm Showcase (Priority: P2)

Ở chế độ có giỏ hàng, người vận hành có thể cung cấp ID, link, từ khóa hoặc dùng ảnh sản phẩm để tìm
sản phẩm tương ứng. Hệ thống hiển thị kết quả để xác minh trước khi cho phép đăng.

**Why this priority**: Gắn nhầm sản phẩm gây thiệt hại trực tiếp; tự động hóa chỉ có giá trị khi giữ
được mối liên hệ giữa video và sản phẩm.

**Independent Test**: Kiểm tra một sản phẩm bằng ID, một sản phẩm bằng từ khóa/ảnh và một trường hợp
không tìm thấy; xác minh chỉ hai trường hợp đúng được phép tiếp tục.

**Acceptance Scenarios**:

1. **Given** một ID sản phẩm hợp lệ có trong Showcase, **When** kiểm tra, **Then** hệ thống hiển thị
   đúng tên, ảnh và ID để xác nhận.
2. **Given** không nhập ID nhưng có ảnh sản phẩm, **When** kiểm tra, **Then** hệ thống đề xuất kết quả
   phù hợp và đánh dấu cần xác nhận nếu độ tin cậy chưa đủ.
3. **Given** job bắt buộc gắn giỏ nhưng chưa có sản phẩm được xác minh, **When** người dùng chạy job,
   **Then** job dừng trước bước đăng.
4. **Given** kênh ở chế độ không giỏ hàng, **When** chạy job, **Then** toàn bộ bước Showcase được bỏ
   qua mà không tạo lỗi.
5. **Given** sản phẩm được tìm thấy bằng ID khớp chính xác, **When** hoàn tất kiểm tra, **Then** hệ
   thống có thể tự xác nhận sản phẩm; nếu kết quả đến từ tên hoặc ảnh, **Then** job phải chờ người
   dùng xác nhận trước khi đăng.

---

### User Story 6 - Quản lý nhiều kênh độc lập (Priority: P2)

Người vận hành thêm nhiều kênh TikTok, đăng nhập từng kênh trong cửa sổ riêng và phân job cho từng
kênh. Các kênh có thể làm việc song song mà không lẫn phiên đăng nhập.

**Why this priority**: Sản xuất hàng loạt cần nhiều kênh, nhưng cách ly tài khoản quan trọng hơn tốc
độ chạy đồng thời.

**Independent Test**: Thêm hai kênh thử nghiệm, kiểm tra danh tính từng kênh và chạy mỗi kênh một
job; xác minh không job nào xuất hiện trên sai tài khoản.

**Acceptance Scenarios**:

1. **Given** người dùng thêm một kênh mới, **When** đăng nhập hoàn tất, **Then** hệ thống hiển thị đúng
   nickname, tên người dùng và trạng thái sẵn sàng.
2. **Given** hai kênh đã sẵn sàng, **When** mỗi kênh nhận một job, **Then** hai job có thể tiến hành
   độc lập mà không chia sẻ phiên.
3. **Given** hai job cùng chọn một kênh, **When** chạy đồng thời, **Then** chỉ một job được thực hiện
   hành động thay đổi tại một thời điểm và job còn lại chờ.
4. **Given** phiên đăng nhập của kênh hết hạn khi còn job đang chờ, **When** người dùng đăng nhập và
   kiểm tra lại thành công, **Then** các job vẫn tạm dừng và chỉ tiếp tục sau khi người dùng bấm
   Resume.

---

### User Story 7 - Theo dõi, tạm dừng và phục hồi job (Priority: P2)

Người vận hành xem được bước thực tế và phần trăm tiến độ của từng job, đồng thời có thể Pause,
Resume, Stop, chạy lại lỗi hoặc xóa job mà không làm job đã xóa xuất hiện lại sau khi mở tool.

**Why this priority**: Automation kéo dài cần khả năng kiểm soát, chẩn đoán và phục hồi; trạng thái
sai làm người dùng mất niềm tin và có thể gây đăng trùng.

**Independent Test**: Tạm dừng một job giữa các bước, khởi động lại tool, tiếp tục job, xóa một job
lỗi rồi mở lại tool để kiểm tra dữ liệu được giữ đúng.

**Acceptance Scenarios**:

1. **Given** một job đang hoạt động, **When** bấm Pause, **Then** job không bắt đầu bước mới và trạng
   thái hiện tại được lưu.
2. **Given** một job bị Stop, **When** người dùng chạy lại, **Then** hệ thống đối soát trước khi lặp
   hành động có thể tạo hoặc đăng nội dung.
3. **Given** một job lỗi đã bị xóa, **When** đóng và mở lại tool, **Then** job không xuất hiện trở lại.
4. **Given** một job đang chạy, **When** chưa có bằng chứng hoàn thành bước hiện tại, **Then** phần
   trăm không tự tăng chỉ vì thời gian trôi qua.

### Edge Cases

- Phiên đăng nhập hết hạn, xuất hiện CAPTCHA, OTP hoặc xác minh thiết bị giữa quy trình.
- Kênh đã đăng nhập nhưng không có quyền truy cập TikTok Studio hoặc Showcase.
- Video nguồn bị di chuyển, xóa, hỏng hoặc có định dạng không được hỗ trợ.
- Nguồn nhạc không có âm thanh, ngắn hơn đoạn bắt đầu hoặc bị xóa sau khi gán cho job.
- Thời lượng video thực tế khác thời lượng cấu hình ban đầu.
- Thời gian lên lịch nằm trong quá khứ, quá gần hiện tại, ngoài phạm vi cho phép hoặc trùng lịch của
  cùng một kênh.
- Nội dung AI trả về thiếu trường, quá dài, hashtag trùng hoặc chứa tuyên bố không có căn cứ.
- Nhiều sản phẩm Showcase có tên/ảnh gần giống nhau nhưng không đủ độ tin cậy để tự chọn.
- Mất mạng hoặc đóng tool sau khi bấm đăng nhưng trước khi nhận xác nhận.
- Giao diện TikTok thay đổi khiến không xác định chắc chắn ô nhập hoặc nút hành động.
- Người dùng xóa job đang chạy hoặc xóa kênh vẫn còn job chưa hoàn tất.
- File video đã đăng thành công nhưng phản hồi trạng thái bị mất; hệ thống phải tránh đăng lại mù.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Hệ thống MUST nhận video hoàn tất từ Xưởng Video và video do người dùng chọn từ máy.
- **FR-002**: Hệ thống MUST tạo một job độc lập cho mỗi video và chống tạo job trùng từ cùng một kết
  quả hoàn tất.
- **FR-003**: Mỗi job MUST giữ liên kết tới video, ảnh sản phẩm đối chiếu, prompt nguồn và lịch sử
  trạng thái liên quan.
- **FR-004**: Người dùng MUST có thể chọn, tìm kiếm, lọc, chỉnh sửa, chạy, tạm dừng, tiếp tục, dừng,
  chạy lại và xóa job.
- **FR-005**: Xóa job MUST được lưu bền vững và MUST NOT xóa video gốc nếu người dùng chưa xác nhận
  riêng việc xóa file.
- **FR-006**: Hệ thống MUST hỗ trợ nhiều kênh TikTok với phiên đăng nhập cách ly cho từng kênh.
- **FR-007**: Hệ thống MUST hiển thị danh tính và trạng thái đăng nhập của kênh trước khi cho phép
  phân job. Khi phiên hết hạn, hệ thống MUST giữ nguyên và tạm dừng toàn bộ job của kênh; sau khi
  đăng nhập và kiểm tra thành công, các job MUST chỉ tiếp tục khi người dùng bấm Resume.
- **FR-008**: Mỗi kênh MUST chỉ thực hiện một hành động gây thay đổi tại một thời điểm; các kênh khác
  MAY hoạt động song song.
- **FR-009**: Người dùng MUST có thể chọn kênh riêng cho từng job hoặc áp dụng kênh cho nhiều job.
- **FR-010**: Hệ thống MUST hỗ trợ đăng ngay và lên lịch cho một thời điểm cụ thể.
- **FR-011**: Người dùng MUST có thể đặt thời gian bắt đầu và khoảng cách giữa các bài khi lên lịch
  hàng loạt. Khi lịch của cùng một kênh bị trùng hoặc không đủ khoảng cách, hệ thống MUST tự động dời
  job sau tới khung giờ hợp lệ tiếp theo và MUST hiển thị thời gian đã điều chỉnh trước khi chạy.
- **FR-012**: Trước hành động cuối, hệ thống MUST xác minh đúng kênh, đúng video, nội dung đã điền,
  trạng thái video sẵn sàng và chế độ đăng/lịch đúng yêu cầu.
- **FR-013**: Nếu không xác định chắc chắn hành động cuối là đăng hay lên lịch, hệ thống MUST dừng và
  không thực hiện hành động.
- **FR-014**: Hệ thống MUST xác minh kết quả sau khi gửi và chỉ đánh dấu job 100% khi có bằng chứng
  đăng hoặc lên lịch thành công.
- **FR-015**: Hệ thống MUST hỗ trợ chế độ có giỏ hàng và không giỏ hàng.
- **FR-016**: Ở chế độ có giỏ hàng, người dùng MUST có thể tìm sản phẩm bằng ID, link, từ khóa hoặc
  ảnh đối chiếu.
- **FR-017**: Hệ thống MUST hiển thị tên, ảnh và định danh sản phẩm được tìm thấy để người dùng kiểm
  tra.
- **FR-018**: Job yêu cầu giỏ hàng MUST NOT tiếp tục đăng nếu sản phẩm chưa được xác minh hoặc người
  dùng chưa xác nhận tay. Chỉ kết quả có ID sản phẩm khớp chính xác MAY được tự xác nhận; mọi kết quả
  tìm bằng tên hoặc ảnh MUST chờ người dùng xác nhận.
- **FR-019**: Ở chế độ không giỏ hàng, hệ thống MUST bỏ qua bước sản phẩm và nội dung tự động MUST
  không nhắc giỏ hàng, link mua hoặc lời kêu gọi mua trực tiếp.
- **FR-020**: Người dùng MUST có thể yêu cầu tạo tiêu đề, caption, hashtag và tên hiển thị giỏ hàng
  theo phong cách lựa chọn.
- **FR-021**: Nội dung được tạo MUST có cấu trúc hợp lệ, không lặp hashtag và tuân thủ giới hạn ký tự
  hiển thị cho từng trường.
- **FR-022**: Người dùng MUST có thể sửa trực tiếp nội dung, xem tối đa hai dòng khi thu gọn và khôi
  phục phiên bản trước lần viết lại gần nhất.
- **FR-023**: Khi việc tạo nội dung thất bại, hệ thống MUST giữ nội dung trước đó và hiển thị lỗi có
  thể hành động.
- **FR-024**: Người dùng MUST có thể chọn một video hoặc file âm thanh làm nguồn nhạc chung hoặc
  nguồn riêng cho từng job.
- **FR-025**: Người dùng MUST có thể chọn điểm bắt đầu, âm lượng tiếng gốc, âm lượng nhạc, tự lặp,
  fade đầu và fade cuối.
- **FR-026**: Hệ thống MUST dùng thời lượng thực tế của video đích để cắt hoặc lặp âm thanh và MUST
  không để âm thanh kéo dài sau hình.
- **FR-027**: Xử lý âm thanh MUST tạo kết quả riêng và MUST NOT ghi đè video gốc. File trung gian của
  job đã đăng/lên lịch thành công MUST được tự xóa sau 7 ngày, trừ khi người dùng đánh dấu giữ lâu
  dài; việc dọn file trung gian MUST NOT xóa video gốc.
- **FR-028**: Hệ thống MUST kiểm tra video đã xử lý trước khi dùng làm file upload và MUST dừng nếu
  kết quả không hợp lệ.
- **FR-029**: Mỗi job MUST hiển thị trạng thái, bước hiện tại, phần trăm dựa trên bằng chứng và lỗi
  cụ thể nếu có.
- **FR-030**: Pause MUST ngăn bắt đầu bước mới mà không đóng đột ngột job đang ở giữa một bước không
  thể ngắt an toàn.
- **FR-031**: Stop MUST giải phóng kênh và lưu đủ dữ liệu để đối soát hoặc chạy lại.
- **FR-032**: Retry MUST kiểm tra trạng thái bên ngoài trước khi lặp hành động có thể tạo hoặc đăng
  nội dung. Job đã gửi hành động cuối nhưng mất xác nhận MUST NOT được chạy lại cho đến khi người dùng
  xác nhận thủ công bài đã đăng/lên lịch hay chưa.
- **FR-033**: Sau khi khởi động lại, các job đang upload hoặc chờ xác nhận MUST chuyển sang trạng
  thái `Cần đối soát` thay vì tự chạy lại. Hệ thống MUST cho phép mở đúng kênh liên quan để người dùng
  kiểm tra và ghi nhận kết quả đối soát.
- **FR-034**: Hệ thống MUST lưu hàng đợi sau mỗi thay đổi trạng thái quan trọng và khôi phục đúng sau
  khi đóng/mở tool.
- **FR-035**: Log MUST cho biết thời gian, kênh, job, bước và lỗi nhưng MUST NOT hiển thị cookie, khóa
  bí mật hoặc thông tin xác thực đầy đủ.
- **FR-036**: CAPTCHA, OTP và xác minh thiết bị MUST được bàn giao cho người dùng; hệ thống MUST NOT
  tự động vượt các bước bảo mật này.
- **FR-037**: Hệ thống MUST có nút kiểm tra tất cả kênh, hiện/ẩn cửa sổ TikTok và dọn các job đã hoàn
  tất hoặc lỗi sau xác nhận.
- **FR-038**: Hệ thống MUST hỗ trợ chạy một dòng, các dòng được chọn hoặc toàn bộ job đủ điều kiện.

### Key Entities *(include if feature involves data)*

- **TikTok Account**: Một kênh đã được người dùng thêm; gồm định danh nội bộ, tên hiển thị, tên người
  dùng, trạng thái đăng nhập, trạng thái bận/tạm dừng và dữ liệu phiên được cách ly.
- **Publishing Job**: Đại diện cho một video cần đăng; liên kết video, dữ liệu sản phẩm, nội dung,
  kênh, cấu hình âm thanh, lịch, trạng thái, tiến độ, lỗi và lịch sử hoạt động.
- **Media Asset**: Video gốc, video đã xử lý âm thanh, ảnh sản phẩm hoặc nguồn nhạc; có đường dẫn,
  loại, thời lượng, trạng thái tồn tại, thời điểm đủ điều kiện dọn, cờ giữ lâu dài và quan hệ với job.
- **Generated Content**: Tiêu đề, caption, hashtag, tên giỏ hàng, phong cách và lịch sử phiên bản để
  chỉnh sửa hoặc khôi phục.
- **Showcase Match**: Kết quả đối chiếu sản phẩm; gồm dữ liệu đầu vào, sản phẩm đề xuất, tên, ảnh,
  định danh, mức tin cậy, trạng thái xác minh và xác nhận người dùng.
- **Publishing Schedule**: Chế độ đăng, thời điểm dự kiến, múi giờ, khoảng cách giữa bài và kết quả
  lịch thực tế của từng job.
- **Audio Configuration**: Nguồn nhạc, điểm bắt đầu, mức âm lượng, quy tắc lặp/fade và trạng thái xử
  lý của media đầu ra.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Người dùng có thể đưa 20 video vào hàng đợi, chọn kênh và tạo lịch dự kiến trong không
  quá 10 phút, không tính thời gian đăng nhập hoặc xác minh bảo mật thủ công.
- **SC-002**: Trong kiểm thử với ít nhất 50 job, 100% job được gửi tới đúng kênh đã chọn và không có
  job nào bị đăng trùng do khởi động lại hoặc chạy lại lỗi.
- **SC-003**: 100% job yêu cầu giỏ hàng bị chặn trước khi đăng nếu sản phẩm chưa được xác minh hoặc
  xác nhận tay.
- **SC-004**: Ít nhất 95% nội dung tự động hợp lệ ngay lần đầu theo cấu trúc và giới hạn trường; mọi
  trường hợp còn lại giữ được nội dung cũ và có thể sửa tay.
- **SC-005**: Với ít nhất 20 cặp video/nhạc có độ dài khác nhau, 100% file kết quả không có âm thanh
  kéo dài sau hình và sai lệch kết thúc không vượt quá 0,05 giây.
- **SC-006**: 100% job chỉ hiển thị 100% sau khi có bằng chứng kết quả; tiến độ không tăng khi bước
  hiện tại không thay đổi.
- **SC-007**: Sau khi đóng/mở tool ở mọi trạng thái chính, 100% job được khôi phục đúng hoặc chuyển
  sang trạng thái cần đối soát, không tự tạo hành động bên ngoài.
- **SC-008**: Người dùng có thể nhận biết nguyên nhân và hành động tiếp theo cho ít nhất 95% lỗi mô
  phỏng mà không cần đọc log kỹ thuật đầy đủ.
- **SC-009**: Hai kênh độc lập có thể xử lý đồng thời mà không chia sẻ phiên; hai job trên cùng kênh
  không thực hiện hành động thay đổi đồng thời.
- **SC-010**: Một người dùng quen với giao diện có thể hoàn tất luồng từ chọn video đến tạo job sẵn
  sàng đăng trong không quá 3 phút cho một video.

## Assumptions

- Người dùng sở hữu hoặc được phép quản lý các tài khoản TikTok và nội dung được đăng.
- Người dùng tự xử lý đăng nhập, OTP, CAPTCHA và các bước xác minh tài khoản.
- Máy Windows có kết nối mạng ổn định và còn đủ dung lượng cho video trung gian.
- TikTok Studio và Showcase có thể khác nhau theo khu vực, loại tài khoản hoặc quyền của kênh.
- Mặc định mỗi kênh xử lý một job thay đổi tại một thời điểm; nhiều kênh được phép hoạt động song
  song.
- Mặc định lịch hàng loạt bắt đầu sau một khoảng đệm an toàn và cách nhau 60 phút; người dùng có thể
  chỉnh trước khi chạy.
- Mặc định tắt tiếng gốc, dùng nhạc ở mức 85%, tự lặp khi thiếu và fade cuối 0,5 giây; người dùng có
  thể thay đổi theo job.
- File video trung gian của job thành công được giữ 7 ngày để đối soát; người dùng có thể ghim file
  cần giữ lâu dài, còn video gốc không bị quy trình dọn tự động xóa.
- File âm thanh/video nguồn phải thuộc quyền sử dụng của người dùng; hệ thống không đảm bảo nội dung
  tránh được mọi khiếu nại bản quyền.
- Khi giao diện bên thứ ba thay đổi và hệ thống không chắc chắn về hành động, ưu tiên dừng an toàn hơn
  là tiếp tục đoán.
- Việc phân tích hiệu quả bài đăng, doanh thu, bình luận và tin nhắn nằm ngoài phạm vi feature này.
- Việc tự động vượt cơ chế bảo mật, lấy cookie từ ứng dụng khác hoặc sử dụng API không được cấp phép
  nằm ngoài phạm vi feature này.
