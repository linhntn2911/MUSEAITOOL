"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { StateStore, CURRENT_SCHEMA_VERSION } = require("../../source/core/state-store");

test("StateStore schema migration and structure", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-state-"));
  const tempStatePath = path.join(tempDir, "state.json");

  await t.test("Initializes default state when file does not exist", () => {
    const store = new StateStore(tempStatePath);
    const state = store.getState();

    assert.strictEqual(state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.ok(state.tiktok);
    assert.ok(state.tiktok.settings);
    assert.deepStrictEqual(state.tiktok.accounts, []);
    assert.deepStrictEqual(state.tiktok.jobs, []);
    assert.strictEqual(state.tiktok.settings.intervalMinutes, 60);
    assert.strictEqual(state.tiktok.settings.geminiModel, "gemini-3.5-flash-lite");
  });

  await t.test("Idempotently migrates v1 Muse state without losing existing queue", () => {
    const v1State = {
      config: { apiKey: "muse-legacy-test" },
      queue: [{ id: "job-1", prompt: "test prompt" }],
      logs: ["legacy log line"]
    };
    fs.writeFileSync(tempStatePath, JSON.stringify(v1State), "utf8");

    const store = new StateStore(tempStatePath);
    const migrated = store.getState();

    assert.strictEqual(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(migrated.queue.length, 1);
    assert.strictEqual(migrated.queue[0].id, "job-1");
    assert.ok(migrated.tiktok);
    assert.ok(migrated.tiktok.settings);

    // Verify atomic persistence to file
    const fileContent = JSON.parse(fs.readFileSync(tempStatePath, "utf8"));
    assert.strictEqual(fileContent.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(fileContent.queue[0].id, "job-1");
  });

  await t.test("Validates and normalizes TikTok accounts and jobs", () => {
    const store = new StateStore(tempStatePath);
    store.updateTikTokState(tt => {
      tt.accounts.push({
        id: "acc-1",
        label: "Kênh thời trang",
        profilePath: "D:/Muse-Automation/data/profiles/acc-1",
        cdpPort: 19222,
        paused: false,
        status: "live"
      });
      tt.jobs.push({
        id: "job-101",
        sourceFingerprint: "fp-101",
        sourceVideoAssetId: "asset-v-1",
        sourceKind: "muse_result",
        status: "draft",
        progress: 0
      });
    });

    const current = store.getTikTokState();
    assert.strictEqual(current.accounts.length, 1);
    assert.strictEqual(current.accounts[0].label, "Kênh thời trang");
    assert.strictEqual(current.jobs.length, 1);
    assert.strictEqual(current.jobs[0].sourceFingerprint, "fp-101");
  });

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
