"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { StateStore } = require("../../source/core/state-store");
const { PublishingEngine } = require("../../source/tiktok/publishing-engine");
const FakeStudioAdapter = require("../fixtures/fake-studio-adapter");

test("PublishingEngine execution with FakeStudioAdapter", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-engine-"));
  const tempStatePath = path.join(tempDir, "state.json");
  const store = new StateStore(tempStatePath);

  const videoFile = path.join(tempDir, "test-publish.mp4");
  fs.writeFileSync(videoFile, "sample video data", "utf8");

  store.updateTikTokState(tt => {
    tt.accounts.push({
      id: "acc-test-1",
      label: "Kênh Test",
      profilePath: "dummy-path",
      cdpPort: 19888,
      status: "live",
      paused: false
    });
    tt.mediaAssets.push({
      id: "asset-pub-1",
      kind: "source_video",
      path: videoFile,
      fingerprint: "fp-pub-1",
      pinned: true,
      exists: true
    });
    tt.jobs.push({
      id: "job-pub-1",
      sourceKind: "external_file",
      sourceFingerprint: "fp-pub-1",
      sourceVideoAssetId: "asset-pub-1",
      uploadVideoAssetId: "asset-pub-1",
      accountId: "acc-test-1",
      accountMode: "no_cart",
      status: "ready",
      progress: 50,
      schedule: { mode: "immediate", targetTime: null },
      content: { title: "Video review test", caption: "Caption test", hashtags: ["#test"] }
    });
  });

  const engine = new PublishingEngine({ stateStore: store });

  await t.test("Successfully publishes immediate post and reaches 100% progress", async () => {
    const adapter = new FakeStudioAdapter({
      loginState: "live",
      postEvidenceId: "ev-posted-999"
    });

    const res = await engine.runJob("job-pub-1", adapter);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, "posted");

    const state = store.getTikTokState();
    const job = state.jobs.find(j => j.id === "job-pub-1");
    assert.strictEqual(job.status, "posted");
    assert.strictEqual(job.progress, 100);
    assert.ok(job.evidence.some(e => e.evidenceId === "ev-posted-999"));
  });

  await t.test("Successfully schedules post in native_schedule mode", async () => {
    store.updateTikTokState(tt => {
      const j = tt.jobs.find(item => item.id === "job-pub-1");
      j.status = "ready";
      j.schedule.mode = "native_schedule";
      j.schedule.effectiveTime = "2026-11-16T18:00:00.000Z";
    });

    const adapter = new FakeStudioAdapter({
      loginState: "live",
      scheduleEvidenceId: "ev-sched-888"
    });

    const res = await engine.runJob("job-pub-1", adapter);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, "scheduled");

    const state = store.getTikTokState();
    const job = state.jobs.find(j => j.id === "job-pub-1");
    assert.strictEqual(job.status, "scheduled");
    assert.strictEqual(job.progress, 100);
  });

  await t.test("Stops safely when UI reverts native schedule to immediate post (FR-013)", async () => {
    store.updateTikTokState(tt => {
      const j = tt.jobs.find(item => item.id === "job-pub-1");
      j.status = "ready";
      j.schedule.mode = "native_schedule";
    });

    const adapter = new FakeStudioAdapter({
      loginState: "live",
      simulateImmediateOnly: true
    });

    await assert.rejects(
      async () => engine.runJob("job-pub-1", adapter),
      (err) => {
        assert.strictEqual(err.code, "SCHEDULE_NOT_PERMITTED_ON_UI");
        return true;
      }
    );

    const state = store.getTikTokState();
    const job = state.jobs.find(j => j.id === "job-pub-1");
    assert.strictEqual(job.status, "failed");
  });

  await t.test("Enforces account lock against concurrent mutating actions (FR-008)", async () => {
    engine.acquireAccountLock("acc-test-1");
    const adapter = new FakeStudioAdapter();

    await assert.rejects(
      async () => engine.runJob("job-pub-1", adapter),
      (err) => {
        assert.strictEqual(err.code, "ACCOUNT_BUSY");
        return true;
      }
    );

    engine.releaseAccountLock("acc-test-1");
  });

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
