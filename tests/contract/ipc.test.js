"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { StateStore } = require("../../source/core/state-store");
const { TikTokController } = require("../../source/tiktok/controller");

test("IPC Contract conformance for queue actions", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-ipc-"));
  const tempStatePath = path.join(tempDir, "state.json");
  const store = new StateStore(tempStatePath);
  const controller = new TikTokController({ stateStore: store });

  const dummyVideo = path.join(tempDir, "ipc-video.mp4");
  fs.writeFileSync(dummyVideo, "ipc video bytes", "utf8");

  await t.test("tiktok:jobs:add-files returns standard result envelope", async () => {
    const result = await controller.addFiles([dummyVideo]);
    assert.ok(Array.isArray(result.added));
    assert.ok(Array.isArray(result.skipped));
    assert.strictEqual(result.added.length, 1);

    // Verify properties match IPC contract
    const addedJob = result.added[0];
    assert.ok(addedJob.id);
    assert.ok(addedJob.sourceFingerprint);
    assert.strictEqual(addedJob.status, "draft");
  });

  await t.test("tiktok:jobs:update returns ok envelope or structured error", async () => {
    const state = store.getTikTokState();
    const jobId = state.jobs[0].id;
    const currentUpdatedAt = state.jobs[0].updatedAt;

    // Successful patch
    const patchRes = await controller.updateJob(jobId, { accountMode: "no_cart" }, currentUpdatedAt);
    assert.strictEqual(patchRes.ok, true);
    assert.strictEqual(patchRes.data.accountMode, "no_cart");

    // Stale edit conflict
    const staleRes = await controller.updateJob(jobId, { accountMode: "affiliate" }, "old-stale-timestamp");
    assert.strictEqual(staleRes.ok, false);
    assert.strictEqual(staleRes.error.code, "STALE_EDIT_CONFLICT");
    assert.ok(staleRes.error.message);
  });

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
