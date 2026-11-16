# Implementation Plan: Tự động đăng TikTok

**Branch**: `001-automate-tiktok-publishing` | **Date**: 2026-11-16 |
**Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-automate-tiktok-publishing/spec.md`

## Summary

Mở rộng ứng dụng Electron hiện tại bằng một mô-đun xuất bản TikTok độc lập: nhận video Muse đã hoàn
tất, chuẩn bị nội dung AI, đối chiếu Showcase, ghép âm thanh từ media khác, phân phối job cho các
profile TikTok riêng và đăng/lên lịch qua TikTok Studio. Thiết kế dùng state machine có checkpoint,
khóa một job thay đổi trên mỗi tài khoản, trạng thái dựa trên bằng chứng và bước đối soát bắt buộc để
ngăn đăng trùng.

## Technical Context

**Language/Version**: JavaScript CommonJS chạy trong Electron/Node.js hiện có; HTML5/CSS cho renderer

**Primary Dependencies**: Electron IPC/contextBridge; Chrome DevTools Protocol qua WebSocket; Chrome;
TikTok Studio; Gemini Developer API structured output; FFmpeg và ffprobe

**Storage**: JSON cục bộ có `schemaVersion` và ghi nguyên tử; Chrome profile riêng cho từng kênh;
thư mục media gốc, media trung gian và metadata dọn file

**Testing**: `node:test` cho unit/contract; adapter TikTok giả cho integration; smoke test Electron;
kiểm thử live có giám sát trên tài khoản TikTok thử nghiệm

**Target Platform**: Windows 10/11 x64, chạy từ `run.bat` trong gói Electron hiện có

**Project Type**: Ứng dụng desktop một project; main process điều phối, renderer chỉ gọi IPC

**Performance Goals**: Thêm và lên lịch dự kiến 20 video trong dưới 10 phút thao tác người dùng; cập
nhật UI trong 500 ms sau thay đổi state; xử lý âm thanh không vượt quá 2 lần thời lượng video trên
máy mục tiêu điển hình; hai tài khoản độc lập chạy song song

**Constraints**: Một job gây thay đổi trên mỗi tài khoản; không vượt CAPTCHA/OTP; không ghi đè media
gốc; không log secret; không tự retry sau hành động cuối chưa được xác nhận; selector TikTok có thể
thay đổi; phải giữ tương thích dữ liệu Muse và `run.bat`

**Scale/Scope**: Một người vận hành cục bộ; hàng đợi kiểm thử 50 job; tối thiểu hai tài khoản chạy
song song; mỗi tài khoản có profile, cổng và khóa riêng; UI tiếng Việt

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Trạng thái thật**: PASS — tiến độ lấy từ checkpoint và bằng chứng adapter/media; không dùng timer
  để giả lập phần trăm; `submitting` không tự chuyển thành thành công.
- **An toàn phiên và secret**: PASS — profile TikTok tách riêng, API key được mã hóa hoặc lấy từ biến
  môi trường, redaction trước log, CAPTCHA/OTP bàn giao cho người dùng.
- **Khả năng phục hồi**: PASS — state machine, timeout, checkpoint, khóa tài khoản, `needs_reconciliation`
  và retry có đối soát.
- **Toàn vẹn media/sản phẩm**: PASS — ảnh tham chiếu đi cùng job; chỉ ID khớp chính xác được tự xác
  nhận; ffprobe xác minh đầu ra; video gốc bất biến; dọn file trung gian sau 7 ngày.
- **Thay đổi kiểm chứng được**: PASS — mô-đun mới có hợp đồng, unit/integration test, smoke test và
  quickstart live; không thay đổi hành vi Muse ngoài điểm nối nhận video hoàn tất.

**Gate result trước nghiên cứu**: PASS. Không có ngoại lệ hiến pháp.

## Project Structure

### Documentation (this feature)

```text
specs/001-automate-tiktok-publishing/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/
│   ├── ipc.md
│   ├── generated-content.schema.json
│   └── state.schema.json
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
source/
├── main.js                         # Composition root + existing Muse IPC
├── preload.js                      # Allowlisted renderer contracts
├── renderer.js                     # Existing Muse UI
├── tiktok-renderer.js              # TikTok tab rendering and actions
├── index.html
├── styles.css
├── muse.js                         # Existing Muse controller, behavior preserved
├── core/
│   ├── state-store.js              # Schema migration + atomic persistence
│   ├── redacted-log.js             # Structured, secret-safe log
│   └── errors.js                   # Stable error codes
├── tiktok/
│   ├── controller.js               # Public orchestration facade
│   ├── account-manager.js          # Profile, CDP port, login state, account lock
│   ├── studio-adapter.js           # TikTok selectors and evidence readers
│   ├── publishing-engine.js        # Per-account workers + job state machine
│   ├── scheduler.js                # Collision resolution and native schedule
│   ├── product-matcher.js          # ID/name/image candidate verification
│   └── reconciliation.js           # Unknown-result/manual confirmation flow
├── services/
│   ├── content-generator.js        # Gemini structured content + validation
│   ├── secret-store.js             # Environment/encrypted local secret
│   ├── media-probe.js              # Duration/stream validation
│   ├── audio-mixer.js              # Trim/loop/mix/fade into new file
│   └── media-cleanup.js             # Seven-day retention + pin handling
└── models/
    ├── state-machine.js
    └── validators.js

tests/
├── unit/
│   ├── scheduler.test.js
│   ├── state-machine.test.js
│   ├── content-validator.test.js
│   └── retention.test.js
├── contract/
│   ├── ipc.test.js
│   ├── state-schema.test.js
│   └── generated-content.test.js
├── integration/
│   ├── state-recovery.test.js
│   ├── audio-pipeline.test.js
│   └── publishing-engine.test.js
└── fixtures/
    ├── fake-studio-adapter.js
    └── media/

scripts/
├── build-asar.ps1
└── smoke-test.ps1
```

**Structure Decision**: Giữ mô hình desktop một project và CommonJS để tương thích app hiện có.
`main.js` chỉ làm composition root/IPC; logic mới đi vào các mô-đun nhỏ. `studio-adapter.js` là nơi
duy nhất chứa selector TikTok; renderer không được truy cập filesystem, secret hoặc CDP trực tiếp.
Các test dùng adapter giả, còn live test chỉ chạy có giám sát.

### Post-design Constitution Check

- **Trạng thái thật**: PASS — state machine và evidence contract định nghĩa rõ tín hiệu cho từng bước.
- **An toàn phiên/secret**: PASS — isolation và redaction xuất hiện trong data model, IPC contract và
  quickstart.
- **Phục hồi**: PASS — `needs_reconciliation`, account pause/resume và recovery path được mô hình hóa.
- **Media/sản phẩm**: PASS — data model giữ provenance, kiểm tra ID và retention không xóa bản gốc.
- **Kiểm chứng**: PASS — test tree, contract schemas và quickstart bao phủ đường thành công/lỗi.

**Gate result sau thiết kế**: PASS. Không có vi phạm cần ghi Complexity Tracking.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

Không có vi phạm hiến pháp cần biện minh.
