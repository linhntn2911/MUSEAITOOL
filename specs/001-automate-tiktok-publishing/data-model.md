# Data Model: Tự động đăng TikTok

## Root Application State

```text
ApplicationState
├── schemaVersion: integer
├── config: MuseConfig                       (giữ tương thích)
├── queue: MuseJob[]                         (giữ tương thích)
├── logs: string[]                           (giữ tương thích)
├── control: MuseControl                     (giữ tương thích)
└── tiktok: TikTokState
```

`schemaVersion` bắt đầu ở phiên bản mới của state. Migration phải idempotent, tạo `tiktok` khi thiếu
và không sửa dữ liệu Muse ngoài chuẩn hóa trường bị thiếu.

## TikTokState

| Field | Type | Rules |
|---|---|---|
| `settings` | TikTokSettings | Luôn tồn tại sau migration |
| `accounts` | TikTokAccount[] | `id`, `cdpPort`, `profilePath` duy nhất |
| `jobs` | PublishingJob[] | `id` duy nhất; liên kết account/media bằng ID |
| `mediaAssets` | MediaAsset[] | Không xóa asset gốc bằng cleanup tự động |
| `contentProfiles` | ContentProfile[] | Phong cách/hashtag tái sử dụng |
| `control` | TikTokControl | Scheduler, pause toàn cục, active job theo account |

## TikTokSettings

| Field | Type | Default/Validation |
|---|---|---|
| `autoPushCompleted` | boolean | `true` |
| `autoGenerateContent` | boolean | `true` |
| `accountMode` | enum | `affiliate` hoặc `no_cart` |
| `defaultTone` | string | `review` |
| `defaultHashtags` | string[] | Chuẩn hóa `#`, không trùng |
| `scheduleMode` | enum | `immediate` hoặc `native_schedule` |
| `firstDelayMinutes` | integer | `>= 0` |
| `intervalMinutes` | integer | `>= 1`, mặc định `60` |
| `defaultAudio` | AudioConfiguration | Tắt gốc, nhạc 85%, loop, fade cuối 0,5s |
| `geminiModel` | string | Mặc định `gemini-3.8-flash`; không chứa API key |
| `showTikTokWindows` | boolean | Trạng thái UI |

## TikTokAccount

| Field | Type | Rules |
|---|---|---|
| `id` | string | UUID/ID nội bộ bất biến |
| `label` | string | Tên gợi nhớ do người dùng đặt |
| `handle` | string/null | `@username` đọc từ phiên |
| `nickname` | string/null | Tên hiển thị |
| `avatarUrl` | string/null | Không bắt buộc |
| `status` | AccountStatus | Xem state machine |
| `profilePath` | string | Riêng, nằm dưới data TikTok profiles |
| `cdpPort` | integer | Riêng, kiểm tra free trước khi launch |
| `paused` | boolean | Chặn cấp job mới |
| `activeJobId` | string/null | Tối đa một job thay đổi |
| `lastCheckedAt` | timestamp/null | Lần xác minh phiên gần nhất |
| `lastError` | ErrorRecord/null | Không chứa cookie/secret |

### AccountStatus

```text
unknown -> opening -> checking -> live
                         |         |
                         v         v
                    login_required / verification_required
live -> busy -> live
any -> paused -> checking -> live (chỉ sau Check + Resume)
```

Khi phiên hết hạn, account và mọi job chưa hoàn tất của account chuyển `paused`. Đăng nhập thành công
chỉ đưa account về trạng thái đã kiểm tra; người dùng vẫn phải Resume.

## PublishingJob

| Field | Type | Rules |
|---|---|---|
| `id` | string | Duy nhất, bất biến |
| `sourceKind` | enum | `muse_result` hoặc `external_file` |
| `sourceFingerprint` | string | Chống tạo job trùng từ cùng kết quả |
| `sourceVideoAssetId` | string | Bắt buộc, trỏ MediaAsset gốc |
| `uploadVideoAssetId` | string/null | Asset đã ghép nhạc hoặc asset gốc |
| `productImageAssetId` | string/null | Ảnh đối chiếu đi cùng job |
| `sourcePrompt` | string | Có thể rỗng với video ngoài |
| `accountId` | string/null | Bắt buộc trước khi `ready` |
| `content` | GeneratedContent | Có version trước/sau chỉnh sửa |
| `accountMode` | enum | `affiliate` hoặc `no_cart` |
| `productMatch` | ShowcaseMatch | Bỏ qua khi `no_cart` |
| `audio` | AudioConfiguration | Có thể kế thừa default |
| `schedule` | PublishingSchedule | Giờ dự kiến/thực tế và điều chỉnh |
| `status` | PublishingStatus | Xem state machine |
| `progress` | integer | Mapping từ status/evidence, 0–100 |
| `progressText` | string | Bước quan sát được, không chứa secret |
| `evidence` | EvidenceRecord[] | Tín hiệu hoàn thành các bước |
| `checkpoint` | Checkpoint | Bước an toàn gần nhất |
| `error` | ErrorRecord/null | Mã, bước, retryable, hành động gợi ý |
| `createdAt`/`updatedAt` | timestamp | Bắt buộc |

### PublishingStatus và chuyển trạng thái

```text
draft
  -> waiting_content -> generating_content -> waiting_product
  -> checking_product -> waiting_product_confirmation
  -> processing_audio -> ready
  -> opening_studio -> uploading -> filling_metadata
  -> configuring_schedule -> submitting
  -> scheduled | posted
  -> needs_reconciliation

Các trạng thái trước submitting có thể -> paused | failed | cancelled
failed -> ready hoặc checkpoint hợp lệ gần nhất sau Retry
needs_reconciliation -> scheduled | posted | ready (sau xác nhận người dùng)
```

Quy tắc:

- `progress=100` chỉ hợp lệ với `scheduled` hoặc `posted` và có evidence xác nhận.
- `submitting` không tự timeout thành `failed`; mất xác nhận thành `needs_reconciliation`.
- `needs_reconciliation` khóa Retry cho đến khi có `ReconciliationDecision` của người dùng.
- `paused` giữ checkpoint và không bắt đầu bước mới.

## MediaAsset

| Field | Type | Rules |
|---|---|---|
| `id` | string | Duy nhất |
| `kind` | enum | `source_video`, `processed_video`, `product_image`, `audio_source` |
| `path` | string | Đường dẫn tuyệt đối trên máy hiện tại |
| `fingerprint` | string | Kích thước + mtime + hash phù hợp |
| `durationSeconds` | number/null | Từ probe, không từ cấu hình |
| `width`/`height` | integer/null | Media hình/video |
| `audioStreams` | integer/null | Dùng kiểm tra nguồn nhạc |
| `parentAssetId` | string/null | Processed asset trỏ source |
| `processingRecipe` | object/null | Offset/volume/loop/fade đã áp dụng |
| `retentionEligibleAt` | timestamp/null | Thành công + 7 ngày |
| `pinned` | boolean | `true` thì cleanup bỏ qua |
| `exists` | boolean | Cập nhật khi scan/probe |

Cleanup chỉ xóa `processed_video` đã đủ thời gian, không pinned, không còn job chưa hoàn tất tham chiếu.

## AudioConfiguration

| Field | Type | Validation |
|---|---|---|
| `mode` | enum | `keep_original`, `replace`, `mix` |
| `audioSourceAssetId` | string/null | Bắt buộc với replace/mix |
| `startSeconds` | number | `>= 0` và nhỏ hơn duration nguồn |
| `originalVolume` | integer | 0–100 |
| `musicVolume` | integer | 0–100 |
| `loopIfShort` | boolean | Mặc định true |
| `fadeInSeconds` | number | `>= 0` |
| `fadeOutSeconds` | number | `>= 0`, nhỏ hơn duration đích |

## GeneratedContent

| Field | Type | Validation |
|---|---|---|
| `title` | string | Không rỗng, giới hạn theo UI |
| `caption` | string | Không rỗng nếu đăng |
| `hashtags` | string[] | Chuẩn hóa, không trùng |
| `cartTitle` | string | Tối đa 30 ký tự khi affiliate |
| `tone` | string | Phong cách đã chọn |
| `version` | integer | Tăng sau mỗi lần AI/chỉnh sửa |
| `previous` | object/null | Một phiên bản gần nhất để khôi phục |
| `source` | enum | `ai`, `manual`, `fallback` |

## ShowcaseMatch

| Field | Type | Rules |
|---|---|---|
| `inputKind` | enum | `exact_id`, `link`, `name`, `image` |
| `inputValue` | string | Không lưu dữ liệu bí mật |
| `candidateId`/`candidateName`/`candidateImage` | string/null | Candidate hiển thị |
| `confidence` | number/null | Chỉ để xếp hạng, không thay quyết định |
| `status` | enum | `unchecked`, `searching`, `candidate`, `confirmed`, `not_found`, `skipped` |
| `confirmedBy` | enum/null | `exact_id` hoặc `user` |
| `confirmedAt` | timestamp/null | Bắt buộc khi confirmed |

Chỉ `inputKind=exact_id` và ID trả về khớp tuyệt đối được `confirmedBy=exact_id`. Tên/ảnh luôn phải
`confirmedBy=user`.

## PublishingSchedule

| Field | Type | Rules |
|---|---|---|
| `mode` | enum | `immediate` hoặc `native_schedule` |
| `requestedAt` | timestamp/null | Giờ người dùng chọn |
| `effectiveAt` | timestamp/null | Sau khi giải quyết xung đột |
| `timezone` | string | Múi giờ máy tại lúc tính lịch |
| `intervalMinutes` | integer | `>= 1` |
| `adjusted` | boolean | True nếu tự dời |
| `adjustmentReason` | string/null | Hiển thị trong UI |
| `remoteResult` | object/null | ID/text/thời gian xác nhận không chứa secret |

Scheduler nhóm theo `accountId`, sắp theo `requestedAt` rồi `createdAt`, và dời job sau đến
`max(requestedAt, previous.effectiveAt + interval)`.

## EvidenceRecord, Checkpoint và ErrorRecord

**EvidenceRecord** lưu `step`, `kind`, `observedAt`, dữ liệu tối thiểu đã redacted và fingerprint nếu
liên quan file. Evidence không lưu DOM/cookie toàn bộ.

**Checkpoint** lưu `step`, `savedAt`, `safeToRetry` và ID media/result liên quan.

**ErrorRecord** lưu `code`, `step`, `messageVi`, `retryable`, `requiresUser`, `occurredAt`; mã lỗi ổn
định để UI lọc và test.

