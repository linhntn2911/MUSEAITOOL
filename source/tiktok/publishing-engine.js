"use strict";

const fs = require("node:fs");
const { JOB_STATUSES, calculateProgress } = require("../models/state-machine");
const { logger } = require("../core/redacted-log");
const { createError, ERROR_CODES } = require("../core/errors");
const { StudioAdapter } = require("./studio-adapter");

class PublishingEngine {
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.adapterFactory = options.adapterFactory || null;
    this.accountManager = options.accountManager || null;
    this.activeAccountLocks = new Set();
    this.runningWorkers = new Map();
  }

  isAccountLocked(accountId) {
    return this.activeAccountLocks.has(accountId);
  }

  acquireAccountLock(accountId) {
    if (this.activeAccountLocks.has(accountId)) {
      return false;
    }
    this.activeAccountLocks.add(accountId);
    return true;
  }

  releaseAccountLock(accountId) {
    this.activeAccountLocks.delete(accountId);
  }

  async runJob(jobId, injectedAdapter = null) {
    const ttState = this.stateStore.getTikTokState();
    const job = ttState.jobs.find(j => j.id === jobId);

    if (!job) {
      throw createError(ERROR_CODES.UNKNOWN_ERROR, `Không tìm thấy job ${jobId}`);
    }

    if (!job.accountId) {
      throw createError(ERROR_CODES.ACCOUNT_NOT_FOUND, "Job chưa được gán tài khoản TikTok");
    }

    const account = ttState.accounts.find(a => a.id === job.accountId);
    if (!account) {
      throw createError(ERROR_CODES.ACCOUNT_NOT_FOUND, "Tài khoản TikTok không tồn tại");
    }

    if (account.paused) {
      throw createError(ERROR_CODES.ACCOUNT_PAUSED, "Tài khoản đang bị tạm dừng");
    }

    // Safety lock (FR-008): 1 mutating job per account
    if (!this.acquireAccountLock(account.id)) {
      throw createError(ERROR_CODES.ACCOUNT_BUSY, "Kênh đang bận xử lý một video khác");
    }

    const adapter = injectedAdapter || (this.adapterFactory ? this.adapterFactory(account) : new StudioAdapter({ cdpPort: account.cdpPort }));
    if (!adapter) {
      this.releaseAccountLock(account.id);
      throw createError(ERROR_CODES.UNKNOWN_ERROR, "Không thể khởi tạo adapter kết nối TikTok");
    }

    const updateJobStatus = (status, text, extra = {}) => {
      this.stateStore.updateTikTokState(s => {
        const j = s.jobs.find(item => item.id === jobId);
        if (j) {
          j.evidence = Array.isArray(j.evidence) ? j.evidence : [];
          if (extra.evidence) j.evidence.push(extra.evidence);
          j.status = status;
          j.progressText = text;
          j.progress = calculateProgress(status, j.evidence);
          j.checkpoint = { step: status, timestamp: new Date().toISOString() };
          if (extra.error) j.error = extra.error;
          j.updatedAt = new Date().toISOString();
        }
      });
      logger.info("publishing-engine", `Job ${jobId} -> ${status}: ${text}`, { jobId, accountId: account.id, step: status });
    };

    try {
      // Pre-flight check video asset
      const videoAsset = ttState.mediaAssets.find(a => a.id === (job.uploadVideoAssetId || job.sourceVideoAssetId));
      let videoPath = videoAsset?.path;
      if (!videoPath && job.videoPath) videoPath = job.videoPath;
      if (!videoPath && job.filePath) videoPath = job.filePath;

      if (!videoPath || !fs.existsSync(videoPath)) {
        throw createError(ERROR_CODES.VIDEO_NOT_FOUND, "File video cần upload không tồn tại");
      }

      // Pre-flight check affiliate cart mode (FR-018)
      if (job.accountMode === "affiliate") {
        if (!job.productMatch || !job.productMatch.confirmed) {
          throw createError(ERROR_CODES.PRODUCT_UNVERIFIED, "Job ở chế độ giỏ hàng nhưng chưa xác minh sản phẩm");
        }
      }

      // Ensure Chrome is running for this account
      if (this.accountManager && typeof this.accountManager.ensureChrome === "function") {
        await this.accountManager.ensureChrome(account, true, "https://www.tiktok.com/tiktokstudio/upload?lang=vi-VN");
      }

      updateJobStatus(JOB_STATUSES.OPENING_STUDIO, "Đang mở TikTok Studio");
      await adapter.connect(account.cdpPort);

      // Check account session
      const accCheck = await adapter.checkAccount();
      if (accCheck.status !== "live") {
        if (accCheck.status === "verification_required") {
          throw createError(ERROR_CODES.CAPTCHA_DETECTED, "Phát hiện CAPTCHA / OTP, cần người dùng xử lý", { requiresUser: true });
        }
        throw createError(ERROR_CODES.SESSION_EXPIRED, "Phiên TikTok hết hạn, cần đăng nhập lại", { requiresUser: true });
      }

      updateJobStatus(JOB_STATUSES.UPLOADING, "Đang tải video lên TikTok");
      await adapter.uploadVideo(videoPath);

      // Optional Audio & Music edit
      if (job.options?.muteOriginalSound || job.options?.addRecommendedMusic) {
        if (typeof adapter.editAudioAndMusic === "function") {
          updateJobStatus(JOB_STATUSES.PROCESSING_AUDIO, "Đang tắt tiếng gốc & chèn nhạc đề xuất");
          await adapter.editAudioAndMusic({
            muteOriginalSound: Boolean(job.options?.muteOriginalSound),
            addRecommendedMusic: Boolean(job.options?.addRecommendedMusic)
          }).catch(err => logger.warn("publishing-engine", `Lỗi chỉnh nhạc/âm thanh: ${err.message}`));
        }
      }

      updateJobStatus(JOB_STATUSES.FILLING_METADATA, "Đang điền tiêu đề và hashtag");
      await adapter.fillMetadata({
        title: job.content?.title || "",
        caption: job.content?.caption || "",
        hashtags: job.content?.hashtags || []
      });

      // Optional Showcase Product Cart attachment
      if (job.accountMode === "affiliate" || (job.productMatch && job.productMatch.confirmed)) {
        if (typeof adapter.attachProductCart === "function") {
          updateJobStatus(JOB_STATUSES.ATTACHING_PRODUCT || JOB_STATUSES.FILLING_METADATA, "Đang gắn giỏ hàng sản phẩm Showcase");
          await adapter.attachProductCart(
            {
              productId: job.productMatch?.productId || job.productId || "",
              keyword: job.productMatch?.productName || job.productKeyword || ""
            },
            job.productMatch?.displayName || job.productDisplayName || ""
          ).catch(err => logger.warn("publishing-engine", `Lỗi gắn sản phẩm giỏ hàng: ${err.message}`));
        }
      }

      const mode = job.schedule?.mode || "immediate";
      updateJobStatus(JOB_STATUSES.CONFIGURING_SCHEDULE, `Đang cấu hình chế độ: ${mode}`);
      const schedRes = await adapter.configureSchedule({
        mode,
        scheduledTime: job.schedule?.effectiveTime || job.schedule?.targetTime
      });

      if (!schedRes.ok && schedRes.error === "SCHEDULE_NOT_PERMITTED_ON_UI") {
        throw createError(ERROR_CODES.SCHEDULE_NOT_PERMITTED_ON_UI, schedRes.message);
      }

      updateJobStatus(JOB_STATUSES.SUBMITTING, "Đang bấm gửi bài và chờ bằng chứng xác nhận");
      const submitRes = await adapter.submitPost({ mode });

      if (submitRes.ok && submitRes.evidence) {
        const terminalStatus = mode === "native_schedule" ? JOB_STATUSES.SCHEDULED : JOB_STATUSES.POSTED;
        const terminalText = mode === "native_schedule" ? "Đã lên lịch thành công trên TikTok" : "Đã đăng video thành công lên TikTok";
        updateJobStatus(terminalStatus, terminalText, { evidence: submitRes.evidence });
        return { ok: true, status: terminalStatus, evidence: submitRes.evidence };
      } else {
        // Fallback or lost confirmation (FR-032, FR-033)
        updateJobStatus(JOB_STATUSES.NEEDS_RECONCILIATION, "Chưa nhận được xác nhận cuối, chuyển sang Cần đối soát", {
          error: createError(ERROR_CODES.RECONCILIATION_NEEDED, "Mất xác nhận kết quả sau khi gửi bài")
        });
        return { ok: false, status: JOB_STATUSES.NEEDS_RECONCILIATION };
      }
    } catch (err) {
      const errorRecord = err.code ? err : createError(ERROR_CODES.UNKNOWN_ERROR, err.message);
      updateJobStatus(JOB_STATUSES.FAILED, `Lỗi: ${errorRecord.message}`, { error: errorRecord });
      throw errorRecord;
    } finally {
      this.releaseAccountLock(account.id);
      try { await adapter.close(); } catch (_) {}
    }
  }
}

module.exports = {
  PublishingEngine
};
