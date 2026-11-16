"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { StateStore } = require("../../source/core/state-store");
const { TikTokController, generateFileFingerprint } = require("../../source/tiktok/controller");

test("TikTokController queue deduplication and management", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-controller-"));
  const tempStatePath = path.join(tempDir, "state.json");
  const store = new StateStore(tempStatePath);
  const controller = new TikTokController({ stateStore: store });

  // Create a dummy video file
  const dummyVideo = path.join(tempDir, "test-video.mp4");
  fs.writeFileSync(dummyVideo, "fake video bytes content", "utf8");

  await t.test("Generates consistent fingerprint for same file", () => {
    const fp1 = generateFileFingerprint(dummyVideo);
    const fp2 = generateFileFingerprint(dummyVideo);
    assert.ok(fp1);
    assert.strictEqual(fp1, fp2);
  });

  await t.test("Adds external file to queue and creates job", async () => {
    const result = await controller.addFiles([dummyVideo]);
    assert.strictEqual(result.added.length, 1);
    assert.strictEqual(result.skipped.length, 0);

    const state = store.getTikTokState();
    assert.strictEqual(state.jobs.length, 1);
    assert.strictEqual(state.jobs[0].sourceFingerprint, result.added[0].sourceFingerprint);
    assert.strictEqual(state.jobs[0].status, "draft");
  });

  await t.test("Prevents duplicate addition of the same video file", async () => {
    const result = await controller.addFiles([dummyVideo]);
    assert.strictEqual(result.added.length, 0);
    assert.strictEqual(result.skipped.length, 1);

    const state = store.getTikTokState();
    assert.strictEqual(state.jobs.length, 1);
  });

  await t.test("Adds Muse completed results and deduplicates replayed events", async () => {
    const museJob = {
      id: "muse-job-99",
      videoPath: dummyVideo,
      productImagePath: "dummy-product.jpg",
      prompt: "Bo cuc review nuoc hoa sang trong"
    };

    // First time
    const res1 = await controller.addMuseResults([museJob]);
    // Note: since dummyVideo has same file fingerprint as previous test, verify deduplication
    assert.strictEqual(res1.skipped.length, 1);

    // With a different video path
    const dummyVideo2 = path.join(tempDir, "test-video-2.mp4");
    fs.writeFileSync(dummyVideo2, "another video content", "utf8");
    museJob.videoPath = dummyVideo2;

    const res2 = await controller.addMuseResults([museJob]);
    assert.strictEqual(res2.added.length, 1);
    assert.strictEqual(res2.added[0].sourcePrompt, museJob.prompt);

    // Replay same event
    const resReplay = await controller.addMuseResults([museJob]);
    assert.strictEqual(resReplay.added.length, 0);
    assert.strictEqual(resReplay.skipped.length, 1);
  });

  await t.test("Removes job without deleting source media file", async () => {
    const state = store.getTikTokState();
    const jobIdToRemove = state.jobs[0].id;

    await controller.removeJobs([jobIdToRemove], { deleteProcessed: false });
    const updatedState = store.getTikTokState();
    assert.ok(!updatedState.jobs.some(j => j.id === jobIdToRemove));

    // Source video file must still exist
    assert.ok(fs.existsSync(dummyVideo));
  });

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
