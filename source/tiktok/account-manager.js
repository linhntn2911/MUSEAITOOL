"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { logger } = require("../core/redacted-log");
const { createError, ERROR_CODES } = require("../core/errors");
const { StudioAdapter } = require("./studio-adapter");

const BASE_CDP_PORT = 19400;

function getNextPort(accounts, startPort = BASE_CDP_PORT) {
  const used = new Set(accounts.map(a => a.cdpPort));
  let port = startPort;
  while (used.has(port)) {
    port++;
  }
  return port;
}

function createAccountError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function findChromePath() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe"
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "chrome";
}

class AccountManager {
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.dataDir = options.dataDir || path.join(process.cwd(), "data");
    this.profilesDir = path.join(this.dataDir, "profiles");
    this.processes = new Map(); // accountId -> ChildProcess
    this.activeLocks = new Set(); // accountId -> active lock
  }

  ensureDirs() {
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true });
    }
  }

  async addAccount(label) {
    this.ensureDirs();
    const cleanLabel = (label || "").trim() || "Kênh mới";
    const accountId = `acc-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const profilePath = path.join(this.profilesDir, accountId);
    fs.mkdirSync(profilePath, { recursive: true });

    const currentAccounts = this.stateStore.getTikTokState().accounts;
    const port = getNextPort(currentAccounts, BASE_CDP_PORT);

    const account = {
      id: accountId,
      label: cleanLabel,
      handle: null,
      nickname: null,
      avatarUrl: null,
      status: "unknown",
      profilePath,
      cdpPort: port,
      paused: false,
      activeJobId: null,
      lastCheckedAt: null,
      lastError: null
    };

    this.stateStore.updateTikTokState(tt => {
      tt.accounts.push(account);
    });

    logger.info("account-manager", `Đã thêm tài khoản: ${cleanLabel} (Cổng ${port})`, { accountId });
    return account;
  }

  async isPortAlive(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1500)
      });
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data);
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async ensureChrome(account, showWindow = true, targetUrl = "https://www.tiktok.com/tiktokstudio?lang=vi-VN") {
    const alive = await this.isPortAlive(account.cdpPort);
    if (alive) {
      return this.processes.get(account.id) || null;
    }
    return await this.launchChrome(account, showWindow, targetUrl);
  }

  async launchChrome(account, showWindow = true, targetUrl = "https://www.tiktok.com/tiktokstudio?lang=vi-VN") {
    if (this.processes.has(account.id)) {
      const proc = this.processes.get(account.id);
      if (!proc.killed) {
        return proc;
      }
    }

    const chromePath = findChromePath();
    const args = [
      `--user-data-dir=${account.profilePath}`,
      `--remote-debugging-port=${account.cdpPort}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,800"
    ];

    if (!showWindow) {
      args.push("--headless=new");
    } else if (targetUrl) {
      args.push(targetUrl);
    }

    const proc = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore"
    });

    proc.unref();
    this.processes.set(account.id, proc);

    // Wait for CDP port to open
    await new Promise(r => setTimeout(r, 1500));
    return proc;
  }

  async showAccount(accountId, url = "https://www.tiktok.com/tiktokstudio?lang=vi-VN") {
    const ttState = this.stateStore.getTikTokState();
    const account = ttState.accounts.find(a => a.id === accountId);
    if (!account) throw createAccountError(ERROR_CODES.ACCOUNT_NOT_FOUND, "Không tìm thấy tài khoản.");
    return await this.ensureChrome(account, true, url);
  }

  async hideAccount(accountId) {
    if (this.processes.has(accountId)) {
      const proc = this.processes.get(accountId);
      try {
        proc.kill();
      } catch (_) {}
      this.processes.delete(accountId);
    }
    return { ok: true };
  }

  async checkAccount(accountId, adapter = null) {
    const ttState = this.stateStore.getTikTokState();
    const account = ttState.accounts.find(a => a.id === accountId);
    if (!account) {
      throw createError(ERROR_CODES.ACCOUNT_NOT_FOUND, "Không tìm thấy tài khoản.");
    }

    const studio = adapter || new StudioAdapter({ cdpPort: account.cdpPort });
    try {
      if (!adapter) {
        await this.ensureChrome(account, true);
        await studio.connect(account.cdpPort);
      }

      const checkFn = studio.checkAccountStatus ? studio.checkAccountStatus.bind(studio) : studio.checkAccount.bind(studio);
      const res = await checkFn();

      this.stateStore.updateTikTokState(s => {
        const acc = s.accounts.find(a => a.id === accountId);
        if (acc) {
          acc.status = res.status;
          acc.handle = res.handle || acc.handle;
          acc.nickname = res.nickname || acc.nickname;
          acc.lastCheckedAt = new Date().toISOString();

          // Session expiry rule (FR-007)
          if (res.status === "login_required" || res.status === "verification_required") {
            acc.paused = true;
            // Pause all pending/running jobs of this account
            for (const j of s.jobs) {
              if (j.accountId === accountId && ["draft", "ready", "waiting_content"].includes(j.status)) {
                j.status = "paused";
                j.progressText = "Tạm dừng do phiên kênh hết hạn";
              }
            }
          }
        }
      });

      return res;
    } finally {
      if (!adapter) {
        try { await studio.close(); } catch (_) {}
      }
    }
  }

  pauseAccount(accountId) {
    this.stateStore.updateTikTokState(s => {
      const acc = s.accounts.find(a => a.id === accountId);
      if (acc) {
        acc.paused = true;
        for (const j of s.jobs) {
          if (j.accountId === accountId && j.status !== "posted" && j.status !== "scheduled") {
            j.status = "paused";
          }
        }
      }
    });
    return { ok: true };
  }

  resumeAccount(accountId) {
    const ttState = this.stateStore.getTikTokState();
    const account = ttState.accounts.find(a => a.id === accountId);
    if (!account) throw createAccountError(ERROR_CODES.ACCOUNT_NOT_FOUND, "Không tìm thấy tài khoản.");

    if (account.status !== "live") {
      throw createAccountError(ERROR_CODES.LOGIN_REQUIRED, "LOGIN_REQUIRED: Kênh chưa ở trạng thái Sẵn sàng (Live). Hãy kiểm tra trước khi Resume.");
    }

    this.stateStore.updateTikTokState(s => {
      const acc = s.accounts.find(a => a.id === accountId);
      if (acc) {
        acc.paused = false;
        for (const j of s.jobs) {
          if (j.accountId === accountId && j.status === "paused") {
            j.status = "ready";
          }
        }
      }
    });
    return { ok: true };
  }

  async removeAccount(accountId, removeProfile = false) {
    const ttState = this.stateStore.getTikTokState();
    if (this.activeLocks.has(accountId)) {
      throw createError(ERROR_CODES.ACCOUNT_BUSY, "Không thể xóa tài khoản đang xử lý công việc.");
    }

    let profileToDelete = null;
    this.stateStore.updateTikTokState(s => {
      const idx = s.accounts.findIndex(a => a.id === accountId);
      if (idx !== -1) {
        profileToDelete = s.accounts[idx].profilePath;
        s.accounts.splice(idx, 1);
      }
    });

    if (removeProfile && profileToDelete && fs.existsSync(profileToDelete)) {
      try {
        fs.rmSync(profileToDelete, { recursive: true, force: true });
      } catch (err) {
        logger.warn("account-manager", `Không thể xóa thư mục profile: ${err.message}`);
      }
    }

    return { ok: true };
  }
}

module.exports = {
  AccountManager
};
