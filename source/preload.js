"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("museApp", {
  openMuse: () => ipcRenderer.invoke("muse:open"),
  status: () => ipcRenderer.invoke("muse:status"),
  showChrome: () => ipcRenderer.invoke("muse:show"),
  hideChrome: () => ipcRenderer.invoke("muse:hide"),
  getState: () => ipcRenderer.invoke("state:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  chooseProductImages: () => ipcRenderer.invoke("files:products"),
  chooseCharacterImage: () => ipcRenderer.invoke("files:character"),
  previewFiles: (paths) => ipcRenderer.invoke("files:preview", paths),
  addJobs: (jobs) => ipcRenderer.invoke("queue:add", jobs),
  removeJobs: (ids) => ipcRenderer.invoke("queue:remove", ids),
  retryJobs: (ids) => ipcRenderer.invoke("queue:retry", ids),
  runQueue: () => ipcRenderer.invoke("queue:run"),
  pauseQueue: () => ipcRenderer.invoke("queue:pause"),
  resumeQueue: () => ipcRenderer.invoke("queue:resume"),
  stopQueue: () => ipcRenderer.invoke("queue:stop"),
  runOne: (id) => ipcRenderer.invoke("queue:run-one", id),
  scanMedia: () => ipcRenderer.invoke("media:scan"),
  openDownloads: () => ipcRenderer.invoke("media:open"),
  showResult: (filePath) => ipcRenderer.invoke("media:show", filePath),
  onState: (fn) => ipcRenderer.on("state", (_event, state) => fn(state)),
  onLog: (fn) => ipcRenderer.on("log", (_event, line) => fn(line))
});

contextBridge.exposeInMainWorld("tiktokApp", {
  // Accounts
  listAccounts: () => ipcRenderer.invoke("tiktok:accounts:list"),
  addAccount: (label) => ipcRenderer.invoke("tiktok:accounts:add", { label }),
  checkAccount: (accountId) => ipcRenderer.invoke("tiktok:accounts:check", { accountId }),
  showAccount: (accountId) => ipcRenderer.invoke("tiktok:accounts:show", { accountId }),
  hideAccount: (accountId) => ipcRenderer.invoke("tiktok:accounts:hide", { accountId }),
  pauseAccount: (accountId) => ipcRenderer.invoke("tiktok:accounts:pause", { accountId }),
  resumeAccount: (accountId) => ipcRenderer.invoke("tiktok:accounts:resume", { accountId }),
  removeAccount: (accountId, removeProfile) => ipcRenderer.invoke("tiktok:accounts:remove", { accountId, removeProfile }),

  // Queue
  getState: () => ipcRenderer.invoke("tiktok:state:get"),
  addFiles: () => ipcRenderer.invoke("tiktok:jobs:add-files"),
  addMuseResults: (museJobIds) => ipcRenderer.invoke("tiktok:jobs:add-muse-results", { museJobIds }),
  updateJob: (jobId, patch, expectedUpdatedAt) => ipcRenderer.invoke("tiktok:jobs:update", { jobId, patch, expectedUpdatedAt }),
  removeJobs: (jobIds, deleteProcessed) => ipcRenderer.invoke("tiktok:jobs:remove", { jobIds, deleteProcessed }),
  runJobs: (jobIds) => ipcRenderer.invoke("tiktok:jobs:run", { jobIds }),
  pauseJobs: (jobIds) => ipcRenderer.invoke("tiktok:jobs:pause", { jobIds }),
  resumeJobs: (jobIds) => ipcRenderer.invoke("tiktok:jobs:resume", { jobIds }),
  stopJobs: (jobIds) => ipcRenderer.invoke("tiktok:jobs:stop", { jobIds }),
  retryJobs: (jobIds) => ipcRenderer.invoke("tiktok:jobs:retry", { jobIds }),
  reconcileJob: (jobId, decision) => ipcRenderer.invoke("tiktok:jobs:reconcile", { jobId, decision }),
  recalculateSchedule: (jobIds) => ipcRenderer.invoke("tiktok:jobs:recalculate-schedule", { jobIds }),

  // Content & Products
  testApiKey: (apiKey) => ipcRenderer.invoke("tiktok:content:test-key", { apiKey }),
  saveApiKey: (apiKey) => ipcRenderer.invoke("tiktok:content:save-key", { apiKey }),
  generateContent: (jobIds, options) => ipcRenderer.invoke("tiktok:content:generate", { jobIds, options }),
  restoreContent: (jobIds) => ipcRenderer.invoke("tiktok:content:restore", { jobIds }),
  verifyProduct: (jobIds) => ipcRenderer.invoke("tiktok:products:verify", { jobIds }),
  confirmProduct: (jobId, productId) => ipcRenderer.invoke("tiktok:products:confirm", { jobId, productId }),

  // Audio & Media
  chooseAudioSource: () => ipcRenderer.invoke("tiktok:audio:choose-source"),
  previewAudio: (jobId, config) => ipcRenderer.invoke("tiktok:audio:preview", { jobId, config }),
  processAudio: (jobIds) => ipcRenderer.invoke("tiktok:audio:process", { jobIds }),
  pinAudio: (mediaAssetId, pinned) => ipcRenderer.invoke("tiktok:audio:pin", { mediaAssetId, pinned }),
  cleanupMedia: (dryRun) => ipcRenderer.invoke("tiktok:media:cleanup", { dryRun }),

  // Events
  onTikTokState: (fn) => ipcRenderer.on("tiktok:state", (_event, state) => fn(state)),
  onTikTokLog: (fn) => ipcRenderer.on("tiktok:log", (_event, log) => fn(log)),
  onAttention: (fn) => ipcRenderer.on("tiktok:attention", (_event, data) => fn(data))
});
