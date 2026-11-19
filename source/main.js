"use strict";

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { MuseController } = require("./muse");
const { StateStore } = require("./core/state-store");
const { TikTokController } = require("./tiktok/controller");
const { logger } = require("./core/redacted-log");
const { probeMedia } = require("./services/media-probe");
const { mixAudio } = require("./services/audio-mixer");
const { cleanupExpiredMedia } = require("./services/media-cleanup");
const { SecretStore } = require("./services/secret-store");
const { generateContentForJob } = require("./services/content-generator");
const { matchProduct, lockProduct } = require("./tiktok/product-matcher");
const { StudioAdapter } = require("./tiktok/studio-adapter");
const { rankShowcaseProducts } = require("./services/product-vision-matcher");
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
const execFileAsync = promisify(execFile);
const stateStore = new StateStore(stateFile);
const accountManager = new AccountManager({ stateStore, dataDir });
const state = stateStore.load();
// Caption là tác vụ nhẹ, ưu tiên model Flash-Lite thông lượng cao. Bản cũ dùng
// 3.8 Flash thường trả 503 vào giờ cao điểm.
if (state.tiktok?.settings?.geminiModel === "gemini-3.8-flash") {
  state.tiktok.settings.geminiModel = "gemini-3.5-flash-lite";
  stateStore.saveAtomic();
}

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
  if (!job.mode) {
    const promptText = String(job.prompt || "").toLowerCase();
    job.mode = promptText.includes("fashion_try_on_mode") || promptText.includes("thời trang") || promptText.includes("trang phục") ? "fashion"
      : promptText.includes("mica") || promptText.includes("acrylic") || promptText.includes("gia dụng") ? "household"
        : "store";
  }
  if (job.status === "running") { job.status = "pending"; job.progress = 0; job.detail = "Đã khôi phục sau khi mở lại — chờ Play"; }
  if (job.status === "completed" && job.result?.videoPath && !fs.existsSync(job.result.videoPath)) {
    job.status = "error";
    job.progress = 0;
    job.detail = "File video lần trước không tồn tại — hãy chạy lại luồng";
    job.error = "Không tìm thấy MP4 đã tải; kết quả cũ không được tính là hoàn tất";
    job.result = null;
  }
}

function saveState() {
  stateStore.saveAtomic();
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
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
    if (result?.videoPath && fs.existsSync(result.videoPath)) {
      result.sha256 = sha256File(result.videoPath);
      const duplicate = state.queue.find(other => {
        if (other.id === job.id || !other.result?.videoPath || !fs.existsSync(other.result.videoPath)) return false;
        const priorHash = other.result.sha256 || (() => { try { return sha256File(other.result.videoPath); } catch (_) { return ""; } })();
        if (priorHash) other.result.sha256 = priorHash;
        return priorHash === result.sha256;
      });
      if (duplicate) {
        try { fs.unlinkSync(result.videoPath); } catch (_) {}
        throw new Error(`Muse trả lại video trùng với luồng #${duplicate.id}; đã bỏ kết quả để không lưu lặp.`);
      }
    }
    job.status = "completed"; job.result = result;

    // Auto-push completed video to TikTok queue if enabled (FR-001, FR-002)
    if (state.tiktok?.settings?.autoPushCompleted && result?.videoPath) {
      try {
        const ttOutcome = await tiktokController.addMuseResults([{
          id: job.id,
          videoPath: result.videoPath,
          productImagePath: job.productImage,
          prompt: job.prompt || result.generatedPrompt
        }]);
        if (state.tiktok?.settings?.autoGenerateContent && ttOutcome.added?.length) {
          await generateTikTokContent(ttOutcome.added.map(item => item.id), { tone: state.tiktok.settings.defaultTone });
        }
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
    // Keep the queue live while jobs are running. Jobs added after Play must be
    // claimed by the same run instead of being stranded until the next Play.
    const attempted = new Set();
    const inFlight = new Set();
    let idleChecks = 0;
    let launchedCount = 0;
    while (!stopRequested) {
      const limit = Math.max(1, Math.min(20, Number(state.config.concurrency) || 20));
      const available = Math.max(0, limit - inFlight.size);
      const waiting = state.queue.filter((job) =>
        ["pending", "error"].includes(job.status) &&
        !attempted.has(job.id) &&
        !activeJobIds.has(job.id)
      );

      for (const job of waiting.slice(0, available)) {
        // Initial capacity is filled immediately, matching the original tool's
        // multi-window launch. delaySeconds only spaces replacement jobs after
        // the first full batch, not every tab in the initial batch.
        const spacing = Math.max(0, Number(state.config.delaySeconds) || 0) * 1000;
        if (launchedCount >= limit && spacing) await sleep(spacing);
        attempted.add(job.id);
        let task;
        task = processJob(job).finally(() => inFlight.delete(task));
        inFlight.add(task);
        launchedCount += 1;
      }

      const stillWaiting = state.queue.some((job) =>
        ["pending", "error"].includes(job.status) && !attempted.has(job.id)
      );
      if (!inFlight.size && !stillWaiting) {
        idleChecks += 1;
        if (idleChecks >= 4) break;
      } else {
        idleChecks = 0;
      }
      await Promise.race([sleep(500), ...inFlight]);
    }
    await Promise.allSettled([...inFlight]);
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
  for (const input of jobs || []) {
    const motionVariant = Math.max(0, Number(state.config.motionSequence) || 0) % 20;
    state.config.motionSequence = motionVariant + 1;
    state.queue.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, prompt: String(input.prompt || "").trim(), productImage: input.productImage || "", characterImage: input.characterImage || "", mode: ["fashion", "household", "store"].includes(input.mode) ? input.mode : "household", motionVariant, aspect: input.aspect || state.config.aspect, duration: input.duration || state.config.duration, quality: input.quality || state.config.quality, status: "pending", progress: 0, detail: "Chờ chạy", error: "", result: null, createdAt: Date.now() });
  }
  state.queue = state.queue.filter((job) => job.prompt);
  if (running) log(`Đã thêm ${jobs?.length || 0} luồng mới vào phiên đang chạy`);
  saveState(); broadcast(); return state.queue;
});
ipcMain.handle("queue:remove", (_e, ids) => { const set = new Set(ids || []); for (const id of set) if (activeJobIds.has(id)) cancelledJobs.add(id); state.queue = state.queue.filter((j) => !set.has(j.id) || activeJobIds.has(j.id)); saveState(); broadcast(); return { ok: true }; });
ipcMain.handle("queue:delete-completed-videos", async (_e, ids) => {
  const requested = new Set(ids || []);
  const jobs = state.queue.filter((job) => requested.has(job.id) && job.status === "completed" && job.result?.videoPath && !activeJobIds.has(job.id));
  if (!jobs.length) return { ok: false, error: "Chưa chọn video đã hoàn tất nào" };

  const root = path.resolve(downloadDir);
  const candidates = jobs.map((job) => {
    const filePath = path.resolve(job.result.videoPath);
    const relative = path.relative(root, filePath);
    const insideDownloads = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    const videoExtension = /\.(mp4|webm|mov)$/i.test(filePath);
    return { job, filePath, safe: insideDownloads && videoExtension };
  });
  const safeCandidates = candidates.filter((item) => item.safe);
  if (!safeCandidates.length) return { ok: false, error: "Không có video hợp lệ nằm trong thư mục Media của tool" };

  const confirmation = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Hủy", "Xóa vĩnh viễn"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Xóa hàng loạt video đã hoàn tất",
    message: `Xóa vĩnh viễn ${safeCandidates.length} video đã chọn?`,
    detail: "File MP4, dòng Xưởng Video và bài TikTok đang tham chiếu các file này sẽ bị xóa. Ảnh sản phẩm gốc không bị ảnh hưởng. Thao tác này không thể hoàn tác."
  });
  if (confirmation.response !== 1) return { ok: false, cancelled: true, error: "Đã hủy xóa video" };

  const removedJobIds = new Set();
  const deletedPaths = new Set();
  const failed = [];
  for (const item of safeCandidates) {
    try {
      await fs.promises.unlink(item.filePath);
      removedJobIds.add(item.job.id);
      deletedPaths.add(path.normalize(item.filePath).toLowerCase());
    } catch (error) {
      if (error?.code === "ENOENT") {
        removedJobIds.add(item.job.id);
        deletedPaths.add(path.normalize(item.filePath).toLowerCase());
      } else {
        failed.push({ file: path.basename(item.filePath), error: error.message });
      }
    }
  }

  state.queue = state.queue.filter((job) => !removedJobIds.has(job.id));
  if (deletedPaths.size) {
    stateStore.updateTikTokState((tt) => {
      const removedAssetIds = new Set((tt.mediaAssets || [])
        .filter((asset) => deletedPaths.has(path.normalize(asset.path || "").toLowerCase()))
        .map((asset) => asset.id));
      tt.jobs = (tt.jobs || []).filter((job) => !removedAssetIds.has(job.sourceVideoAssetId) && !removedAssetIds.has(job.uploadVideoAssetId));
      tt.mediaAssets = (tt.mediaAssets || []).filter((asset) => !removedAssetIds.has(asset.id));
    });
  }
  saveState();
  log(`Đã xóa vĩnh viễn ${removedJobIds.size} video hoàn tất khỏi Media`);
  broadcast();
  return { ok: true, deleted: removedJobIds.size, failed };
});
ipcMain.handle("queue:retry", (_e, ids) => { const set = new Set(ids || []); for (const job of state.queue) if (set.has(job.id) || (!set.size && job.status === "error")) { job.status = "pending"; job.error = ""; } saveState(); broadcast(); return state.queue; });
ipcMain.handle("queue:run", () => startQueue());
ipcMain.handle("queue:pause", () => { if (!running) return { ok: false, error: "Hàng đợi chưa chạy" }; paused = true; syncControl(); return { ok: true }; });
ipcMain.handle("queue:resume", () => { if (!running) return startQueue(); paused = false; syncControl(); return { ok: true }; });
ipcMain.handle("queue:stop", () => { if (!running) return { ok: false, error: "Hàng đợi chưa chạy" }; stopRequested = true; paused = false; syncControl(); return { ok: true }; });
ipcMain.handle("queue:run-one", (_e, id) => { const job = state.queue.find((j) => j.id === id); if (!job) return { ok: false, error: "Không tìm thấy luồng" }; job.status = "pending"; job.error = ""; job.detail = running ? "Đã đưa vào phiên đang chạy" : "Chờ chạy"; state.queue = [job, ...state.queue.filter((j) => j.id !== id)]; saveState(); broadcast(); return running ? { ok: true } : startQueue(); });
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
ipcMain.handle("tiktok:accounts:check", async (_e, { accountId } = {}) => {
  if (accountId && accountId !== "all") {
    const res = await accountManager.checkAccount(accountId);
    broadcast();
    return { ok: true, ...res };
  } else {
    const accs = stateStore.getTikTokState().accounts || [];
    const results = [];
    for (const a of accs) {
      try {
        const r = await accountManager.checkAccount(a.id);
        results.push({ accountId: a.id, ...r });
      } catch (err) {
        results.push({ accountId: a.id, status: "error", error: err.message });
      }
    }
    broadcast();
    return { ok: true, results };
  }
});
ipcMain.handle("tiktok:accounts:show", async (_e, { accountId } = {}) => {
  if (accountId && accountId !== "all") {
    await accountManager.showAccount(accountId);
  } else {
    const accs = stateStore.getTikTokState().accounts || [];
    for (const a of accs) {
      await accountManager.showAccount(a.id);
    }
  }
  return { ok: true };
});
ipcMain.handle("tiktok:accounts:hide", async (_e, { accountId } = {}) => {
  if (accountId && accountId !== "all") {
    await accountManager.hideAccount(accountId);
  } else {
    const accs = stateStore.getTikTokState().accounts || [];
    for (const a of accs) {
      await accountManager.hideAccount(a.id);
    }
  }
  return { ok: true };
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
  if (state.tiktok?.settings?.autoGenerateContent && outcome.added?.length) {
    outcome.content = await generateTikTokContent(outcome.added.map(item => item.id), { tone: state.tiktok.settings.defaultTone });
  }
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
const TRUSTED_VISUAL_MATCH_THRESHOLD = 0.98;

function autoLockTrustedProductMatches(jobIds) {
  const ids = new Set(Array.isArray(jobIds) ? jobIds : (jobIds ? [jobIds] : []));
  stateStore.updateTikTokState(s => {
    for (const job of s.jobs) {
      if (ids.size && !ids.has(job.id)) continue;
      const proposal = job.productMatch;
      if (proposal?.confirmed || proposal?.source !== "gemini_visual_proposal") continue;
      if (Number(proposal.confidence) < TRUSTED_VISUAL_MATCH_THRESHOLD) continue;
      const catalog = s.showcaseCatalog?.[job.accountId]?.products || [];
      const product = catalog.find(p => String(p.id) === String(proposal.productId)) || proposal.selectedProduct;
      if (!product?.id) continue;
      const locked = lockProduct(product, {
        autoConfirmed: true,
        confidence: proposal.confidence,
        source: "gemini_visual_high_confidence"
      });
      locked.reason = proposal.reason || "Ảnh sản phẩm khớp với Showcase ở độ tin cậy rất cao.";
      job.productMatch = locked;
      job.status = "ready";
      job.error = null;
      job.updatedAt = new Date().toISOString();
      const asset = s.mediaAssets.find(a => a.id === job.productImageAssetId);
      if (asset?.fingerprint) {
        s.productMappings = s.productMappings.filter(m => !(m.accountId === job.accountId && m.imageFingerprint === asset.fingerprint));
        s.productMappings.push({
          accountId: job.accountId,
          imageFingerprint: asset.fingerprint,
          productId: String(product.id),
          product,
          confirmedAt: new Date().toISOString(),
          source: "gemini_visual_high_confidence"
        });
      }
    }
  });
}

ipcMain.handle("tiktok:jobs:run", async (_e, { jobIds }) => {
  autoLockTrustedProductMatches(jobIds);
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
function productImageForContent(ttState, job) {
  if (!job.productImageAssetId) return {};
  const asset = ttState.mediaAssets.find(a => a.id === job.productImageAssetId);
  if (!asset || !fs.existsSync(asset.path)) return {};
  try {
    const ext = path.extname(asset.path).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return { imageBase64: fs.readFileSync(asset.path).toString("base64"), imageMimeType: mime };
  } catch {
    return {};
  }
}

async function generateTikTokContent(jobIds, options = {}) {
  const normalizedIds = Array.isArray(jobIds) ? jobIds : (jobIds ? [jobIds] : []);
  const apiKey = secretStore.getApiKey();
  if (!apiKey) return { ok: false, error: "Chưa có Gemini API key. Hãy nhập key ở mục AI và bấm Lưu & kiểm tra.", results: [] };

  const ttState = stateStore.getTikTokState();
  const targetJobs = normalizedIds.length > 0
    ? ttState.jobs.filter(j => normalizedIds.includes(j.id))
    : ttState.jobs;
  if (targetJobs.length === 0) return { ok: false, error: "Không tìm thấy video cần viết nội dung.", results: [] };

  stateStore.updateTikTokState(s => {
    for (const job of s.jobs) {
      if (!targetJobs.some(target => target.id === job.id)) continue;
      job.content.generationStatus = "generating";
      job.content.generationError = null;
    }
  });
  broadcast();

  const results = [];
  let cursor = 0;
  const processOne = async (job) => {
    try {
      const image = productImageForContent(ttState, job);
      const gen = await generateContentForJob(job, {
        apiKey,
        model: ttState.settings?.geminiModel || "gemini-3.5-flash-lite",
        tone: options.tone || job.content?.tone || ttState.settings?.defaultTone,
        ...image
      });
      if (!gen.caption || !gen.title) throw new Error("Gemini trả về caption hoặc tiêu đề rỗng.");
      gen.hashtags = Array.from(new Set([...(gen.hashtags || []), ...(ttState.settings?.defaultHashtags || [])])).slice(0, 8);

      stateStore.updateTikTokState(s => {
        const j = s.jobs.find(item => item.id === job.id);
        if (!j) return;
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
        j.content.tone = options.tone || j.content.tone || "review";
        j.content.generatedAt = new Date().toISOString();
        j.content.generationStatus = "ready";
        j.content.generationError = null;
        j.updatedAt = new Date().toISOString();
      });
      results.push({ jobId: job.id, ok: true });
    } catch (err) {
      stateStore.updateTikTokState(s => {
        const j = s.jobs.find(item => item.id === job.id);
        if (!j) return;
        j.content.generationStatus = "error";
        j.content.generationError = err.message;
        j.updatedAt = new Date().toISOString();
      });
      results.push({ jobId: job.id, ok: false, error: err.message });
      log(`Lỗi tạo caption AI cho ${job.id}: ${err.message}`);
    }
    broadcast();
  };
  const worker = async () => {
    while (cursor < targetJobs.length) {
      const job = targetJobs[cursor++];
      await processOne(job);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, targetJobs.length) }, () => worker()));
  const succeeded = results.filter(item => item.ok).length;
  broadcast();
  return { ok: succeeded > 0, succeeded, failed: results.length - succeeded, results, error: succeeded ? null : results[0]?.error };
}

ipcMain.handle("tiktok:content:test-key", async (_e, { apiKey }) => {
  try {
    const res = await generateContentForJob(
      { sourcePrompt: "Xin chào", accountMode: "no_cart" },
      { apiKey, model: "gemini-3.5-flash-lite" }
    );
    return { ok: true, sample: res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tiktok:content:key-status", () => ({
  ok: true,
  configured: secretStore.hasApiKey(),
  maskedKey: secretStore.getMaskedKey()
}));

ipcMain.handle("tiktok:content:save-key", async (_e, { apiKey }) => {
  try {
    const masked = secretStore.saveApiKey(apiKey);
    return { ok: true, maskedKey: masked };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tiktok:content:generate", async (_e, { jobIds, options = {} }) => {
  return generateTikTokContent(jobIds, options);
});

ipcMain.handle("tiktok:settings:update", async (_e, { patch = {} }) => {
  stateStore.updateTikTokState(s => {
    s.settings = Object.assign({}, s.settings, patch);
  });
  broadcast();
  return { ok: true, settings: stateStore.getTikTokState().settings };
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
async function ensureShowcaseSyncVideo() {
  const probePath = path.join(dataDir, "showcase-sync-probe.mp4");
  if (fs.existsSync(probePath) && fs.statSync(probePath).size > 1000) return probePath;
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x111111:s=360x640:d=3:r=24",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", probePath
  ], { windowsHide: true, timeout: 60000 });
  return probePath;
}

ipcMain.handle("tiktok:products:sync-showcase", async (_e, { accountId }) => {
  const tt = stateStore.getTikTokState();
  const account = tt.accounts.find(a => a.id === accountId);
  if (!account) return { ok: false, error: "Chưa chọn kênh TikTok." };
  const adapter = new StudioAdapter({ cdpPort: account.cdpPort });
  try {
    await accountManager.ensureChrome(account, true, "https://www.tiktok.com/tiktokstudio/upload?lang=vi-VN");
    await adapter.connect(account.cdpPort, null);
    let products = await adapter.collectShowcaseProducts();
    products = Array.isArray(products) ? products : [];
    if (!products.length) {
      await adapter.openShowcasePicker();
      products = await adapter.collectShowcaseProducts();
      products = Array.isArray(products) ? products : [];
    }
    if (!products.length) {
      const probePath = await ensureShowcaseSyncVideo();
      try {
        await adapter.uploadVideo(probePath);
        const pickerOpened = await adapter.openShowcasePicker();
        if (pickerOpened) products = await adapter.collectShowcaseProducts();
        products = Array.isArray(products) ? products : [];
      } finally {
        await adapter.discardCurrentDraft().catch(() => {});
      }
    }
    if (!products.length) {
      return { ok: false, error: "Chưa thấy danh sách sản phẩm Showcase trên tab TikTok. Hãy mở hộp Chọn sản phẩm một lần rồi bấm Đồng bộ lại." };
    }
    stateStore.updateTikTokState(s => {
      s.showcaseCatalog[accountId] = { updatedAt: new Date().toISOString(), products };
    });
    broadcast();
    return { ok: true, count: products.length };
  } finally {
    try { await adapter.close(); } catch (_) {}
  }
});

ipcMain.handle("tiktok:products:verify", async (_e, { jobIds } = {}) => {
  const ids = Array.isArray(jobIds) ? jobIds : (jobIds ? [jobIds] : []);
  const tt = stateStore.getTikTokState();
  const targetJobs = ids.length ? tt.jobs.filter(j => ids.includes(j.id)) : tt.jobs;
  const apiKey = secretStore.getApiKey();
  const outcomes = [];
  for (const job of targetJobs) {
    if (job.accountMode === "no_cart") continue;
    const catalog = tt.showcaseCatalog?.[job.accountId]?.products || [];
    const imageAsset = tt.mediaAssets.find(a => a.id === job.productImageAssetId);
    const imageFingerprint = imageAsset?.fingerprint || "";
    const saved = tt.productMappings.find(m => m.accountId === job.accountId && m.imageFingerprint === imageFingerprint);
    let match;
    if (saved) {
      const product = catalog.find(p => String(p.id) === String(saved.productId)) || saved.product;
      match = product ? lockProduct(product, { autoConfirmed: true, source: "saved_image_mapping" }) : null;
    }
    if (!match && job.productMatch?.source === "gemini_visual_proposal" && Number(job.productMatch.confidence) >= TRUSTED_VISUAL_MATCH_THRESHOLD) {
      const product = catalog.find(p => String(p.id) === String(job.productMatch.productId)) || job.productMatch.selectedProduct;
      if (product?.id) {
        match = lockProduct(product, {
          autoConfirmed: true,
          confidence: job.productMatch.confidence,
          source: "gemini_visual_high_confidence"
        });
        match.reason = job.productMatch.reason || "Ảnh sản phẩm khớp với Showcase ở độ tin cậy rất cao.";
      }
    }
    if (!match) {
      match = matchProduct({ productId: job.productMatch?.productId || "", keyword: job.content?.productKeywords?.[0] || "" }, catalog);
      // A typed exact ID is safe; image AI only proposes and still requires one click.
      if (!match.confirmed && apiKey && imageAsset?.path && catalog.length) {
        try {
          const visual = await rankShowcaseProducts({ apiKey, model: tt.settings?.geminiModel, referencePath: imageAsset.path, products: catalog });
          if (visual.selectedProduct) {
            if (visual.confidence >= TRUSTED_VISUAL_MATCH_THRESHOLD) {
              match = lockProduct(visual.selectedProduct, {
                autoConfirmed: true,
                confidence: visual.confidence,
                source: "gemini_visual_high_confidence"
              });
              match.reason = visual.reason;
            } else {
              match = {
                confirmed: false,
                autoConfirmed: false,
                confidence: visual.confidence,
                productId: String(visual.selectedProduct.id),
                productName: visual.selectedProduct.title || visual.selectedProduct.name || "",
                productImageUrl: visual.selectedProduct.imageUrl || "",
                selectedProduct: visual.selectedProduct,
                candidates: [visual.selectedProduct, ...catalog.filter(p => String(p.id) !== String(visual.selectedProduct.id)).slice(0, 4)],
                reason: visual.reason,
                source: "gemini_visual_proposal",
                verifiedAt: new Date().toISOString()
              };
            }
          }
        } catch (error) {
          match.matchError = error.message;
        }
      }
    }
    stateStore.updateTikTokState(s => {
      const j = s.jobs.find(item => item.id === job.id);
      if (!j) return;
      j.productMatch = match;
      j.status = match?.confirmed ? "ready" : "waiting_product_confirmation";
      j.updatedAt = new Date().toISOString();
      if (match?.confirmed && imageFingerprint && match.selectedProduct) {
        s.productMappings = s.productMappings.filter(m => !(m.accountId === j.accountId && m.imageFingerprint === imageFingerprint));
        s.productMappings.push({
          accountId: j.accountId,
          imageFingerprint,
          productId: String(match.productId),
          product: match.selectedProduct,
          confirmedAt: new Date().toISOString(),
          source: match.source
        });
      }
    });
    outcomes.push({ jobId: job.id, confirmed: Boolean(match?.confirmed), candidates: match?.candidates?.length || 0, error: match?.matchError || "" });
  }
  broadcast();
  return { ok: true, outcomes };
});

ipcMain.handle("tiktok:products:confirm", async (_e, { jobId, productId }) => {
  stateStore.updateTikTokState(s => {
    const j = s.jobs.find(item => item.id === jobId);
    if (j) {
      const catalog = s.showcaseCatalog?.[j.accountId]?.products || [];
      const product = catalog.find(p => String(p.id) === String(productId)) || j.productMatch?.candidates?.find(p => String(p.id) === String(productId));
      if (!product) throw new Error("Product ID không tồn tại trong Showcase đã đồng bộ.");
      j.productMatch = lockProduct(product, { source: "manual_visual_confirmation" });
      const asset = s.mediaAssets.find(a => a.id === j.productImageAssetId);
      if (asset?.fingerprint) {
        s.productMappings = s.productMappings.filter(m => !(m.accountId === j.accountId && m.imageFingerprint === asset.fingerprint));
        s.productMappings.push({ accountId: j.accountId, imageFingerprint: asset.fingerprint, productId: String(product.id), product, confirmedAt: new Date().toISOString() });
      }
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
