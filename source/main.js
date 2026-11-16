"use strict";

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const { MuseController } = require("./muse");

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
const recoveredResultsFile = path.join(dataDir, "recovered-results.json");
const legacyStateFile = path.join(app.getPath("userData"), "MuseAutomation", "data", "state.json");
fs.mkdirSync(downloadDir, { recursive: true });

const defaults = {
  config: { port: 19324, aspect: "9:16", duration: "8s", quality: "1K", concurrency: 20, delaySeconds: 5 },
  queue: [],
  logs: [],
  control: { running: false, paused: false, currentJobId: null }
};

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { ...defaults, ...parsed, config: { ...defaults.config, ...(parsed.config || {}) }, queue: Array.isArray(parsed.queue) ? parsed.queue : [] };
  } catch {
    try { if (fs.existsSync(stateFile) || !fs.existsSync(legacyStateFile)) throw new Error("No import"); const legacy = JSON.parse(fs.readFileSync(legacyStateFile, "utf8")); return { ...defaults, ...legacy, config: { ...defaults.config, ...(legacy.config || {}) }, queue: Array.isArray(legacy.queue) ? legacy.queue : [] }; }
    catch { return JSON.parse(JSON.stringify(defaults)); }
  }
}

const state = loadState();
try {
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
} catch {}
if (Number(state.config.port) >= 9222 && Number(state.config.port) <= 9235) state.config.port = 19324;
if (!state.config.parallelConfigured) { state.config.concurrency = 20; state.config.parallelConfigured = true; }
state.control = { running: false, paused: false, currentJobId: null };
for (const job of state.queue) {
  if (job.status === "running") { job.status = "pending"; job.progress = 0; job.detail = "Đã khôi phục sau khi mở lại — chờ Play"; }
}
function saveState() {
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(`${stateFile}.tmp`, stateFile);
}
function broadcast() { if (win && !win.isDestroyed()) win.webContents.send("state", state); }
function syncControl() { const ids = [...activeJobIds]; currentJobId = ids[0] || null; state.control = { running, paused, currentJobId, currentJobIds: ids }; saveState(); broadcast(); }
function log(message) {
  const line = `${new Date().toLocaleTimeString("vi-VN")}  ${message}`;
  state.logs.push(line);
  state.logs = state.logs.slice(-500);
  saveState();
  if (win && !win.isDestroyed()) win.webContents.send("log", line);
}

const muse = new MuseController({ dataDir, downloadDir, port: state.config.port, log });
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

function startQueue() { if (running) return { ok: false, error: "Hàng đợi đang chạy" }; if (!state.queue.some((job) => ["pending", "error"].includes(job.status))) return { ok: false, error: "Chưa có luồng Chờ chạy/Bị lỗi" }; void runQueue().catch((error) => log(`Engine dừng: ${error.message}`)); return { ok: true }; }

function createWindow() {
  const smoke = process.argv.includes("--smoke-test");
  win = new BrowserWindow({
    width: 1450, height: 900, minWidth: 1050, minHeight: 680,
    title: "Muse Automation",
    backgroundColor: "#fff5d7", show: !smoke,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, "index.html"));
  if (smoke) win.webContents.once("did-finish-load", async () => {
    try {
      const check = await win.webContents.executeJavaScript(`({title:document.title,hasPrompt:!!document.querySelector('#prompt'),hasProducts:!!document.querySelector('#chooseProducts'),hasRun:!!document.querySelector('#run'),hasQueue:!!document.querySelector('#queue')})`);
      console.log(JSON.stringify({ smoke: "ok", ...check }));
      app.exit(check.hasPrompt && check.hasProducts && check.hasRun && check.hasQueue ? 0 : 2);
    } catch (error) { console.error(error); app.exit(3); }
  });
}

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

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

