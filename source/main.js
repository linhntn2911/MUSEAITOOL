"use strict";

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const { MuseController } = require("./muse");
const { StateStore } = require("./core/state-store");
const { TikTokController } = require("./tiktok/controller");
const { logger } = require("./core/redacted-log");
const { probeMedia } = require("./services/media-probe");
const { mixAudio } = require("./services/audio-mixer");
const { cleanupExpiredMedia } = require("./services/media-cleanup");
const { SecretStore } = require("./services/secret-store");
const { generateContentForJob } = require("./services/content-generator");
const { matchProduct } = require("./tiktok/product-matcher");
const { AccountManager } = require("./tiktok/account-manager");
const { ReconciliationManager } = require("./tiktok/reconciliation");

let win;
let running = false;
let paused = false;
let stopRequested = false;
let currentJobId = null;
const activeJobIds = new Set();
const cancelledJobs = new Set();
const rootDir = process.env.MUSE_AUTOMATION_HOME || (app.isPackaged ? path.dirname(process.execPath) : path.join(app.getPath("userData"), "MuseAutomation"));
const dataDir = path.join(rootDir, "data");
const downloadDir = path.join(dataDir, "downloads");
const stateFile = path.join(dataDir, "state.json");
const secretsFile = path.join(dataDir, "secrets.enc.json");
const recoveredResultsFile = path.join(dataDir, "recovered-results.json");
fs.mkdirSync(downloadDir, { recursive: true });

const secretStore = new SecretStore(secretsFile);
const stateStore = new StateStore(stateFile);
const accountManager = new AccountManager({ stateStore, dataDir });
const state = stateStore.load();

// Initialize TikTok controller and reconciliation manager
const tiktokController = new TikTokController({ stateStore, accountManager });
const reconciliationManager = new ReconciliationManager({ stateStore, accountManager });

// Startup recovery for in-flight submitting/uploading TikTok jobs (FR-033)
tiktokController.recoverPendingJobsOnStartup();

// Recover uncompleted jobs after restart
try {
  if (fs.existsSync(recoveredResultsFile)) {
    const recovered = JSON.parse(fs.readFileSync(recoveredResultsFile, "utf8"));
    for (const job of state.queue) {
      const videoPath = recovered[job.id];
      if (videoPath && fs.existsSync(videoPath)) {
        job.status = "completed";
        job.progress = 100;
        job.detail = "Hoàn tất và đã khôi phục video Muse về máy";
        job.error = "";
        job.result = { videoPath, generatedPrompt: job.generatedPrompt || "" };
      }
    }
    fs.unlinkSync(recoveredResultsFile);
  }
} catch {}

if (Number(state.config?.port) >= 9222 && Number(state.config?.port) <= 9235) state.config.port = 19324;
if (state.config && !state.config.parallelConfigured) { state.config.concurrency = 20; state.config.parallelConfigured = true; }
state.control = { running: false, paused: false, currentJobId: null };
for (const job of state.queue || []) {
  if (job.status === "running") { job.status = "pending"; job.progress = 0; job.detail = "Đã khôi phục sau khi mở lại — chờ Play"; }
}

function saveState() {
  stateStore.saveAtomic();
}

function broadcast() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("state", state);
    if (state.tiktok) {
      win.webContents.send("tiktok:state", state.tiktok);
    }
  }
}

function syncControl() {
  const ids = [...activeJobIds];
  currentJobId = ids[0] || null;
  state.control = { running, paused, currentJobId, currentJobIds: ids };
  saveState();
  broadcast();
}

function log(message) {
  const line = `${new Date().toLocaleTimeString("vi-VN")}  ${message}`;
  state.logs.push(line);
  state.logs = state.logs.slice(-500);
  saveState();
  if (win && !win.isDestroyed()) win.webContents.send("log", line);
}

const muse = new MuseController({ dataDir, downloadDir, port: state.config?.port || 19324, log });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processJob(job) {
  while (paused && !stopRequested) await sleep(250);
  if (stopRequested) return;
  activeJobIds.add(job.id); syncControl();
  job.status = "running"; job.error = ""; job.updatedAt = Date.now(); saveState(); broadcast();
  try {
    const result = await muse.produceVideo(job, (progress, detail) => {
      job.progress = progress; job.detail = detail; job.updatedAt = Date.now(); saveState(); broadcast();
    }, { waitIfPaused: async () => { while (paused && !stopRequested && !cancelledJobs.has(job.id)) await sleep(250); }, isCancelled: () => stopRequested || cancelledJobs.has(job.id) });
    job.status = "completed"; job.result = result;

    // Auto-push completed video to TikTok queue if enabled (FR-001, FR-002)
    if (state.tiktok?.settings?.autoPushCompleted && result?.videoPath) {
      try {
        await tiktokController.addMuseResults([{
          id: job.id,
          videoPath: result.videoPath,
          productImagePath: job.productImage,
          prompt: job.prompt || result.generatedPrompt
        }]);
        broadcast();
      } catch (ttErr) {
        log(`Lỗi tự động chuyển sang TikTok: ${ttErr.message}`);
      }
    }
  } catch (error) {
    if (cancelledJobs.has(job.id)) { state.queue = state.queue.filter((item) => item.id !== job.id); cancelledJobs.delete(job.id); log(`Đã dừng và xóa luồng #${job.id}`); }
    else if (stopRequested || error.code === "MUSE_STOPPED") { job.status = "pending"; job.detail = "Đã dừng — có thể bấm Play để chạy lại"; job.error = ""; }
    else { job.status = "error"; job.error = error.message; log(`Lỗi #${job.id}: ${error.message}`); }
  } finally {
    job.updatedAt = Date.now(); activeJobIds.delete(job.id); saveState(); syncControl();
  }
}

async function runQueue() {
  if (running) return { ok: false, error: "Hàng đợi đang chạy" };
  running = true; paused = false; stopRequested = false; syncControl();
  try {
    const jobs = state.queue.filter((job) => ["pending", "error"].includes(job.status));
    const limit = Math.max(1, Math.min(20, Number(state.config.concurrency) || 20, jobs.length));
    let cursor = 0;
    const worker = async () => {
      while (!stopRequested) {
        const index = cursor++;
        if (index >= jobs.length) return;
        await processJob(jobs[index]);
        if (!stopRequested && cursor < jobs.length) await sleep(Math.max(0, Number(state.config.delaySeconds) || 0) * 1000);
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return { ok: true };
  } finally { running = false; paused = false; stopRequested = false; activeJobIds.clear(); currentJobId = null; syncControl(); }
}

function startQueue() {
  if (running) return { ok: false, error: "Hàng đợi đang chạy" };
  if (!state.queue.some((job) => ["pending", "error"].includes(job.status))) return { ok: false, error: "Chưa có luồng Chờ chạy/Bị lỗi" };
  void runQueue().catch((error) => log(`Engine dừng: ${error.message}`));
  return { ok: true };
}

function createWindow() {
  const smoke = process.argv.includes("--smoke-test");
  win = new BrowserWindow({
    width: 1450, height: 900, minWidth: 1050, minHeight: 680,
    title: "Muse Automation & TikTok Publishing",
    backgroundColor: "#fff5d7", show: !smoke,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, "index.html"));
  if (smoke) win.webContents.once("did-finish-load", async () => {
    try {
      const check = await win.webContents.executeJavaScript(`({
        title: document.title,
        hasPrompt: !!document.querySelector('#prompt'),
        hasProducts: !!document.querySelector('#chooseProducts'),
        hasRun: !!document.querySelector('#run'),
        hasQueue: !!document.querySelector('#queue'),
        hasTikTokTab: !!document.querySelector('#tabTikTok')
      })`);
      console.log(JSON.stringify({ smoke: "ok", ...check }));
      app.exit(check.hasPrompt && check.hasProducts && check.hasRun && check.hasQueue && check.hasTikTokTab ? 0 : 2);
    } catch (error) { console.error(error); app.exit(3); }
  });
}

// Muse IPCs
ipcMain.handle("state:get", () => state);
ipcMain.handle("files:products", async () => {
  const result = await dialog.showOpenDialog(win, { title: "Chọn nhiều ảnh sản phẩm — mỗi ảnh là một luồng", properties: ["openFile", "multiSelections"], filters: [{ name: "Ảnh sản phẩm", extensions: ["png", "jpg", "jpeg", "webp"] }] });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle("files:character", async () => {
  const result = await dialog.showOpenDialog(win, { title: "Chọn ảnh nhân vật cố định", properties: ["openFile"], filters: [{ name: "Ảnh", extensions: ["png", "jpg", "jpeg", "webp"] }] });
  return result.canceled ? "" : (result.filePaths[0] || "");
});
ipcMain.handle("files:preview", (_e, paths) => (paths || []).map((filePath) => {
  try { const ext = path.extname(filePath).toLowerCase(); const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"; return { path: filePath, name: path.basename(filePath), dataUrl: `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}` }; } catch { return null; }
}).filter(Boolean));
ipcMain.handle("config:save", (_e, config) => {
  state.config = { ...state.config, ...config };
  muse.port = Number(state.config.port) || 9224;
  saveState(); broadcast(); return state;
});
ipcMain.handle("muse:open", async () => { await muse.ensureChrome(); return { ok: true }; });
ipcMain.handle("muse:status", async () => muse.status());
ipcMain.handle("muse:show", async () => ({ ok: await muse.setVisible(true) }));
ipcMain.handle("muse:hide", async () => ({ ok: await muse.setVisible(false) }));
ipcMain.handle("queue:add", (_e, jobs) => {
  for (const input of jobs || []) state.queue.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, prompt: String(input.prompt || "").trim(), productImage: input.productImage || "", characterImage: input.characterImage || "", aspect: input.aspect || state.config.aspect, duration: input.duration || state.config.duration, quality: input.quality || state.config.quality, status: "pending", progress: 0, detail: "Chờ chạy", error: "", result: null, createdAt: Date.now() });
  state.queue = state.queue.filter((job) => job.prompt);
  saveState(); broadcast(); return state.queue;
});
ipcMain.handle("queue:remove", (_e, ids) => { const set = new Set(ids || []); for (const id of set) if (activeJobIds.has(id)) cancelledJobs.add(id); state.queue = state.queue.filter((j) => !set.has(j.id) || activeJobIds.has(j.id)); saveState(); broadcast(); return { ok: true }; });
ipcMain.handle("queue:retry", (_e, ids) => { const set = new Set(ids || []); for (const job of state.queue) if (set.has(job.id) || (!set.size && job.status === "error")) { job.status = "pending"; job.error = ""; } saveState(); broadcast(); return state.queue; });
ipcMain.handle("queue:run", () => startQueue());
ipcMain.handle("queue:pause", () => { if (!running) return { ok: false, error: "Hàng đợi chưa chạy" }; paused = true; syncControl(); return { ok: true }; });
ipcMain.handle("queue:resume", () => { if (!running) return startQueue(); paused = false; syncControl(); return { ok: true }; });
ipcMain.handle("queue:stop", () => { if (!running) return { ok: false, error: "Hàng đợi chưa chạy" }; stopRequested = true; paused = false; syncControl(); return { ok: true }; });
ipcMain.handle("queue:run-one", (_e, id) => { const job = state.queue.find((j) => j.id === id); if (!job) return { ok: false, error: "Không tìm thấy luồng" }; if (running) return { ok: false, error: "Hãy dừng hàng đợi hiện tại trước" }; job.status = "pending"; job.error = ""; state.queue = [job, ...state.queue.filter((j) => j.id !== id)]; saveState(); broadcast(); return startQueue(); });
ipcMain.handle("media:scan", async () => ({ ok: true, files: await muse.scanMedia() }));
ipcMain.handle("media:open", async () => { await shell.openPath(downloadDir); return { ok: true, path: downloadDir }; });
ipcMain.handle("media:show", async (_e, filePath) => { if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath); return { ok: true }; });

// TikTok IPC Handlers (US1, US2, US7)
ipcMain.handle("tiktok:accounts:list", () => {
  return stateStore.getTikTokState().accounts;
});
ipcMain.handle("tiktok:accounts:add", async (_e, { label }) => {
  const acc = await accountManager.addAccount(label);
  broadcast();
  return { ok: true, account: acc };
});
ipcMain.handle("tiktok:accounts:check", async (_e, { accountId }) => {
  const res = await accountManager.checkAccount(accountId);
  broadcast();
  return { ok: true, ...res };
});
ipcMain.handle("tiktok:accounts:pause", async (_e, { accountId }) => {
  const res = accountManager.pauseAccount(accountId);
  broadcast();
  return res;
});
ipcMain.handle("tiktok:accounts:resume", async (_e, { accountId }) => {
  const res = accountManager.resumeAccount(accountId);
  broadcast();
  return res;
});
ipcMain.handle("tiktok:accounts:remove", async (_e, { accountId, removeProfile }) => {
  const res = await accountManager.removeAccount(accountId, removeProfile);
  broadcast();
  return res;
});

ipcMain.handle("tiktok:state:get", () => stateStore.getTikTokState());
ipcMain.handle("tiktok:jobs:add-files", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Chọn video để đưa vào hàng đợi TikTok",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Video MP4/WebM", extensions: ["mp4", "webm", "mov"] }]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { added: [], skipped: [] };
  }
  const outcome = await tiktokController.addFiles(result.filePaths);
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:add-muse-results", async (_e, { museJobIds }) => {
  const ids = new Set(museJobIds || []);
  const matchingJobs = state.queue
    .filter(j => ids.has(j.id) && j.result?.videoPath)
    .map(j => ({
      id: j.id,
      videoPath: j.result.videoPath,
      productImagePath: j.productImage,
      prompt: j.prompt || j.result.generatedPrompt
    }));
  const outcome = await tiktokController.addMuseResults(matchingJobs);
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:update", async (_e, { jobId, patch, expectedUpdatedAt }) => {
  const outcome = await tiktokController.updateJob(jobId, patch, expectedUpdatedAt);
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:remove", async (_e, { jobIds, deleteProcessed }) => {
  const outcome = await tiktokController.removeJobs(jobIds, { deleteProcessed });
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:run", async (_e, { jobIds }) => {
  const outcome = await tiktokController.runJobs(jobIds);
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:pause", async (_e, { jobIds }) => {
  const outcome = tiktokController.pauseJobs(jobIds);
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:resume", async (_e, { jobIds }) => {
  const outcome = tiktokController.resumeJobs(jobIds);
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:stop", async (_e, { jobIds }) => {
  const outcome = tiktokController.stopJobs(jobIds);
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:retry", async (_e, { jobIds }) => {
  const outcome = tiktokController.retryJobs(jobIds);
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:reconcile", async (_e, { jobId, decision, note }) => {
  const outcome = await reconciliationManager.reconcileJob(jobId, decision, { note });
  broadcast();
  return outcome;
});
ipcMain.handle("tiktok:jobs:recalculate-schedule", async (_e, { jobIds }) => {
  const outcome = await tiktokController.recalculateSchedule(jobIds);
  broadcast();
  return outcome;
});

// Audio & Media IPC Handlers (US3)
ipcMain.handle("tiktok:audio:choose-source", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Chọn nguồn nhạc (file âm thanh MP3/WAV hoặc video MP4)",
    properties: ["openFile"],
    filters: [{ name: "Audio / Video", extensions: ["mp3", "wav", "m4a", "aac", "mp4", "webm"] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const probe = await probeMedia(filePath);
  return { path: filePath, name: path.basename(filePath), ...probe };
});

ipcMain.handle("tiktok:audio:process", async (_e, { jobIds }) => {
  const ttState = stateStore.getTikTokState();
  const targetJobs = jobIds && jobIds.length > 0
    ? ttState.jobs.filter(j => jobIds.includes(j.id))
    : ttState.jobs;

  const results = [];
  for (const job of targetJobs) {
    if (!job.audio?.sourcePath || !fs.existsSync(job.audio.sourcePath)) continue;
    const srcAsset = ttState.mediaAssets.find(a => a.id === job.sourceVideoAssetId);
    if (!srcAsset || !fs.existsSync(srcAsset.path)) continue;

    const outName = `mixed-${path.basename(srcAsset.path, path.extname(srcAsset.path))}-${Date.now()}.mp4`;
    const outPath = path.join(downloadDir, outName);

    try {
      const mixRes = await mixAudio(srcAsset.path, job.audio.sourcePath, outPath, job.audio);
      const assetId = `asset-proc-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const retentionDate = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

      stateStore.updateTikTokState(s => {
        s.mediaAssets.push({
          id: assetId,
          kind: "processed_video",
          path: outPath,
          fingerprint: `fp-${outName}`,
          durationSeconds: mixRes.durationSeconds,
          parentAssetId: srcAsset.id,
          retentionEligibleAt: retentionDate,
          pinned: false,
          exists: true
        });

        const j = s.jobs.find(item => item.id === job.id);
        if (j) {
          j.uploadVideoAssetId = assetId;
          j.status = "ready";
          j.updatedAt = new Date().toISOString();
        }
      });
      results.push({ jobId: job.id, ok: true, outPath });
    } catch (err) {
      results.push({ jobId: job.id, ok: false, error: err.message });
    }
  }
  broadcast();
  return { ok: true, results };
});

ipcMain.handle("tiktok:audio:pin", async (_e, { mediaAssetId, pinned }) => {
  stateStore.updateTikTokState(s => {
    const asset = s.mediaAssets.find(a => a.id === mediaAssetId);
    if (asset) {
      asset.pinned = Boolean(pinned);
    }
  });
  broadcast();
  return { ok: true };
});

ipcMain.handle("tiktok:media:cleanup", async (_e, { dryRun }) => {
  const ttState = stateStore.getTikTokState();
  const outcome = await cleanupExpiredMedia(ttState.mediaAssets, { dryRun });
  saveState();
  broadcast();
  return outcome;
});

// Content IPC Handlers (US4)
ipcMain.handle("tiktok:content:test-key", async (_e, { apiKey }) => {
  try {
    const res = await generateContentForJob(
      { sourcePrompt: "Xin chào", accountMode: "no_cart" },
      { apiKey, model: "gemini-3.8-flash" }
    );
    return { ok: true, sample: res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tiktok:content:save-key", async (_e, { apiKey }) => {
  try {
    const masked = secretStore.saveApiKey(apiKey);
    return { ok: true, maskedKey: masked };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tiktok:content:generate", async (_e, { jobIds, options = {} }) => {
  const apiKey = secretStore.getApiKey();
  const ttState = stateStore.getTikTokState();
  const targetJobs = jobIds && jobIds.length > 0
    ? ttState.jobs.filter(j => jobIds.includes(j.id))
    : ttState.jobs;

  const results = [];
  for (const job of targetJobs) {
    let imgB64 = null;
    if (job.productImageAssetId) {
      const asset = ttState.mediaAssets.find(a => a.id === job.productImageAssetId);
      if (asset && fs.existsSync(asset.path)) {
        try { imgB64 = fs.readFileSync(asset.path).toString("base64"); } catch (_) {}
      }
    }

    try {
      const gen = await generateContentForJob(job, {
        apiKey,
        model: ttState.settings?.geminiModel || "gemini-3.8-flash",
        tone: options.tone || job.content?.tone,
        imageBase64: imgB64
      });

      stateStore.updateTikTokState(s => {
        const j = s.jobs.find(item => item.id === job.id);
        if (j) {
          // Push previous version into history for restore (FR-022)
          if (!j.content) j.content = {};
          if (!Array.isArray(j.content.versionHistory)) j.content.versionHistory = [];
          j.content.versionHistory.push({
            title: j.content.title,
            caption: j.content.caption,
            hashtags: j.content.hashtags,
            cartTitle: j.content.cartTitle,
            savedAt: new Date().toISOString()
          });

          j.content.title = gen.title;
          j.content.caption = gen.caption;
          j.content.hashtags = gen.hashtags;
          j.content.cartTitle = gen.cartTitle;
          j.content.productKeywords = gen.productKeywords;
          j.content.generatedAt = new Date().toISOString();
          j.updatedAt = new Date().toISOString();
        }
      });
      results.push({ jobId: job.id, ok: true });
    } catch (err) {
      // Keep previous content on failure (FR-023)
      results.push({ jobId: job.id, ok: false, error: err.message });
      log(`Lỗi tạo nội dung AI cho job ${job.id}: ${err.message}`);
    }
  }

  broadcast();
  return { ok: true, results };
});

ipcMain.handle("tiktok:content:restore", async (_e, { jobIds }) => {
  stateStore.updateTikTokState(s => {
    const targetJobs = jobIds && jobIds.length > 0
      ? s.jobs.filter(j => jobIds.includes(j.id))
      : s.jobs;

    for (const j of targetJobs) {
      if (j.content?.versionHistory && j.content.versionHistory.length > 0) {
        const prev = j.content.versionHistory.pop();
        j.content.title = prev.title;
        j.content.caption = prev.caption;
        j.content.hashtags = prev.hashtags;
        j.content.cartTitle = prev.cartTitle;
        j.updatedAt = new Date().toISOString();
      }
    }
  });
  broadcast();
  return { ok: true };
});

// Products IPC Handlers (US5)
ipcMain.handle("tiktok:products:verify", async (_e, { jobIds, products = [] }) => {
  stateStore.updateTikTokState(s => {
    const targetJobs = jobIds && jobIds.length > 0
      ? s.jobs.filter(j => jobIds.includes(j.id))
      : s.jobs;

    for (const j of targetJobs) {
      if (j.accountMode === "no_cart") continue;
      const match = matchProduct({
        productId: j.productMatch?.productId || j.productId,
        keyword: j.content?.productKeywords?.[0] || j.sourcePrompt
      }, products);
      j.productMatch = match;
      if (match.confirmed) {
        j.status = "ready";
      } else if (match.candidates.length > 0) {
        j.status = "waiting_product_confirmation";
      }
      j.updatedAt = new Date().toISOString();
    }
  });
  broadcast();
  return { ok: true };
});

ipcMain.handle("tiktok:products:confirm", async (_e, { jobId, product }) => {
  stateStore.updateTikTokState(s => {
    const j = s.jobs.find(item => item.id === jobId);
    if (j) {
      j.productMatch = {
        confirmed: true,
        autoConfirmed: false,
        confidence: 1.0,
        selectedProduct: product,
        candidates: [product],
        verifiedAt: new Date().toISOString()
      };
      j.status = "ready";
      j.updatedAt = new Date().toISOString();
    }
  });
  broadcast();
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on("before-quit", () => {
  try {
    tiktokController.stopJobs();
    saveState();
  } catch (_) {}
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
