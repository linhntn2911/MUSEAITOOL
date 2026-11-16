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

