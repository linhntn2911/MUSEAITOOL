---
description: "Task list for TikTok publishing automation feature implementation"
---

# Tasks: Tự động đăng TikTok

**Input**: Design documents from `/specs/001-automate-tiktok-publishing/`  
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/  
**Target Platform**: Windows 10/11 x64, Electron CommonJS, `run.bat`

## Format: `- [ ] [TaskID] [P?] [Story?] Description with file path`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (e.g., `[US1]`, `[US2]`, `[US3]`, `[US4]`, `[US5]`, `[US6]`, `[US7]`)
- File paths are exact and located in `source/`, `tests/`, or `scripts/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, directory structure, test harness, and build scripts.

- [X] T001 Create directory structure for core, models, services, tiktok modules, test folders, and scripts per implementation plan (`source/core/`, `source/models/`, `source/services/`, `source/tiktok/`, `tests/unit/`, `tests/contract/`, `tests/integration/`, `tests/fixtures/`, `scripts/`)
- [X] T002 [P] Configure Node.js test runner harness in `tests/run-all.js` using native `node:test` and `node:assert`
- [X] T003 [P] Create mock fixtures and fake adapter stub in `tests/fixtures/fake-studio-adapter.js` for simulated CDP interactions
- [X] T004 [P] Create build packaging script in `scripts/build-asar.ps1` ensuring compatibility with Electron packaging and `run.bat`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure, atomic persistence, secret-safe logging, and state machines that MUST be complete before ANY user story can be implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 [P] Implement stable error codes and user-facing error helpers in `source/core/errors.js` (including codes `STABLE_CODE`, `LOGIN_REQUIRED`, `CAPTCHA_DETECTED`, `SCHEDULE_COLLISION`, `RECONCILIATION_NEEDED`)
- [X] T006 [P] Implement structured logging with secret redaction in `source/core/redacted-log.js` ensuring cookie, API key, bearer token, and raw CDP payload are stripped
- [X] T007 [P] Implement state and entity validators in `source/models/validators.js` enforcing rules: `schemaVersion: integer`, `TikTokSettings` defaults (`autoPushCompleted=true`, `intervalMinutes=60`, `geminiModel="gemini-3.8-flash"`), `TikTokAccount` uniqueness (`id`, `cdpPort`, `profilePath`), `PublishingJob` constraints (`id`, `sourceFingerprint`, `sourceVideoAssetId`)
- [X] T008 [P] Implement state machine transitions and evidence mapping in `source/models/state-machine.js` enforcing valid paths (`draft -> waiting_content -> generating_content -> waiting_product -> checking_product -> waiting_product_confirmation -> processing_audio -> ready -> opening_studio -> uploading -> filling_metadata -> configuring_schedule -> submitting -> scheduled | posted | needs_reconciliation`), and rule: `progress=100` only valid with `scheduled` or `posted` and verified evidence
- [X] T009 Implement atomic state store and idempotent migration in `source/core/state-store.js` using temporary file write and safe rename to preserve Muse state and persist `tiktok: TikTokState`
- [X] T010 [P] Create state schema contract tests in `tests/contract/state-schema.test.js` validating root `ApplicationState` and `contracts/state.schema.json`
- [X] T011 [P] Create state machine unit tests in `tests/unit/state-machine.test.js` validating transition rules, pause/resume limits, and checkpoint tracking

**Checkpoint**: Foundation ready - state store, validators, and state machine verified. User story implementation can now begin.

---

## Phase 3: User Story 1 - Đưa video hoàn tất vào hàng đợi TikTok (Priority: P1) 🎯 MVP

**Goal**: Operator can automatically receive finished videos from Muse or pick videos from local storage into an independent TikTok publishing queue with deduplication and metadata retention.

**Independent Test**: Complete a video in Muse with auto-push enabled; verify exactly one job is created with source video and product image. Pick external video files via dialog; verify individual jobs are created and duplicate events are ignored.

### Tests for User Story 1
- [X] T012 [P] [US1] Create queue IPC contract tests in `tests/contract/ipc.test.js` covering `tiktok:jobs:add-muse-results` and `tiktok:jobs:add-files`
- [X] T013 [P] [US1] Create unit tests for fingerprint generation and deduplication in `tests/unit/queue-dedup.test.js`

### Implementation for User Story 1
- [X] T014 [US1] Implement queue addition, fingerprint calculation (`sourceFingerprint`), and deduplication in `source/tiktok/controller.js`
- [X] T015 [US1] Hook video completion event in `source/muse.js` to dispatch completed video and product image reference to TikTok queue when `settings.autoPushCompleted === true`
- [X] T016 [US1] Expose queue IPC channels in `source/preload.js` (`tiktok:jobs:add-muse-results`, `tiktok:jobs:add-files`, `tiktok:jobs:remove`, `tiktok:state:get`, `tiktok:state`) via `contextBridge.exposeInMainWorld("tiktokApp", ...)`
- [X] T017 [US1] Register main process IPC handlers for queue management in `source/main.js`
- [X] T018 [P] [US1] Add TikTok navigation tab, queue table container, and modal layout in `source/index.html`
- [X] T019 [P] [US1] Add UI styling for TikTok tab, table rows, badges, and modals in `source/styles.css`
- [X] T020 [US1] Implement queue table rendering, Add Files dialog trigger, and job removal in `source/tiktok-renderer.js`

**Checkpoint**: User Story 1 is functional as MVP. Videos from Muse and disk can be queued, deduplicated, and displayed in the UI.

---

## Phase 4: User Story 2 - Đăng hoặc lên lịch an toàn (Priority: P1)

**Goal**: Operator configures account, immediate/native scheduled mode, and timing; engine verifies channel, video, metadata, and schedule controls, automatically resolves schedule collisions, executes CDP automation, halts on mismatch, and confirms evidence before marking 100%.

**Independent Test**: Use test account and fake adapter to test immediate publish and native schedule; verify schedule collision resolution automatically shifts subsequent jobs by `>= 1` minute (default 60 min); verify job halts if native schedule UI only permits immediate publishing.

### Tests for User Story 2
- [X] T021 [P] [US2] Create scheduler unit tests in `tests/unit/scheduler.test.js` verifying collision detection, minimum spacing (`intervalMinutes >= 1`, default `60`), and auto-shift calculation
- [X] T022 [P] [US2] Create publishing engine integration test in `tests/integration/publishing-engine.test.js` with `tests/fixtures/fake-studio-adapter.js` validating pre-flight checks and evidence-based completion

### Implementation for User Story 2
- [X] T023 [US2] Implement schedule collision resolution and timeline recalculation in `source/tiktok/scheduler.js` enforcing rules: `firstDelayMinutes >= 0`, `intervalMinutes >= 1` (default 60 min), and auto-shift to next valid slot
- [X] T024 [US2] Implement TikTok Studio CDP adapter in `source/tiktok/studio-adapter.js` with DOM selectors for upload, caption/metadata, schedule toggle, date/time pickers, and pre-submit mode verification (halting if schedule mode reverts to immediate)
- [X] T025 [US2] Implement publishing execution engine in `source/tiktok/publishing-engine.js` managing per-account workers, enforcing account lock (maximum 1 mutating job per account), pre-flight validation, and evidence collection
- [X] T026 [US2] Register scheduling and execution IPC handlers in `source/main.js` (`tiktok:jobs:run`, `tiktok:jobs:recalculate-schedule`) and expose in `source/preload.js`
- [X] T027 [US2] Implement schedule configuration UI, immediate/scheduled mode switch, auto-calculated effective time display, and Run button in `source/tiktok-renderer.js`

**Checkpoint**: User Story 2 complete. Publishing and scheduling flows execute safely with collision resolution and strict pre-submit checks.

---

## Phase 5: User Story 3 - Dùng nhạc lấy từ video hoặc file khác (Priority: P1)

**Goal**: Operator selects audio/video file as music source, configures start offset, volumes, loop, and fade; audio mixer aligns audio precisely with video duration using ffprobe/ffmpeg without overwriting original files; cleanup service purges intermediate files after 7 days unless pinned.

**Independent Test**: Process audio for two videos with longer and shorter music tracks; verify audio cuts off exactly at video end with ffprobe (deviation <= 0.05s); verify original volume = 0% and music = 85%; verify retention cleanup deletes unpinned 7-day-old intermediate files while keeping source media.

### Tests for User Story 3
- [X] T028 [P] [US3] Create retention policy unit tests in `tests/unit/retention.test.js` verifying 7-day expiration, pinned asset preservation, and protection of source video assets
- [X] T029 [P] [US3] Create audio pipeline integration tests in `tests/integration/audio-pipeline.test.js` testing duration probing and mixing with test media fixtures

### Implementation for User Story 3
- [X] T030 [US3] Implement media inspection helper in `source/services/media-probe.js` using ffprobe to validate video/audio streams, container integrity, and exact duration in seconds
- [X] T031 [US3] Implement audio mixing service in `source/services/audio-mixer.js` using ffmpeg to trim start offset, blend original volume and music volume (default 85%), apply loop when shorter, apply fade out (default 0.5s), and output intermediate file without touching original video
- [X] T032 [US3] Implement media cleanup service in `source/services/media-cleanup.js` checking 7-day retention rule for processed media, dry-run reporting, and deletion excluding pinned and source assets
- [X] T033 [US3] Register audio IPC handlers in `source/main.js` (`tiktok:audio:choose-source`, `tiktok:audio:preview`, `tiktok:audio:process`, `tiktok:audio:pin`, `tiktok:media:cleanup`) and expose in `source/preload.js`
- [X] T034 [US3] Implement audio settings dialog in `source/tiktok-renderer.js` with file picker, start time input, volume sliders (0-100%), loop checkbox, fade controls, audio preview trigger, and pin toggle

**Checkpoint**: User Story 3 complete. Media audio processing, probing, and 7-day retention management operate independently without corrupting source media.

---

## Phase 6: User Story 4 - AI chuẩn bị nội dung bài đăng (Priority: P2)

**Goal**: Operator generates title, caption, hashtags, and cart display name via Gemini Developer API based on product image and video; supports structured output validation, version restore, and no-cart mode stripping commercial CTA.

**Independent Test**: Generate content across three styles; verify structured format (title <= 150 chars, unique hashtags); test error fallback keeping previous version; test version restore; test `no_cart` mode generates zero shopping mentions.

### Tests for User Story 4
- [X] T035 [P] [US4] Create generated content schema contract test in `tests/contract/generated-content.test.js` validating `contracts/generated-content.schema.json`
- [X] T036 [P] [US4] Create content validator unit tests in `tests/unit/content-validator.test.js` validating title character limits, hashtag deduplication and `#` prefix normalization

### Implementation for User Story 4
- [X] T037 [US4] Implement encrypted local secret storage in `source/services/secret-store.js` for Gemini API key storage and masking (returning only masked suffix `...XXXX`)
- [X] T038 [US4] Implement structured content generator in `source/services/content-generator.js` calling Gemini Developer API with structured schema, error preservation of previous versions, and `no_cart` prompt isolation
- [X] T039 [US4] Register content IPC handlers in `source/main.js` (`tiktok:content:test-key`, `tiktok:content:save-key`, `tiktok:content:generate`, `tiktok:content:restore`) and expose in `source/preload.js`
- [X] T040 [US4] Implement AI Content dialog in `source/tiktok-renderer.js` with tone selector, 2-line truncated preview with expand, manual edit textarea, API key settings, and restore previous version button

**Checkpoint**: User Story 4 complete. AI content generation operates with structured validation, secret protection, and version rollback.

---

## Phase 7: User Story 5 - Gắn đúng sản phẩm Showcase (Priority: P2)

**Goal**: In affiliate/cart mode, operator links product via ID, keyword, or reference image; exact ID matches auto-confirm, while name/image matches produce candidates requiring manual operator confirmation before publishing; no-cart mode bypasses Showcase entirely.

**Independent Test**: Verify exact product ID auto-confirms; verify keyword/image query sets candidate in `waiting_product_confirmation`; verify job with required cart stops before upload if unverified; verify `no_cart` mode skips showcase without error.

### Implementation for User Story 5
- [X] T041 [US5] Implement Showcase search and candidate matching in `source/tiktok/product-matcher.js` enforcing rules: exact product ID match auto-confirms, while name/image query returns candidate requiring manual confirmation
- [X] T042 [US5] Integrate product verification step into worker pipeline in `source/tiktok/publishing-engine.js` halting jobs with `accountMode="affiliate"` if product is not confirmed
- [X] T043 [US5] Register product IPC handlers in `source/main.js` (`tiktok:products:verify`, `tiktok:products:confirm`) and expose in `source/preload.js`
- [X] T044 [US5] Implement product matcher UI in `source/tiktok-renderer.js` showing candidate cards (ID, thumbnail, title), manual confirm button, and `affiliate` vs `no_cart` toggle

**Checkpoint**: User Story 5 complete. Showcase product verification enforces exact ID auto-confirmation and manual approval for ambiguous matches.

---

## Phase 8: User Story 6 - Quản lý nhiều kênh độc lập (Priority: P2)

**Goal**: Operator manages multiple TikTok accounts with isolated Chrome profiles and CDP ports, inspects identity/status, handles expired sessions (pausing account jobs until login + check + manual resume), and runs jobs across distinct accounts concurrently.

**Independent Test**: Add two test accounts with isolated user-data-dirs and distinct CDP ports; run jobs concurrently on both accounts; simulate expired session to verify account and pending jobs transition to `paused` until checked and manually resumed.

### Implementation for User Story 6
- [X] T045 [US6] Implement isolated profile and CDP port allocation in `source/tiktok/account-manager.js` allocating distinct profile directories under `data/profiles/`, managing Chrome launch, CDP port availability, and account status machine (`unknown -> opening -> checking -> live | login_required | verification_required | paused`)
- [X] T046 [US6] Implement account lock and session expiry handler in `source/tiktok/account-manager.js` enforcing maximum 1 mutating job per account, pausing all account jobs on session expiry, and requiring Check + Resume to unpause
- [X] T047 [US6] Register account IPC handlers in `source/main.js` (`tiktok:accounts:list`, `tiktok:accounts:add`, `tiktok:accounts:check`, `tiktok:accounts:show`, `tiktok:accounts:hide`, `tiktok:accounts:pause`, `tiktok:accounts:resume`, `tiktok:accounts:remove`) and expose in `source/preload.js`
- [X] T048 [US6] Implement Accounts management drawer in `source/tiktok-renderer.js` showing account list, status badges, Show/Hide Chrome button, Add Account dialog, and Check All Accounts button

**Checkpoint**: User Story 6 complete. Multiple accounts operate with isolated profiles, separate CDP ports, account-level locks, and secure session lifecycle.

---

## Phase 9: User Story 7 - Theo dõi, tạm dừng và phục hồi job (Priority: P2)

**Goal**: Operator monitors real-time progress based on evidence checkpoints, can Pause (at safe boundary), Resume, Stop (releasing account lock), reconcile ambiguous states (`needs_reconciliation`), and delete jobs with persistent queue state across restarts.

**Independent Test**: Pause job in-flight, verify it stops at safe boundary; restart application while jobs are uploading or submitting, verify automatic transition to `needs_reconciliation` instead of duplicate post; delete failed job and verify it does not reappear on restart.

### Tests for User Story 7
- [X] T049 [P] [US7] Create state recovery integration tests in `tests/integration/state-recovery.test.js` validating startup recovery, conversion of in-flight `submitting` jobs to `needs_reconciliation`, and reconciliation decision execution

### Implementation for User Story 7
- [X] T050 [US7] Implement reconciliation manager in `source/tiktok/reconciliation.js` allowing operator to inspect TikTok Studio in target account and record manual decision (`posted`, `scheduled`, `not_submitted`)
- [X] T051 [US7] Implement queue lifecycle controls in `source/tiktok/controller.js` for Pause (at safe checkpoint), Resume (if account is live), Stop (release lock and save state), Retry (blocked for `needs_reconciliation`), and startup recovery transition
- [X] T052 [US7] Implement safe window close and process shutdown hooks in `source/main.js` releasing account locks and persisting queue state to disk atomically
- [X] T053 [US7] Implement job progress bar, evidence text display, Pause/Resume/Stop/Retry/Reconcile action buttons, and Attention banner in `source/tiktok-renderer.js`

**Checkpoint**: User Story 7 complete. Real-time evidence progress, pause/resume/stop controls, and crash reconciliation are fully operational.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Automated smoke test, packaging verification, quickstart validation, and log hygiene audit.

- [X] T054 [P] Implement automated smoke test in `scripts/smoke-test.ps1` verifying state migration, module exports, and headless launch
- [X] T055 [P] Audit log statements across `source/` ensuring no sensitive data (cookies, API keys, full auth headers) is emitted to log files or renderer
- [X] T056 Execute end-to-end quickstart scenario validation following `specs/001-automate-tiktok-publishing/quickstart.md`
- [X] T057 Verify production packaging and launcher compatibility with `run.bat`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately.
- **Foundational (Phase 2)**: Depends on Phase 1 completion - **BLOCKS all user stories**.
- **User Story 1 (Phase 3)**: Depends on Phase 2 completion. Delivers the MVP.
- **User Story 2 (Phase 4)**: Depends on Phase 2 & Phase 3.
- **User Story 3 (Phase 5)**: Depends on Phase 2 & Phase 3.
- **User Story 4 (Phase 6)**: Depends on Phase 2 & Phase 3.
- **User Story 5 (Phase 7)**: Depends on Phase 2, Phase 3 & Phase 4.
- **User Story 6 (Phase 8)**: Depends on Phase 2 & Phase 4.
- **User Story 7 (Phase 9)**: Depends on Phase 2, Phase 3 & Phase 4.
- **Polish (Phase 10)**: Depends on completion of all desired user story phases.

### User Story Dependencies

- **User Story 1 (P1)**: Foundational models and state store -> Queue addition and UI rendering.
- **User Story 2 (P1)**: Foundational + US1 queue -> Studio adapter, scheduler, and publishing engine.
- **User Story 3 (P1)**: Foundational + US1 queue -> Audio mixer, probe, and retention cleanup.
- **User Story 4 (P2)**: Foundational + US1 queue -> Secret store and Gemini content generator.
- **User Story 5 (P2)**: Foundational + US1 queue + US2 engine -> Showcase product matcher.
- **User Story 6 (P2)**: Foundational + US2 engine -> Account manager and multi-profile isolation.
- **User Story 7 (P2)**: Foundational + US1 queue + US2 engine -> Reconciliation manager and lifecycle controls.

### Parallel Opportunities

- **Phase 1**: T002, T003, T004 can run in parallel.
- **Phase 2**: T005, T006, T007, T008, T010, T011 can run in parallel after directory setup.
- **Phase 3 (US1)**: T012, T013, T018, T019 can run in parallel.
- **Phase 4 (US2)**: T021, T022 can run in parallel.
- **Phase 5 (US3)**: T028, T029 can run in parallel.
- **Phase 6 (US4)**: T035, T036 can run in parallel.
- **Phase 9 (US7)**: T049 can run in parallel with earlier story work.
- **Phase 10**: T054, T055 can run in parallel.
- **Cross-story parallelism**: Once Phase 2 (Foundational) is complete, US1, US3, and US4 can be worked on concurrently by different team members because they touch different service and test files.

---

## Parallel Example: User Story 1

```bash
# Launch contract and unit tests for User Story 1 together:
Task: "Create queue IPC contract tests in tests/contract/ipc.test.js"
Task: "Create unit tests for fingerprint generation and deduplication in tests/unit/queue-dedup.test.js"

# Launch UI structure tasks for User Story 1 together:
Task: "Add TikTok navigation tab, queue table container, and modal layout in source/index.html"
Task: "Add UI styling for TikTok tab, table rows, badges, and modals in source/styles.css"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001 - T004).
2. Complete Phase 2: Foundational (T005 - T011) - **CRITICAL: blocks all stories**.
3. Complete Phase 3: User Story 1 (T012 - T020).
4. **STOP and VALIDATE**: Verify finished Muse videos and disk files queue cleanly, deduplicate on replay, and render in UI.
5. Demo MVP.

### Incremental Delivery

1. Setup + Foundation -> Core store and state machine ready.
2. Deliver US1 -> Working queue from Muse and disk files (MVP).
3. Deliver US2 -> Safe publishing and native scheduling via TikTok Studio.
4. Deliver US3 -> Audio extraction, mixing, looping, and 7-day retention cleanup.
5. Deliver US4 -> Gemini structured content generation with secret protection.
6. Deliver US5 -> Showcase product verification (exact ID auto-confirm, candidate review).
7. Deliver US6 -> Multi-account isolation and session lifecycle management.
8. Deliver US7 -> Crash recovery, evidence-based progress, and reconciliation flow.
9. Polish -> Smoke tests, quickstart validation, and packaging check.
