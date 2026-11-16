"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { StateStore } = require("../../source/core/state-store");
const { TikTokController } = require("../../source/tiktok/controller");
const { ReconciliationManager } = require("../../source/tiktok/reconciliation");

test("State recovery on startup and reconciliation flow (FR-032, FR-033)", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-recovery-"));
  const tempStatePath = path.join(tempDir, "state.json");
  const store = new StateStore(tempStatePath);
  const controller = new TikTokController({ stateStore: store });
  const reconciliation = new ReconciliationManager({ stateStore: store });

  // Simulate an unclean shutdown where jobs were in uploading and submitting states
  store.updateTikTokState(tt => {
    tt.jobs.push(
      {
        id: "j-submitting",
        sourceFingerprint: "fp-sub",
        sourceVideoAssetId: "asset-1",
        status: "submitting",
        progress: 95
      },
      {
        id: "j-uploading",
        sourceFingerprint: "fp-up",
        sourceVideoAssetId: "asset-1",
        status: "uploading",
        progress: 70
      },
      {
        id: "j-draft",
        sourceFingerprint: "fp-draft",
        sourceVideoAssetId: "asset-1",
        status: "draft",
        progress: 0
      }
    );
  });

  await t.test("Startup recovery converts in-flight jobs to needs_reconciliation", () => {
    controller.recoverPendingJobsOnStartup();

    const state = store.getTikTokState();
    const jSub = state.jobs.find(j => j.id === "j-submitting");
    const jUp = state.jobs.find(j => j.id === "j-uploading");
    const jDraft = state.jobs.find(j => j.id === "j-draft");

    // In-flight jobs must require reconciliation instead of blind duplicate posting
    assert.strictEqual(jSub.status, "needs_reconciliation");
    assert.strictEqual(jUp.status, "needs_reconciliation");
    // Safe draft jobs remain draft
    assert.strictEqual(jDraft.status, "draft");
  });

  await t.test("Reconcile with not_submitted resets job to ready for safe rerun", async () => {
    const res = await reconciliation.reconcileJob("j-uploading", "not_submitted");
    assert.strictEqual(res.ok, true);

    const state = store.getTikTokState();
    const jUp = state.jobs.find(j => j.id === "j-uploading");
    assert.strictEqual(jUp.status, "ready");
    assert.strictEqual(jUp.progress, 50);
    assert.ok(jUp.evidence.some(e => e.type === "manual_reconciliation"));
  });

  await t.test("Reconcile with posted marks job 100% posted with evidence", async () => {
    const res = await reconciliation.reconcileJob("j-submitting", "posted");
    assert.strictEqual(res.ok, true);

    const state = store.getTikTokState();
    const jSub = state.jobs.find(j => j.id === "j-submitting");
    assert.strictEqual(jSub.status, "posted");
    assert.strictEqual(jSub.progress, 100);
  });

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
