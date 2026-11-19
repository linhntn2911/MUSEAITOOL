"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateSettings, validateAccountsList, validateJob } = require("../models/validators");
const { logger } = require("./redacted-log");

const CURRENT_SCHEMA_VERSION = 3;

function createInitialTikTokState() {
  return {
    settings: validateSettings(),
    accounts: [],
    jobs: [],
    mediaAssets: [],
    contentProfiles: [],
    showcaseCatalog: {},
    productMappings: [],
    control: {
      globalPaused: false,
      activeAccountLocks: {}
    }
  };
}

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.stateDir = path.dirname(filePath);
    this.state = null;
  }

  ensureDir() {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
  }

  load() {
    this.ensureDir();
    if (!fs.existsSync(this.filePath)) {
      this.state = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        config: {},
        queue: [],
        logs: [],
        control: {},
        tiktok: createInitialTikTokState()
      };
      this.saveAtomic();
      return this.state;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = this.migrate(parsed);
      return this.state;
    } catch (err) {
      logger.error("state-store", `Lỗi đọc state.json, thử khôi phục từ backup: ${err.message}`);
      const backupPath = `${this.filePath}.backup`;
      if (fs.existsSync(backupPath)) {
        try {
          const backupRaw = fs.readFileSync(backupPath, "utf8");
          this.state = this.migrate(JSON.parse(backupRaw));
          logger.info("state-store", "Khôi phục thành công từ file backup.");
          return this.state;
        } catch (backupErr) {
          logger.error("state-store", `Khôi phục backup thất bại: ${backupErr.message}`);
        }
      }

      this.state = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        config: {},
        queue: [],
        logs: [],
        control: {},
        tiktok: createInitialTikTokState()
      };
      this.saveAtomic();
      return this.state;
    }
  }

  migrate(rawState) {
    if (!rawState || typeof rawState !== "object") {
      return {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        config: {},
        queue: [],
        logs: [],
        control: {},
        tiktok: createInitialTikTokState()
      };
    }

    const state = Object.assign({}, rawState);
    const oldVersion = state.schemaVersion || 1;

    if (oldVersion < CURRENT_SCHEMA_VERSION || !state.tiktok) {
      logger.info("state-store", `Nâng cấp schemaVersion từ ${oldVersion} lên ${CURRENT_SCHEMA_VERSION}`);
      try {
        fs.writeFileSync(`${this.filePath}.backup`, JSON.stringify(rawState, null, 2), "utf8");
      } catch (e) {
        // ignore backup write failure
      }

      state.schemaVersion = CURRENT_SCHEMA_VERSION;
      state.config = state.config || {};
      state.queue = Array.isArray(state.queue) ? state.queue : [];
      state.logs = Array.isArray(state.logs) ? state.logs : [];
      state.control = state.control || {};

      const existingTikTok = state.tiktok || {};
      state.tiktok = {
        settings: validateSettings(existingTikTok.settings || {}),
        accounts: validateAccountsList(existingTikTok.accounts || []),
        jobs: Array.isArray(existingTikTok.jobs) ? existingTikTok.jobs.map(j => validateJob(j)) : [],
        mediaAssets: Array.isArray(existingTikTok.mediaAssets) ? existingTikTok.mediaAssets : [],
        contentProfiles: Array.isArray(existingTikTok.contentProfiles) ? existingTikTok.contentProfiles : [],
        showcaseCatalog: existingTikTok.showcaseCatalog && typeof existingTikTok.showcaseCatalog === "object" ? existingTikTok.showcaseCatalog : {},
        productMappings: Array.isArray(existingTikTok.productMappings) ? existingTikTok.productMappings : [],
        control: existingTikTok.control || { globalPaused: false, activeAccountLocks: {} }
      };

      this.state = state;
      this.saveAtomic();
    } else {
      // Validate existing tiktok state
      state.tiktok.settings = validateSettings(state.tiktok.settings);
      state.tiktok.accounts = validateAccountsList(state.tiktok.accounts || []);
      state.tiktok.jobs = Array.isArray(state.tiktok.jobs) ? state.tiktok.jobs.map(j => validateJob(j)) : [];
      state.tiktok.mediaAssets = Array.isArray(state.tiktok.mediaAssets) ? state.tiktok.mediaAssets : [];
      state.tiktok.contentProfiles = Array.isArray(state.tiktok.contentProfiles) ? state.tiktok.contentProfiles : [];
      state.tiktok.showcaseCatalog = state.tiktok.showcaseCatalog && typeof state.tiktok.showcaseCatalog === "object" ? state.tiktok.showcaseCatalog : {};
      state.tiktok.productMappings = Array.isArray(state.tiktok.productMappings) ? state.tiktok.productMappings : [];
      state.tiktok.control = state.tiktok.control || { globalPaused: false, activeAccountLocks: {} };
    }

    return state;
  }

  saveAtomic() {
    this.ensureDir();
    if (!this.state) return;

    const tmpPath = path.join(
      this.stateDir,
      `state.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).substring(2, 7)}.json`
    );

    const payload = JSON.stringify(this.state, null, 2);
    try {
      fs.writeFileSync(tmpPath, payload, "utf8");
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
      throw new Error(`Ghi file state.json nguyên tử thất bại: ${err.message}`);
    }
  }

  getState() {
    if (!this.state) {
      return this.load();
    }
    return this.state;
  }

  getTikTokState() {
    const s = this.getState();
    return s.tiktok;
  }

  updateTikTokState(mutator) {
    const s = this.getState();
    mutator(s.tiktok);
    this.saveAtomic();
    return s.tiktok;
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  createInitialTikTokState,
  StateStore
};
