"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { StateStore } = require("../../source/core/state-store");
const { AccountManager } = require("../../source/tiktok/account-manager");
const FakeStudioAdapter = require("../fixtures/fake-studio-adapter");

test("AccountManager multi-account isolation and session lifecycle (FR-006, FR-007)", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-acc-"));
  const tempStatePath = path.join(tempDir, "state.json");
  const store = new StateStore(tempStatePath);
  const manager = new AccountManager({ stateStore: store, dataDir: tempDir });

  await t.test("Adds account with isolated profile directory and distinct CDP port", async () => {
    const acc1 = await manager.addAccount("Kênh 1");
    const acc2 = await manager.addAccount("Kênh 2");

    assert.ok(fs.existsSync(acc1.profilePath));
    assert.ok(fs.existsSync(acc2.profilePath));
    assert.notStrictEqual(acc1.profilePath, acc2.profilePath);
    assert.notStrictEqual(acc1.cdpPort, acc2.cdpPort);
  });

  await t.test("Expired session marks account and unfinished jobs as paused", async () => {
    const state = store.getTikTokState();
    const acc = state.accounts[0];

    store.updateTikTokState(tt => {
      tt.jobs.push({
        id: "job-acc-1",
        accountId: acc.id,
        sourceFingerprint: "fp-acc-1",
        sourceVideoAssetId: "asset-1",
        status: "ready"
      });
    });

    const fakeAdapter = new FakeStudioAdapter({ loginState: "login_required" });
    await manager.checkAccount(acc.id, fakeAdapter);

    const updated = store.getTikTokState();
    const updatedAcc = updated.accounts.find(a => a.id === acc.id);
    const updatedJob = updated.jobs.find(j => j.id === "job-acc-1");

    assert.strictEqual(updatedAcc.status, "login_required");
    assert.strictEqual(updatedAcc.paused, true);
    assert.strictEqual(updatedJob.status, "paused");
  });

  await t.test("Resume succeeds only after account check returns live", () => {
    const state = store.getTikTokState();
    const acc = state.accounts[0];

    // Cannot resume while login_required
    assert.throws(
      () => manager.resumeAccount(acc.id),
      /LOGIN_REQUIRED/
    );

    // After login checked as live
    store.updateTikTokState(tt => {
      const a = tt.accounts.find(item => item.id === acc.id);
      a.status = "live";
    });

    const res = manager.resumeAccount(acc.id);
    assert.strictEqual(res.ok, true);

    const updated = store.getTikTokState();
    const updatedAcc = updated.accounts.find(a => a.id === acc.id);
    const updatedJob = updated.jobs.find(j => j.id === "job-acc-1");
    assert.strictEqual(updatedAcc.paused, false);
    assert.strictEqual(updatedJob.status, "ready");
  });

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
