"use strict";

const fs = require("node:fs");
const { logger } = require("../core/redacted-log");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isEligibleForCleanup(asset, referenceDate = new Date()) {
  if (!asset || typeof asset !== "object") return false;
  // Never delete source video, product images, or pinned files
  if (asset.kind === "source_video" || asset.kind === "product_image") return false;
  if (asset.pinned === true) return false;

  const dateStr = asset.retentionEligibleAt || asset.createdAt;
  if (!dateStr) return false;

  const assetTime = new Date(dateStr).getTime();
  const refTime = new Date(referenceDate).getTime();
  return (refTime - assetTime) >= SEVEN_DAYS_MS;
}

async function cleanupExpiredMedia(mediaAssets, options = {}) {
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : false;
  const now = options.now ? new Date(options.now) : new Date();

  const eligible = [];
  const deleted = [];
  const failed = [];

  for (const asset of mediaAssets || []) {
    if (isEligibleForCleanup(asset, now)) {
      eligible.push(asset);
      if (!dryRun) {
        try {
          if (fs.existsSync(asset.path)) {
            fs.unlinkSync(asset.path);
          }
          asset.exists = false;
          deleted.push(asset);
          logger.info("media-cleanup", `Đã xóa file trung gian hết hạn: ${asset.path}`, { assetId: asset.id });
        } catch (err) {
          failed.push({ asset, error: err.message });
          logger.warn("media-cleanup", `Không thể xóa file ${asset.path}: ${err.message}`, { assetId: asset.id });
        }
      }
    }
  }

  return { dryRun, eligible, deleted, failed };
}

module.exports = {
  SEVEN_DAYS_MS,
  isEligibleForCleanup,
  cleanupExpiredMedia
};
