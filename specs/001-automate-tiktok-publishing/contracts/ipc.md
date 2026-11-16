# IPC Contract: TikTok Publishing

Renderer chỉ được dùng các hàm allowlist do preload cung cấp. Mọi handler trả object có dạng:

```json
{ "ok": true, "data": {} }
```

hoặc:

```json
{
  "ok": false,
  "error": {
    "code": "STABLE_CODE",
    "message": "Thông báo tiếng Việt",
    "retryable": false,
    "requiresUser": true
  }
}
```

Không response/event nào được chứa cookie, API key, secret đã giải mã hoặc raw CDP payload.

## Account Commands

| IPC channel | Input | Output/Effect |
|---|---|---|
| `tiktok:accounts:list` | none | Danh sách account đã redacted |
| `tiktok:accounts:add` | `{ label }` | Tạo profile/cổng, mở login, trả account |
| `tiktok:accounts:check` | `{ accountId }` | Xác minh phiên và danh tính |
| `tiktok:accounts:show` | `{ accountId }` | Hiện cửa sổ đúng profile |
| `tiktok:accounts:hide` | `{ accountId }` | Ẩn cửa sổ nhưng không dừng job |
| `tiktok:accounts:pause` | `{ accountId }` | Tạm dừng account và job chưa hoàn tất |
| `tiktok:accounts:resume` | `{ accountId }` | Chỉ thành công sau check live |
| `tiktok:accounts:remove` | `{ accountId, removeProfile }` | Chặn nếu còn job active; xác nhận riêng profile |

## Queue Commands

| IPC channel | Input | Output/Effect |
|---|---|---|
| `tiktok:jobs:add-muse-results` | `{ museJobIds[] }` | Tạo job, chống trùng fingerprint |
| `tiktok:jobs:add-files` | none | Mở file picker, tạo job cho video chọn |
| `tiktok:jobs:update` | `{ jobId, patch, expectedUpdatedAt }` | Cập nhật có kiểm tra stale edit |
| `tiktok:jobs:remove` | `{ jobIds[], deleteProcessed }` | Xóa job; không xóa source video |
| `tiktok:jobs:run` | `{ jobIds[] }` | Chạy các job đủ điều kiện |
| `tiktok:jobs:pause` | `{ jobIds[] }` | Pause tại checkpoint an toàn |
| `tiktok:jobs:resume` | `{ jobIds[] }` | Resume nếu account live |
| `tiktok:jobs:stop` | `{ jobIds[] }` | Stop, giải phóng lock, giữ checkpoint |
| `tiktok:jobs:retry` | `{ jobIds[] }` | Chặn job needs_reconciliation |
| `tiktok:jobs:reconcile` | `{ jobId, decision }` | `posted`, `scheduled`, hoặc `not_submitted` |
| `tiktok:jobs:recalculate-schedule` | `{ jobIds[] }` | Trả effectiveAt đã điều chỉnh |

`patch` chỉ cho phép trường editable: account, content, accountMode, product input/confirmation, audio
configuration, schedule và pin media. Renderer không được set status/progress/evidence.

## Content and Product Commands

| IPC channel | Input | Output/Effect |
|---|---|---|
| `tiktok:content:test-key` | `{ apiKey }` | Test nhỏ; không broadcast key |
| `tiktok:content:save-key` | `{ apiKey }` | Mã hóa/lưu ở main; trả masked suffix |
| `tiktok:content:generate` | `{ jobIds[] }` | Tạo nội dung, giữ bản cũ nếu lỗi |
| `tiktok:content:restore` | `{ jobIds[] }` | Khôi phục version gần nhất |
| `tiktok:products:verify` | `{ jobIds[] }` | Exact ID auto-confirm; tên/ảnh tạo candidate |
| `tiktok:products:confirm` | `{ jobId, productId }` | Xác nhận user cho candidate |

## Audio Commands

| IPC channel | Input | Output/Effect |
|---|---|---|
| `tiktok:audio:choose-source` | none | File picker video/audio, probe metadata |
| `tiktok:audio:preview` | `{ jobId, config }` | Tạo/phát preview ngắn, không đổi upload asset |
| `tiktok:audio:process` | `{ jobIds[] }` | Tạo processed media và probe lại |
| `tiktok:audio:pin` | `{ mediaAssetId, pinned }` | Bật/tắt giữ lâu dài |
| `tiktok:media:cleanup` | `{ dryRun }` | Liệt kê hoặc xóa processed asset đủ điều kiện |

## State and Events

| IPC channel/event | Direction | Payload |
|---|---|---|
| `tiktok:state:get` | renderer -> main | Snapshot TikTok đã redacted |
| `tiktok:state` | main -> renderer | Snapshot hoặc delta sau mutation |
| `tiktok:log` | main -> renderer | Structured log đã redacted |
| `tiktok:attention` | main -> renderer | Login/CAPTCHA/reconciliation cần người dùng |

Renderer phải unregister listener khi reload để tránh event bị nhân đôi.

