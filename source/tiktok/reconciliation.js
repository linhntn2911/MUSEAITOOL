"use strict";

const { JOB_STATUSES, calculateProgress } = require("../models/state-machine");
const { logger } = require("../core/redacted-log");
const { createError, ERROR_CODES } = require("../core/errors");

const VALID_DECISIONS = ["posted", "scheduled", "not_submitted"];

class ReconciliationManager {
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.accountManager = options.accountManager || null;
  }

  async reconcileJob(jobId, decision, extra = {}) {
    if (!VALID_DECISIONS.includes(decision)) {
      throw createError(ERROR_CODES.UNKNOWN_ERROR, `Quyết định đối soát không hợp lệ: ${decision}`);
    }

    let updatedJob = null;
    this.stateStore.updateTikTokState(tt => {
      const j = tt.jobs.find(item => item.id === jobId);
      if (!j) {
        throw createError(ERROR_CODES.UNKNOWN_ERROR, `Không tìm thấy job ${jobId}`);
      }

      if (j.status !== JOB_STATUSES.NEEDS_RECONCILIATION && j.status !== JOB_STATUSES.FAILED) {
        throw createError(ERROR_CODES.MUTATION_NOT_ALLOWED, `Job ở trạng thái ${j.status}, không cần đối soát.`);
      }

      const reconciliationEvidence = {
        type: "manual_reconciliation",
        decision,
        note: extra.note || "Người vận hành xác nhận đối soát thủ công",
        timestamp: new Date().toISOString()
      };

      if (!Array.isArray(j.evidence)) j.evidence = [];
      j.evidence.push(reconciliationEvidence);

      if (decision === "posted") {
        j.status = JOB_STATUSES.POSTED;
        j.progressText = "Đã đối soát: Người dùng xác nhận đã đăng thành công";
        j.progress = 100;
        j.error = null;
      } else if (decision === "scheduled") {
        j.status = JOB_STATUSES.SCHEDULED;
        j.progressText = "Đã đối soát: Người dùng xác nhận đã lên lịch thành công";
        j.progress = 100;
        j.error = null;
      } else if (decision === "not_submitted") {
        j.status = JOB_STATUSES.READY;
        j.progressText = "Đã đối soát: Chưa đăng, đã chuyển về hàng đợi sẵn sàng";
        j.progress = 50;
        j.error = null;
      }

      j.updatedAt = new Date().toISOString();
      updatedJob = j;
    });

    logger.info("reconciliation", `Đối soát job ${jobId} -> ${decision}`, { jobId, decision });
    return { ok: true, job: updatedJob };
  }
}

module.exports = {
  VALID_DECISIONS,
  ReconciliationManager
};
