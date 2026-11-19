"use strict";

const VALID_ACCOUNT_MODES = ["affiliate", "no_cart"];
const VALID_SCHEDULE_MODES = ["immediate", "native_schedule"];
const VALID_ACCOUNT_STATUSES = [
  "unknown", "opening", "checking", "live", "login_required", "verification_required", "busy", "paused"
];
const VALID_SOURCE_KINDS = ["muse_result", "external_file"];

function normalizeHashtag(tag) {
  if (typeof tag !== "string") return "";
  let clean = tag.trim();
  if (!clean.startsWith("#")) {
    clean = "#" + clean;
  }
  return clean;
}

function deduplicateHashtags(tags) {
  if (!Array.isArray(tags)) return [];
  const set = new Set();
  const result = [];
  for (const t of tags) {
    const norm = normalizeHashtag(t);
    if (norm.length > 1 && !set.has(norm.toLowerCase())) {
      set.add(norm.toLowerCase());
      result.push(norm);
    }
  }
  return result;
}

function createDefaultSettings() {
  return {
    autoPushCompleted: true,
    autoGenerateContent: true,
    accountMode: "affiliate",
    defaultTone: "review",
    defaultHashtags: ["#fyp", "#xuhuong", "#review"],
    scheduleMode: "immediate",
    firstDelayMinutes: 0,
    intervalMinutes: 60,
    defaultAudio: {
      enabled: true,
      originalVolume: 100,
      addRecommendedMusic: true,
      musicVolume: 85,
      loop: true,
      fadeInSeconds: 0,
      fadeOutSeconds: 0.5
    },
    geminiModel: "gemini-3.5-flash-lite",
    showTikTokWindows: false
  };
}

function validateSettings(settings = {}) {
  const defaults = createDefaultSettings();
  const result = Object.assign({}, defaults, settings);

  result.autoPushCompleted = Boolean(result.autoPushCompleted);
  result.autoGenerateContent = Boolean(result.autoGenerateContent);

  if (!VALID_ACCOUNT_MODES.includes(result.accountMode)) {
    result.accountMode = defaults.accountMode;
  }

  if (typeof result.defaultTone !== "string" || !result.defaultTone.trim()) {
    result.defaultTone = defaults.defaultTone;
  }

  result.defaultHashtags = deduplicateHashtags(result.defaultHashtags);

  if (!VALID_SCHEDULE_MODES.includes(result.scheduleMode)) {
    result.scheduleMode = defaults.scheduleMode;
  }

  result.firstDelayMinutes = Math.max(0, parseInt(result.firstDelayMinutes, 10) || 0);
  result.intervalMinutes = Math.max(1, parseInt(result.intervalMinutes, 10) || 60);

  result.defaultAudio = Object.assign({}, defaults.defaultAudio, result.defaultAudio || {});
  result.defaultAudio.originalVolume = Math.min(100, Math.max(0, parseInt(result.defaultAudio.originalVolume, 10) || 0));
  result.defaultAudio.musicVolume = Math.min(100, Math.max(0, parseInt(result.defaultAudio.musicVolume, 10) || 85));
  result.defaultAudio.loop = Boolean(result.defaultAudio.loop);
  result.defaultAudio.fadeInSeconds = Math.max(0, Number(result.defaultAudio.fadeInSeconds) || 0);
  result.defaultAudio.fadeOutSeconds = Math.max(0, Number(result.defaultAudio.fadeOutSeconds) || 0.5);

  result.geminiModel = (typeof result.geminiModel === "string" && result.geminiModel.trim())
    ? result.geminiModel.trim()
    : defaults.geminiModel;

  result.showTikTokWindows = Boolean(result.showTikTokWindows);

  return result;
}

function validateAccount(account) {
  if (!account || typeof account !== "object") {
    throw new Error("Tài khoản TikTok không hợp lệ.");
  }
  if (!account.id || typeof account.id !== "string") {
    throw new Error("Tài khoản thiếu ID định danh hợp lệ.");
  }
  if (!account.label || typeof account.label !== "string") {
    throw new Error("Tài khoản phải có tên nhãn gợi nhớ (label).");
  }
  if (!account.profilePath || typeof account.profilePath !== "string") {
    throw new Error("Tài khoản thiếu đường dẫn profilePath riêng.");
  }
  const port = parseInt(account.cdpPort, 10);
  if (!port || port < 1024 || port > 65535) {
    throw new Error(`Cổng CDP không hợp lệ: ${account.cdpPort}`);
  }

  const status = VALID_ACCOUNT_STATUSES.includes(account.status) ? account.status : "unknown";

  return {
    id: account.id,
    label: account.label.trim(),
    handle: account.handle || null,
    nickname: account.nickname || null,
    avatarUrl: account.avatarUrl || null,
    status,
    profilePath: account.profilePath,
    cdpPort: port,
    paused: Boolean(account.paused),
    activeJobId: account.activeJobId || null,
    lastCheckedAt: account.lastCheckedAt || null,
    lastError: account.lastError || null
  };
}

function validateAccountsList(accounts) {
  if (!Array.isArray(accounts)) return [];
  const ids = new Set();
  const ports = new Set();
  const profiles = new Set();
  const validated = [];

  for (const acc of accounts) {
    const validAcc = validateAccount(acc);
    if (ids.has(validAcc.id)) {
      throw new Error(`Trùng lặp ID tài khoản: ${validAcc.id}`);
    }
    if (ports.has(validAcc.cdpPort)) {
      throw new Error(`Trùng lặp cổng CDP ${validAcc.cdpPort} giữa các tài khoản.`);
    }
    if (profiles.has(validAcc.profilePath.toLowerCase())) {
      throw new Error(`Trùng lặp đường dẫn profilePath: ${validAcc.profilePath}`);
    }

    ids.add(validAcc.id);
    ports.add(validAcc.cdpPort);
    profiles.add(validAcc.profilePath.toLowerCase());
    validated.push(validAcc);
  }

  return validated;
}

function validateContent(content = {}) {
  const title = (content.title || "").substring(0, 150);
  const caption = (content.caption || "").substring(0, 2200);
  const cartTitle = (content.cartTitle || "").substring(0, 30);
  const hashtags = deduplicateHashtags(content.hashtags || []).slice(0, 30);
  const tone = content.tone || "review";
  const versionHistory = Array.isArray(content.versionHistory) ? content.versionHistory : [];
  const productKeywords = Array.isArray(content.productKeywords)
    ? content.productKeywords.map(v => String(v).trim()).filter(Boolean).slice(0, 5)
    : [];

  return {
    title,
    caption,
    hashtags,
    cartTitle,
    tone,
    productKeywords,
    versionHistory,
    generatedAt: content.generatedAt || null,
    generationStatus: content.generationStatus || "idle",
    generationError: content.generationError || null
  };
}

function validateJob(job) {
  if (!job || typeof job !== "object") {
    throw new Error("Job không hợp lệ.");
  }
  if (!job.id || typeof job.id !== "string") {
    throw new Error("Job thiếu ID định danh hợp lệ.");
  }
  if (!job.sourceFingerprint || typeof job.sourceFingerprint !== "string") {
    throw new Error("Job thiếu sourceFingerprint.");
  }
  if (!job.sourceVideoAssetId || typeof job.sourceVideoAssetId !== "string") {
    throw new Error("Job thiếu sourceVideoAssetId trỏ tới video gốc.");
  }

  const sourceKind = VALID_SOURCE_KINDS.includes(job.sourceKind) ? job.sourceKind : "external_file";
  const accountMode = VALID_ACCOUNT_MODES.includes(job.accountMode) ? job.accountMode : "affiliate";

  return {
    id: job.id,
    sourceKind,
    sourceFingerprint: job.sourceFingerprint,
    sourceVideoAssetId: job.sourceVideoAssetId,
    uploadVideoAssetId: job.uploadVideoAssetId || null,
    productImageAssetId: job.productImageAssetId || null,
    sourcePrompt: job.sourcePrompt || "",
    accountId: job.accountId || null,
    content: validateContent(job.content),
    accountMode,
    productMatch: job.productMatch || null,
    audio: Object.assign({}, createDefaultSettings().defaultAudio, job.audio || {}),
    schedule: {
      mode: VALID_SCHEDULE_MODES.includes(job.schedule?.mode) ? job.schedule.mode : "immediate",
      targetTime: job.schedule?.targetTime || null,
      effectiveTime: job.schedule?.effectiveTime || null
    },
    status: job.status || "draft",
    progress: Math.min(100, Math.max(0, parseInt(job.progress, 10) || 0)),
    progressText: job.progressText || "Khởi tạo",
    evidence: Array.isArray(job.evidence) ? job.evidence : [],
    checkpoint: job.checkpoint || { step: "draft", timestamp: new Date().toISOString() },
    error: job.error || null,
    createdAt: job.createdAt || new Date().toISOString(),
    updatedAt: job.updatedAt || new Date().toISOString()
  };
}

module.exports = {
  VALID_ACCOUNT_MODES,
  VALID_SCHEDULE_MODES,
  VALID_ACCOUNT_STATUSES,
  VALID_SOURCE_KINDS,
  normalizeHashtag,
  deduplicateHashtags,
  createDefaultSettings,
  validateSettings,
  validateAccount,
  validateAccountsList,
  validateContent,
  validateJob
};
