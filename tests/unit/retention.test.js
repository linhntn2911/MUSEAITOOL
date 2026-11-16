"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { cleanupExpiredMedia, isEligibleForCleanup } = require("../../source/services/media-cleanup");

test("7-day media retention and cleanup policy", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-retention-"));
  const now = new Date("2026-11-16T12:00:00.000Z");
  const eightDaysAgo = new Date("2026-11-08T12:00:00.000Z").toISOString();
  const threeDaysAgo = new Date("2026-11-13T12:00:00.000Z").toISOString();

  // Create real files to test deletion
  const sourceFile = path.join(tempDir, "source-keep.mp4");
  const processedOldFile = path.join(tempDir, "processed-old.mp4");
  const processedNewFile = path.join(tempDir, "processed-new.mp4");
  const pinnedOldFile = path.join(tempDir, "processed-pinned-old.mp4");

  fs.writeFileSync(sourceFile, "source video", "utf8");
  fs.writeFileSync(processedOldFile, "old intermediate", "utf8");
  fs.writeFileSync(processedNewFile, "new intermediate", "utf8");
  fs.writeFileSync(pinnedOldFile, "pinned intermediate", "utf8");

  const assets = [
    {
      id: "a-source",
      kind: "source_video",
      path: sourceFile,
      createdAt: eightDaysAgo,
      pinned: false
    },
    {
      id: "a-processed-old",
      kind: "processed_video",
      path: processedOldFile,
      createdAt: eightDaysAgo,
      pinned: false
    },
    {
      id: "a-processed-new",
      kind: "processed_video",
      path: processedNewFile,
      createdAt: threeDaysAgo,
      pinned: false
    },
    {
      id: "a-processed-pinned",
      kind: "processed_video",
      path: pinnedOldFile,
      createdAt: eightDaysAgo,
      pinned: true
    }
  ];

  await t.test("Identifies eligibility correctly based on kind, age, and pin", () => {
    assert.strictEqual(isEligibleForCleanup(assets[0], now), false); // source_video is protected
    assert.strictEqual(isEligibleForCleanup(assets[1], now), true);  // 8 days old processed
    assert.strictEqual(isEligibleForCleanup(assets[2], now), false); // 3 days old processed (< 7 days)
    assert.strictEqual(isEligibleForCleanup(assets[3], now), false); // pinned
  });

  await t.test("Dry run identifies eligible files without deleting them", async () => {
    const res = await cleanupExpiredMedia(assets, { dryRun: true, now });
    assert.strictEqual(res.eligible.length, 1);
    assert.strictEqual(res.eligible[0].id, "a-processed-old");
    assert.strictEqual(res.deleted.length, 0);
    assert.ok(fs.existsSync(processedOldFile));
  });

  await t.test("Live cleanup deletes only unpinned expired processed media", async () => {
    const res = await cleanupExpiredMedia(assets, { dryRun: false, now });
    assert.strictEqual(res.deleted.length, 1);
    assert.strictEqual(res.deleted[0].id, "a-processed-old");

    assert.ok(!fs.existsSync(processedOldFile)); // deleted
    assert.ok(fs.existsSync(sourceFile));       // source kept
    assert.ok(fs.existsSync(processedNewFile));  // recent kept
    assert.ok(fs.existsSync(pinnedOldFile));    // pinned kept
  });

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
