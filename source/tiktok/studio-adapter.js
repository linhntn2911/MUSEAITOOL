"use strict";

const http = require("node:http");
const WebSocketClient = globalThis.WebSocket;
const { logger } = require("../core/redacted-log");
const { createError, ERROR_CODES } = require("../core/errors");

const TIKTOK_STUDIO_URL = "https://www.tiktok.com/tiktokstudio/upload";

const SELECTORS = {
  FILE_INPUT: 'input[type="file"][accept*="video"], input[type="file"]',
  CAPTION_BOX: 'div[contenteditable="true"], .notranslate[contenteditable="true"], textarea',
  SCHEDULE_RADIO: 'input[type="radio"][value="schedule"], .schedule-radio',
  IMMEDIATE_RADIO: 'input[type="radio"][value="post"], .post-radio',
  DATE_PICKER: 'input[placeholder*="YYYY"], .date-picker-input',
  TIME_PICKER: 'input[placeholder*="HH"], .time-picker-input',
  SUBMIT_BUTTON: 'button.btn-post, button[data-e2e="post_video_button"], button:has-text("Đăng"), button:has-text("Lên lịch")',
  CAPTCHA_CONTAINER: '#secsdk-captcha-drag-wrapper, .captcha-verify-container, [id*="captcha"]',
  SUCCESS_TOAST: '.tiktok-toast, .success-modal, div:has-text("Đã đăng"), div:has-text("Đã lên lịch")'
};

class StudioAdapter {
  constructor(options = {}) {
    this.cdpPort = options.cdpPort;
    this.wsUrl = null;
    this.ws = null;
    this.msgId = 1;
    this.pendingCallbacks = new Map();
  }

  async fetchWsUrl(port) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let raw = "";
        res.on("data", chunk => { raw += chunk; });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            resolve(data.webSocketDebuggerUrl);
          } catch (e) {
            reject(new Error(`Lỗi parse version CDP: ${e.message}`));
          }
        });
      });
      req.on("error", (err) => reject(new Error(`Không thể kết nối cổng CDP ${port}: ${err.message}`)));
      req.setTimeout(4000, () => {
        req.destroy();
        reject(new Error(`Timeout kết nối cổng CDP ${port}`));
      });
    });
  }

  async connect(port) {
    this.cdpPort = port || this.cdpPort;
    const wsUrl = await this.fetchWsUrl(this.cdpPort);
    this.wsUrl = wsUrl;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocketClient(this.wsUrl);
      this.ws.onopen = async () => {
        try {
          await this.send("Runtime.enable");
          await this.send("Page.enable");
          await this.send("DOM.enable");
          resolve({ ok: true });
        } catch (err) {
          reject(err);
        }
      };
      this.ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.id && this.pendingCallbacks.has(parsed.id)) {
            const { resolve, reject } = this.pendingCallbacks.get(parsed.id);
            this.pendingCallbacks.delete(parsed.id);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed.result);
          }
        } catch (_) {}
      };
      this.ws.onerror = (err) => reject(err);
    });
  }

  async send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error("CDP WebSocket chưa sẵn sàng.");
    }
    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return res.result?.value;
  }

  async checkAccountStatus() {
    // Check if on login page or captcha
    const info = await this.evaluate(`(() => {
      const url = window.location.href;
      const isLogin = url.includes('/login') || !!document.querySelector('input[name="password"]');
      const hasCaptcha = !!document.querySelector('${SELECTORS.CAPTCHA_CONTAINER}');
      const handleEl = document.querySelector('[data-e2e="user-avatar"], [class*="avatar"], .user-info');
      const handleText = handleEl ? handleEl.innerText : null;
      return { url, isLogin, hasCaptcha, handleText };
    })()`);

    if (info?.hasCaptcha) {
      return { status: "verification_required", code: ERROR_CODES.CAPTCHA_DETECTED };
    }
    if (info?.isLogin) {
      return { status: "login_required", code: ERROR_CODES.LOGIN_REQUIRED };
    }

    return {
      status: "live",
      handle: info?.handleText || "@tiktok_user",
      nickname: info?.handleText || "TikTok Creator"
    };
  }

  async openStudioUpload() {
    await this.send("Page.navigate", { url: TIKTOK_STUDIO_URL });
    await new Promise(r => setTimeout(r, 2000));
  }

  async verifySubmitActionSafety(requestedMode) {
    const buttonInfo = await this.evaluate(`(() => {
      const btn = document.querySelector('${SELECTORS.SUBMIT_BUTTON}');
      if (!btn) return { exists: false };
      const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      return { exists: true, text };
    })()`);

    if (!buttonInfo.exists) {
      throw createError(ERROR_CODES.STUDIO_SELECTOR_MISMATCH, "Không tìm thấy nút Đăng/Lên lịch trên TikTok Studio");
    }

    // Safety rule FR-013: if requested native_schedule but button says only "đăng" and not "lịch"
    if (requestedMode === "native_schedule" && buttonInfo.text.includes("đăng") && !buttonInfo.text.includes("lịch")) {
      throw createError(
        ERROR_CODES.SCHEDULE_NOT_PERMITTED_ON_UI,
        "Giao diện hiển thị nút Đăng ngay thay vì Lên lịch. Dừng an toàn để chống đăng nhầm."
      );
    }

    return { ok: true, buttonText: buttonInfo.text };
  }

  async close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }
}

module.exports = {
  SELECTORS,
  StudioAdapter
};
