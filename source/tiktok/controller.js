"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateJob } = require("../models/validators");
const { logger } = require("../core/redacted-log");
const { createError, ERROR_CODES } = require("../core/errors");
const { recalculateTimeline } = require("./scheduler");
const { PublishingEngine } = require("./publishing-engine");
const { JOB_STATUSES, isSafePauseBoundary } = require("../models/state-machine");

function generateFileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const bufferSize = Math.min(65536, stat.size);
    const buffer = Buffer.alloc(bufferSize);
    fs.readSync(fd, buffer, 0, bufferSize, 0);
    fs.closeSync(fd);

    const hash = crypto.createHash("sha256");
    hash.update(path.basename(filePath));
    hash.update(String(stat.size));
    hash.update(buffer);
    return hash.digest("hex");
  } catch (err) {
    return `fp-${path.basename(filePath)}-${Date.now()}`;
  }
}

class TikTokController {
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.accountManager = options.accountManager || null;
    this.publishingEngine = options.publishingEngine || null;
    this.scheduler = options.scheduler || null;
  }

  getSnapshot() {
    if (!this.stateStore) return {};
    return this.stateStore.getTikTokState();
  }

  async addFiles(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return { added: [], skipped: [] };
    }

    const added = [];
    const skipped = [];

    this.stateStore.updateTikTokState(tt => {
      const existingFingerprints = new Set(tt.jobs.map(j => j.sourceFingerprint));

      for (const fp of filePaths) {
        if (!fs.existsSync(fp)) {
          skipped.push({ path: fp, reason: "File not found" });
          continue;
        }

        const fingerprint = generateFileFingerprint(fp);
        if (existingFingerprints.has(fingerprint)) {
          skipped.push({ path: fp, fingerprint, reason: "Duplicate file already in queue" });
          continue;
        }

        const assetId = `asset-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const mediaAsset = {
          id: assetId,
          kind: "source_video",
          path: fp,
          fingerprint,
          durationSeconds: null,
          parentAssetId: null,
          retentionEligibleAt: null,
          pinned: true,
          exists: true
        };
        tt.mediaAssets.push(mediaAsset);

        const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const job = validateJob({
          id: jobId,
          sourceKind: "external_file",
          sourceFingerprint: fingerprint,
          sourceVideoAssetId: assetId,
          uploadVideoAssetId: assetId,
          productImageAssetId: null,
          sourcePrompt: "",
          accountId: tt.accounts.length > 0 ? tt.accounts[0].id : null,
          accountMode: tt.settings.accountMode || "affiliate",
          audio: Object.assign({}, tt.settings.defaultAudio),
          schedule: {
            mode: tt.settings.scheduleMode || "immediate",
            targetTime: tt.settings.scheduleMode === "native_schedule"
              ? new Date(Date.now() + (tt.settings.firstDelayMinutes || 0) * 60000).toISOString()
              : null
          },
          status: "draft",
          progress: 0,
          progressText: "Chờ cấu hình",
          checkpoint: { step: "draft", timestamp: new Date().toISOString() }
        });

        tt.jobs.push(job);
        existingFingerprints.add(fingerprint);
        added.push(job);
        logger.info("tiktok-controller", `Thêm video ngoài vào hàng đợi: ${path.basename(fp)}`, { jobId });
      }
    });

    return { added, skipped };
  }

  async addMuseResults(museJobs) {
    if (!Array.isArray(museJobs) || museJobs.length === 0) {
      return { added: [], skipped: [] };
    }

    const added = [];
    const skipped = [];

    this.stateStore.updateTikTokState(tt => {
      const existingFingerprints = new Set(tt.jobs.map(j => j.sourceFingerprint));

      for (const mj of museJobs) {
        const videoPath = mj.videoPath || mj.resultVideo || mj.outputPath;
        if (!videoPath || !fs.existsSync(videoPath)) {
          skipped.push({ job: mj, reason: "Video file missing" });
          continue;
        }

        const fingerprint = generateFileFingerprint(videoPath);
        if (existingFingerprints.has(fingerprint)) {
          skipped.push({ job: mj, fingerprint, reason: "Duplicate Muse result" });
          continue;
        }

        const videoAssetId = `asset-v-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        tt.mediaAssets.push({
          id: videoAssetId,
          kind: "source_video",
          path: videoPath,
          fingerprint,
          durationSeconds: null,
          parentAssetId: null,
          retentionEligibleAt: null,
          pinned: true,
          exists: true
        });

        let imgAssetId = null;
        if (mj.productImagePath && fs.existsSync(mj.productImagePath)) {
          imgAssetId = `asset-img-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
          tt.mediaAssets.push({
            id: imgAssetId,
            kind: "product_image",
            path: mj.productImagePath,
            fingerprint: generateFileFingerprint(mj.productImagePath),
            durationSeconds: null,
            parentAssetId: null,
            retentionEligibleAt: null,
            pinned: true,
            exists: true
          });
        }

        const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const job = validateJob({
          id: jobId,
          sourceKind: "muse_result",
          sourceFingerprint: fingerprint,
          sourceVideoAssetId: videoAssetId,
          uploadVideoAssetId: videoAssetId,
          productImageAssetId: imgAssetId,
          sourcePrompt: mj.prompt || "",
          accountId: tt.accounts.length > 0 ? tt.accounts[0].id : null,
          accountMode: tt.settings.accountMode || "affiliate",
          audio: Object.assign({}, tt.settings.defaultAudio),
          status: "draft",
          progress: 0,
          progressText: "Chờ chuẩn bị bài đăng",
          checkpoint: { step: "draft", timestamp: new Date().toISOString() }
        });

        tt.jobs.push(job);
        existingFingerprints.add(fingerprint);
        added.push(job);
        logger.info("tiktok-controller", `Nhận video từ Muse: ${path.basename(videoPath)}`, { jobId });
      }
    });

    return { added, skipped };
  }

  async updateJob(jobId, patch, expectedUpdatedAt) {
    let updatedJob = null;
    let conflict = false;

    this.stateStore.updateTikTokState(tt => {
      const idx = tt.jobs.findIndex(j => j.id === jobId);
      if (idx === -1) {
        throw new Error(`Không tìm thấy job ${jobId}`);
      }

      const job = tt.jobs[idx];
      if (expectedUpdatedAt && job.updatedAt !== expectedUpdatedAt) {
        conflict = true;
        return;
      }

      // Allow only editable fields
      if (patch.accountId !== undefined) job.accountId = patch.accountId;
      if (patch.accountMode !== undefined) job.accountMode = patch.accountMode;
      if (patch.content) {
        job.content = Object.assign({}, job.content, patch.content);
      }
      if (patch.audio) {
        job.audio = Object.assign({}, job.audio, patch.audio);
      }
      if (patch.schedule) {
        job.schedule = Object.assign({}, job.schedule, patch.schedule);
      }
      if (patch.productMatch !== undefined) job.productMatch = patch.productMatch;

      job.updatedAt = new Date().toISOString();
      tt.jobs[idx] = validateJob(job);
      updatedJob = tt.jobs[idx];
    });

    if (conflict) {
      return { ok: false, error: createError(ERROR_CODES.STALE_EDIT_CONFLICT) };
    }

    return { ok: true, data: updatedJob };
  }

  async removeJobs(jobIds, options = {}) {
    const deleteProcessed = Boolean(options.deleteProcessed);
    const removedIds = [];

    this.stateStore.updateTikTokState(tt => {
      const toRemove = new Set(jobIds);
      const remainingJobs = [];

      for (const job of tt.jobs) {
        if (toRemove.has(job.id)) {
          removedIds.push(job.id);
          // Delete intermediate processed media if requested and not pinned
          if (deleteProcessed && job.uploadVideoAssetId && job.uploadVideoAssetId !== job.sourceVideoAssetId) {
            const assetIdx = tt.mediaAssets.findIndex(a => a.id === job.uploadVideoAssetId);
            if (assetIdx !== -1) {
              const asset = tt.mediaAssets[assetIdx];
              if (!asset.pinned && fs.existsSync(asset.path)) {
                try { fs.unlinkSync(asset.path); } catch (_) {}
              }
              tt.mediaAssets.splice(assetIdx, 1);
            }
          }
        } else {
          remainingJobs.push(job);
        }
      }

      tt.jobs = remainingJobs;
    });

    return { removed: removedIds };
  }

  async recalculateSchedule(jobIds) {
    let affectedJobs = [];
    this.stateStore.updateTikTokState(tt => {
      const targetJobs = jobIds && jobIds.length > 0
        ? tt.jobs.filter(j => jobIds.includes(j.id))
        : tt.jobs;

      const recalculated = recalculateTimeline(targetJobs, {
        firstDelayMinutes: tt.settings.firstDelayMinutes,
        intervalMinutes: tt.settings.intervalMinutes
      });

      for (const rec of recalculated) {
        const idx = tt.jobs.findIndex(j => j.id === rec.id);
        if (idx !== -1) {
          tt.jobs[idx].schedule = rec.schedule;
          tt.jobs[idx].updatedAt = new Date().toISOString();
          affectedJobs.push(tt.jobs[idx]);
        }
      }
    });

    return { ok: true, jobs: affectedJobs };
  }

  async runJobs(jobIds, adapterFactory = null) {
    const ttState = this.stateStore.getTikTokState();
    const toRun = jobIds && jobIds.length > 0
      ? ttState.jobs.filter(j => jobIds.includes(j.id))
      : ttState.jobs.filter(j => ["ready", "waiting_content", "draft", "paused"].includes(j.status));

    if (toRun.length === 0) {
      return { ok: false, message: "Không có job nào ở trạng thái sẵn sàng để chạy." };
    }

    if (!this.publishingEngine) {
      this.publishingEngine = new PublishingEngine({
        stateStore: this.stateStore,
        accountManager: this.accountManager,
        adapterFactory
      });
    }

    const results = [];
    for (const job of toRun) {
      try {
        const res = await this.publishingEngine.runJob(job.id);
        results.push({ jobId: job.id, ok: true, status: res.status });
      } catch (err) {
        results.push({ jobId: job.id, ok: false, error: err.message });
      }
    }

    return { ok: true, results };
  }

  recoverPendingJobsOnStartup() {
    this.stateStore.updateTikTokState(tt => {
      // Clear active account locks on restart
      if (tt.control) {
        tt.control.activeAccountLocks = {};
      }

      for (const job of tt.jobs) {
        if (["uploading", "filling_metadata", "configuring_schedule", "submitting"].includes(job.status)) {
          job.status = JOB_STATUSES.NEEDS_RECONCILIATION;
          job.progressText = "Cần đối soát: Tool khởi động lại khi job đang gửi hoặc chưa có xác nhận";
          job.error = createError(ERROR_CODES.RECONCILIATION_NEEDED, "Cần đối soát trạng thái bài đăng sau khi mở lại ứng dụng");
          job.updatedAt = new Date().toISOString();
        } else if (job.status === "opening_studio") {
          job.status = JOB_STATUSES.READY;
          job.progressText = "Khôi phục về trạng thái sẵn sàng sau khi mở lại ứng dụng";
          job.updatedAt = new Date().toISOString();
        }
      }
    });
  }

  pauseJobs(jobIds) {
    const updated = [];
    this.stateStore.updateTikTokState(tt => {
      const targetJobs = jobIds && jobIds.length > 0
        ? tt.jobs.filter(j => jobIds.includes(j.id))
        : tt.jobs;

      for (const job of targetJobs) {
        if (job.status !== JOB_STATUSES.POSTED && job.status !== JOB_STATUSES.SCHEDULED) {
          if (isSafePauseBoundary(job.status)) {
            job.status = JOB_STATUSES.PAUSED;
            job.progressText = "Đã tạm dừng theo yêu cầu người dùng";
            job.updatedAt = new Date().toISOString();
            updated.push(job.id);
          }
        }
      }
    });
    return { ok: true, pausedJobIds: updated };
  }

  resumeJobs(jobIds) {
    const resumed = [];
    this.stateStore.updateTikTokState(tt => {
      const targetJobs = jobIds && jobIds.length > 0
        ? tt.jobs.filter(j => jobIds.includes(j.id))
        : tt.jobs.filter(j => j.status === JOB_STATUSES.PAUSED);

      for (const job of targetJobs) {
        if (job.status === JOB_STATUSES.PAUSED) {
          job.status = JOB_STATUSES.READY;
          job.progressText = "Sẵn sàng tiếp tục chạy";
          job.updatedAt = new Date().toISOString();
          resumed.push(job.id);
        }
      }
    });
    return { ok: true, resumedJobIds: resumed };
  }

  stopJobs(jobIds) {
    if (this.publishingEngine) {
      this.publishingEngine.activeAccountLocks.clear();
    }
    return this.pauseJobs(jobIds);
  }

  retryJobs(jobIds) {
    const retried = [];
    this.stateStore.updateTikTokState(tt => {
      const targetJobs = jobIds && jobIds.length > 0
        ? tt.jobs.filter(j => jobIds.includes(j.id))
        : tt.jobs.filter(j => j.status === JOB_STATUSES.FAILED);

      for (const job of targetJobs) {
        // Safety rule FR-032: Block direct retry for needs_reconciliation without manual check
        if (job.status === JOB_STATUSES.NEEDS_RECONCILIATION) {
          continue;
        }
        if (job.status === JOB_STATUSES.FAILED || job.status === JOB_STATUSES.PAUSED) {
          job.status = JOB_STATUSES.READY;
          job.error = null;
          job.progressText = "Chờ chạy lại";
          job.updatedAt = new Date().toISOString();
          retried.push(job.id);
        }
      }
    });
    return { ok: true, retriedJobIds: retried };
  }
}

module.exports = {
  generateFileFingerprint,
  TikTokController
};
