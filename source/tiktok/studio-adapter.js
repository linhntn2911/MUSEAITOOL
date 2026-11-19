"use strict";

const path = require("node:path");
const http = require("node:http");
const WebSocketClient = globalThis.WebSocket;
const { logger } = require("../core/redacted-log");
const { createError, ERROR_CODES } = require("../core/errors");

const TIKTOK_STUDIO_URL = "https://www.tiktok.com/tiktokstudio/upload?lang=vi-VN";
const TIKTOK_HOME_URL = "https://www.tiktok.com/tiktokstudio?lang=vi-VN";

const SELECTORS = {
  FILE_INPUT: 'input[type="file"][accept*="video"], input[type="file"]',
  CAPTION_BOX: 'div.public-DraftEditor-content[contenteditable="true"], [data-e2e*="caption"] [contenteditable="true"], div[contenteditable="true"], .notranslate[contenteditable="true"]',
  SUBMIT_BUTTON: 'button[data-e2e="post_video_button"], button.btn-post',
  CAPTCHA_CONTAINER: '#captcha-verify-container-main-page, .captcha-verify-container, iframe[src*="captcha"], [id*="secsdk-captcha"]'
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const TIKTOK_RISKY_PHRASES = [
  /\b(?:cam\s*kết|đảm\s*bảo)\s*(?:100\s*%|tuyệt\s*đối)\b/giu,
  /\b(?:chữa|điều\s*trị|đặc\s*trị)\s+(?:bệnh|mụn|nám|sẹo|hôi|đau)\b/giu,
  /\b(?:tốt\s*nhất|số\s*1|duy\s*nhất|vĩnh\s*viễn|không\s*tác\s*dụng\s*phụ)\b/giu,
  /\b(?:zalo|telegram|whatsapp)\s*[:：]?\s*[\w.+-]+/giu,
  /https?:\/\/\S+|www\.\S+/giu,
  /(?:\+?84|0)\d{8,10}/g
];

function sanitizeTikTokText(value, maxLength = 2200) {
  let text = String(value || "").normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .replace(/\[(?:mở\s*bán|hot|sale|new|hàng\s*mới)\]/giu, " ")
    .replace(/[<>\[\]{}|\\^~`]/g, " ");
  for (const pattern of TIKTOK_RISKY_PHRASES) text = text.replace(pattern, " ");
  text = text
    .replace(/([!?.,])\1{2,}/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, maxLength).trim();
}

class StudioAdapter {
  constructor(options = {}) {
    this.cdpPort = options.cdpPort;
    this.wsUrl = null;
    this.ws = null;
    this.msgId = 1;
    this.pendingCallbacks = new Map();
  }

  async fetchWsUrl(port, targetUrl = TIKTOK_STUDIO_URL) {
    // 1. First attempt: query /json/list for existing page
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const targets = await res.json();
        if (Array.isArray(targets)) {
          let target = targets.find(t => t.type === "page" && (t.url || "").includes("tiktok.com"));
          if (!target) target = targets.find(t => t.type === "page");
          if (target && target.webSocketDebuggerUrl) {
            return target.webSocketDebuggerUrl;
          }
        }
      }
    } catch (_) {}

    // 2. If no page target found, create a new tab via /json/new
    for (const method of ["PUT", "GET"]) {
      try {
        const newUrl = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl || TIKTOK_STUDIO_URL)}`;
        const res = await fetch(newUrl, {
          method,
          signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
          const target = await res.json();
          if (target && target.webSocketDebuggerUrl) {
            return target.webSocketDebuggerUrl;
          }
        }
      } catch (_) {}
    }

    // 3. Fallback to /json/version
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

  async connect(port, targetUrl = TIKTOK_STUDIO_URL) {
    this.cdpPort = port || this.cdpPort;
    const wsUrl = await this.fetchWsUrl(this.cdpPort, targetUrl);
    this.wsUrl = wsUrl;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocketClient(this.wsUrl);
      this.ws.onopen = async () => {
        try {
          await this.send("Page.enable").catch(() => {});
          await this.send("DOM.enable").catch(() => {});
          await this.send("Runtime.enable").catch(() => {});
          await this.send("Network.enable").catch(() => {});

          // Auto-accept JS dialogs
          this.ws.addEventListener("message", (event) => {
            try {
              const data = JSON.parse(event.data);
              if (data.method === "Page.javascriptDialogOpening") {
                this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
              }
            } catch (_) {}
          });

          // Check if navigate needed
          if (targetUrl) {
            const currentHref = await this.evaluate("location.href || ''").catch(() => "");
            const isTikTok = /https:\/\/([^/]*\.)?tiktok\.com/i.test(currentHref);
            const isUpload = /\/tiktokstudio\/upload/i.test(currentHref);
            if (!isTikTok || (!isUpload && /\/tiktokstudio\/upload/i.test(targetUrl))) {
              await this.evaluate(`(() => {
                try {
                  window.onbeforeunload = null;
                  window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation(); }, true);
                } catch (_) {}
              })()`).catch(() => {});
              await this.send("Page.navigate", { url: targetUrl }).catch(async () => {
                await this.evaluate(`location.href = ${JSON.stringify(targetUrl)}`).catch(() => {});
              });
              await sleep(2000);
            }
          }

          resolve({ ok: true, port: this.cdpPort });
        } catch (err) {
          reject(err);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.id && this.pendingCallbacks.has(parsed.id)) {
            const { resolve: res, reject: rej } = this.pendingCallbacks.get(parsed.id);
            this.pendingCallbacks.delete(parsed.id);
            if (parsed.error) rej(new Error(parsed.error.message));
            else res(parsed.result);
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

  async physicalClick(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    return true;
  }

  async detectBlockingGate() {
    return await this.evaluate(`(() => {
      const url = location.href || '';
      const txt = (document.body?.innerText || '').slice(0, 3000);
      if (/\\/login/i.test(url)) {
        return { blocked: true, type: 'login', reason: 'TikTok yêu cầu đăng nhập lại tài khoản.' };
      }
      const hasCaptcha = Boolean(
        document.querySelector('${SELECTORS.CAPTCHA_CONTAINER}') ||
        /xác minh|verify you are human|drag the slider|kéo thanh trượt|chọn 2 hình giống nhau/i.test(txt)
      );
      if (hasCaptcha) {
        return {
          blocked: true,
          type: 'captcha',
          reason: 'TikTok yêu cầu xác minh thủ công (CAPTCHA) — vui lòng thao tác trực tiếp trong cửa sổ Chrome vừa hiện lên rồi bấm Đăng lại.'
        };
      }
      return { blocked: false };
    })()`).catch(() => ({ blocked: false }));
  }

  async checkAccount() {
    const gate = await this.detectBlockingGate();
    if (gate && gate.blocked) {
      if (gate.type === "captcha") {
        return { status: "verification_required", code: ERROR_CODES.CAPTCHA_DETECTED, reason: gate.reason };
      }
      return { status: "login_required", code: ERROR_CODES.LOGIN_REQUIRED, reason: gate.reason };
    }

    // Check cookies via CDP Network domain
    let hasSession = false;
    try {
      const cookiesRes = await this.send("Network.getCookies", {
        urls: ["https://www.tiktok.com", "https://tiktok.com"]
      }).catch(() => null);

      const storageCookies = await this.send("Storage.getCookies").catch(() => null);
      const cookies = [
        ...(Array.isArray(cookiesRes?.cookies) ? cookiesRes.cookies : []),
        ...(Array.isArray(storageCookies?.cookies) ? storageCookies.cookies : [])
      ];
      hasSession = cookies.some(c =>
        ["sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt", "uid_tt_ss", "passport_auth_status"].includes(c.name) &&
        String(c.value || "").trim().length > 0
      );
    } catch (_) {}

    // Extract profile info from page context
    let profile = await this.evaluate(`(() => {
      const out = { handle: '', nickname: '', avatar: '', hasLoginModal: false, hasStudioUi: false };
      try {
        if (/\\/login/i.test(location.href) || document.querySelector('[data-e2e*="login"], [class*="login-modal"]')) {
          out.hasLoginModal = true;
        }

        // Try universal data script
        const uniEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (uniEl && uniEl.textContent) {
          try {
            const data = JSON.parse(uniEl.textContent);
            const user = data?.['__DEFAULT_SCOPE__']?.['webapp.app-context']?.user;
            if (user) {
              if (user.uniqueId) out.handle = '@' + String(user.uniqueId).replace(/^@+/, '');
              if (user.nickName) out.nickname = String(user.nickName).trim();
              if (user.avatarUri && user.avatarUri[0]) out.avatar = String(user.avatarUri[0]);
            }
          } catch (_) {}
        }

        // Try DOM elements
        if (!out.handle) {
          const links = Array.from(document.querySelectorAll('a[href*="/@"]'));
          for (const a of links) {
            const m = (a.getAttribute('href') || '').match(/\\/@([a-zA-Z0-9_.-]+)/);
            if (m && m[1]) {
              out.handle = '@' + m[1];
              break;
            }
          }
        }

        if (!out.nickname) {
          const nameEl = document.querySelector('[data-e2e="user-avatar"], .user-info, [class*="avatar"]');
          if (nameEl) out.nickname = (nameEl.innerText || '').trim();
        }

        const text = (document.body?.innerText || '').slice(0, 5000);
        out.hasStudioUi = /\/tiktokstudio/i.test(location.pathname || '') && Boolean(
          document.querySelector('input[type="file"], [data-e2e*="upload" i], [class*="upload" i]') ||
          /select video to upload|chọn video|upload video|tải video/i.test(text)
        );

        return out;
      } catch (_) {
        return out;
      }
    })()`).catch(() => null);

    // TikTok Studio often replaces the execution context while loading. CDP
    // can therefore resolve the expression with undefined instead of throwing.
    // Retry once after the navigation settles and always normalize the shape.
    if (!profile || typeof profile !== "object") {
      await sleep(1200);
      profile = await this.evaluate(`(() => ({
        handle: '',
        nickname: '',
        avatar: '',
        hasLoginModal: /\\/login/i.test(location.href || '') || !!document.querySelector('[data-e2e*="login"], [class*="login-modal"]'),
        hasStudioUi: /\\/tiktokstudio/i.test(location.pathname || '') && !!(document.querySelector('input[type="file"], [data-e2e*="upload" i], [class*="upload" i]') || /select video to upload|chọn video|upload video|tải video/i.test((document.body?.innerText || '').slice(0, 5000)))
      }))()`).catch(() => null);
    }
    profile = profile && typeof profile === "object"
      ? { handle: "", nickname: "", avatar: "", hasLoginModal: false, hasStudioUi: false, ...profile }
      : { handle: "", nickname: "", avatar: "", hasLoginModal: false, hasStudioUi: false };

    const isLive = (hasSession || Boolean(profile.handle || profile.nickname || profile.hasStudioUi)) && !profile.hasLoginModal;
    if (!isLive) {
      return { status: "login_required", code: ERROR_CODES.LOGIN_REQUIRED, handle: null, nickname: null };
    }

    return {
      status: "live",
      handle: profile.handle || "@tiktok_user",
      nickname: profile.nickname || profile.handle || "TikTok Creator",
      avatar: profile.avatar || ""
    };
  }

  async dismissStudioOverlays() {
    await this.evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of btns) {
        const txt = (b.innerText || '').trim();
        const inTutorial = Boolean(b.closest('.react-joyride__tooltip, [class*="tutorial" i], [class*="Tooltip" i], [role="dialog"], .TUXModal'));
        if (/^(đã\\s*hiểu|got\\s*it)$/i.test(txt)) {
          b.click();
        } else if (inTutorial && /^(cho\\s*phép|allow)$/i.test(txt)) {
          b.click();
        }
      }
    })()`).catch(() => {});
  }

  async ensureCleanUploadDropzone() {
    await this.dismissStudioOverlays();
    const state = await this.evaluate(`(() => {
      const fileInp = document.querySelector('input[type="file"][accept*="video"], input[type="file"]');
      const discardBtn = document.querySelector('button[data-e2e="discard_post_button"]') ||
        Array.from(document.querySelectorAll('button')).find(b => /^(hủy\\s*bỏ|discard)$/i.test((b.innerText || '').trim()));
      const replaceBtn = Array.from(document.querySelectorAll('button')).find(b => /^(thay\\s*thế|replace)$/i.test((b.innerText || '').trim()));
      return {
        hasFileInput: Boolean(fileInp),
        hasDiscard: Boolean(discardBtn),
        hasReplace: Boolean(replaceBtn)
      };
    })()`).catch(() => ({}));

    if (!state.hasFileInput && (state.hasDiscard || state.hasReplace)) {
      logger.info("studio-adapter", "Phát hiện bản nháp cũ, tự động bấm Hủy bỏ...");
      await this.evaluate(`(() => {
        const discardBtn = document.querySelector('button[data-e2e="discard_post_button"]') ||
          Array.from(document.querySelectorAll('button')).find(b => /^(hủy\\s*bỏ|discard)$/i.test((b.innerText || '').trim()));
        if (discardBtn) {
          discardBtn.scrollIntoView({ block: 'center' });
          discardBtn.click();
        }
      })()`).catch(() => {});

      await sleep(1000);

      await this.evaluate(`(() => {
        const modals = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]'));
        for (const m of modals) {
          const ok = Array.from(m.querySelectorAll('button')).find(b => /^(hủy\\s*bỏ|discard|xác\\s*nhận|confirm)$/i.test((b.innerText || '').trim()));
          if (ok) ok.click();
        }
      })()`).catch(() => {});

      await sleep(1500);
    }

    const hasInput = await this.evaluate(`Boolean(document.querySelector('input[type="file"][accept*="video"], input[type="file"]'))`).catch(() => false);
    if (!hasInput) {
      await this.evaluate(`(() => {
        window.onbeforeunload = null;
        location.href = ${JSON.stringify(TIKTOK_STUDIO_URL)};
      })()`).catch(() => {});
      await sleep(3000);
      await this.dismissStudioOverlays();
    }
  }

  async uploadVideo(filePath) {
    await this.ensureCleanUploadDropzone();

    let fileInputNodeId = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      const doc = await this.send("DOM.getDocument", { depth: -1, pierce: true }).catch(() => null);
      if (doc && doc.root) {
        const queryRes = await this.send("DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector: 'input[type="file"][accept*="video"], input[type="file"]'
        }).catch(() => ({ nodeId: 0 }));

        if (queryRes && queryRes.nodeId) {
          fileInputNodeId = queryRes.nodeId;
          break;
        }
      }
      await sleep(1000);
    }

    if (!fileInputNodeId) {
      throw createError(ERROR_CODES.UNKNOWN_ERROR, "Không tìm thấy ô chọn file video trên TikTok Studio.");
    }

    await this.send("DOM.setFileInputFiles", {
      nodeId: fileInputNodeId,
      files: [path.resolve(filePath)]
    });

    // Wait for editor to appear and upload/processing to complete
    const timeout = Date.now() + 180000; // 3 minutes timeout
    let editorReady = false;

    while (Date.now() < timeout) {
      const status = await this.evaluate(`(() => {
        const editor = document.querySelector('div.public-DraftEditor-content[contenteditable="true"], [data-e2e*="caption"] [contenteditable="true"], [contenteditable="true"]');
        const postBtn = document.querySelector('button[data-e2e="post_video_button"]') ||
          Array.from(document.querySelectorAll('button')).find(b => /^(đăng|post|lên\\s*lịch|schedule)$/i.test((b.innerText || '').trim()));
        const txt = (document.body?.innerText || '');
        const pctMatch = txt.match(/(\\d{1,3})\\s*%/);
        return {
          hasEditor: Boolean(editor),
          hasPostBtn: Boolean(postBtn),
          postEnabled: Boolean(postBtn && !postBtn.disabled && postBtn.getAttribute('aria-disabled') !== 'true'),
          pct: pctMatch ? Number(pctMatch[1]) : 0
        };
      })()`);

      if (status && status.hasEditor && status.hasPostBtn) {
        editorReady = true;
        if (status.postEnabled) {
          break;
        }
      }

      const gate = await this.detectBlockingGate();
      if (gate && gate.blocked) {
        throw createError(gate.type === "captcha" ? ERROR_CODES.CAPTCHA_DETECTED : ERROR_CODES.LOGIN_REQUIRED, gate.reason);
      }

      await sleep(1500);
    }

    if (!editorReady) {
      throw createError(ERROR_CODES.UNKNOWN_ERROR, "TikTok Studio không hiển thị trình soạn bài sau khi tải video lên.");
    }

    await this.dismissStudioOverlays();
    return { ok: true, uploadedPath: filePath };
  }

  async editAudioAndMusic({ muteOriginalSound = false, addRecommendedMusic = false } = {}) {
    if (!muteOriginalSound && !addRecommendedMusic) {
      return { skipped: true };
    }

    // Try finding sound button
    const btnCoord = await this.evaluate(`(() => {
      const btn = document.querySelector('button[data-button-name="sounds"]') ||
        document.querySelector('button[data-default-left-menu="MusicPanel"]') ||
        Array.from(document.querySelectorAll('button, [role="button"]')).find(el => {
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 16) return false;
          return /^(âm\\s*thanh|thêm\\s*âm\\s*thanh|sounds?|add\\s*sound|chỉnh\\s*sửa\\s*video|chỉnh\\s*sửa)$/i.test(
            (el.innerText || el.getAttribute('aria-label') || '').trim()
          );
        });
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

    if (!btnCoord) {
      logger.warn("studio-adapter", "Không tìm thấy nút Âm thanh, bỏ qua bước chỉnh nhạc.");
      return { skipped: true, reason: "button_not_found" };
    }

    // Click sound button
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btnCoord.x, y: btnCoord.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btnCoord.x, y: btnCoord.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btnCoord.x, y: btnCoord.y, button: "left", clickCount: 1 });
    await sleep(2000);

    // If add recommended music
    if (addRecommendedMusic) {
      await this.evaluate(`(() => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"], .Tabs__trigger, button'));
        const recTab = tabs.find(el => /^(đề\\s*xuất|dành\\s*cho\\s*bạn|thịnh\\s*hành|recommended|trending)$/i.test((el.innerText || '').trim()));
        if (recTab) recTab.click();
      })()`);
      await sleep(1500);

      // Click first available music item
      await this.evaluate(`(() => {
        const opBtns = Array.from(document.querySelectorAll('.MusicPanelMusicItem__operation button, button[class*="music-item" i]'));
        if (opBtns.length > 0) opBtns[0].click();
      })()`).catch(() => {});
      await sleep(1500);
    }

    // If mute original sound
    if (muteOriginalSound) {
      await this.evaluate(`(() => {
        const muteBtns = Array.from(document.querySelectorAll('button, [role="button"], div[class*="volume" i], svg[class*="volume" i]'));
        const m = muteBtns.find(b => /tắt\\s*tiếng|mute/i.test(b.getAttribute('aria-label') || b.innerText || ''));
        if (m) m.click();
      })()`).catch(() => {});
      await sleep(1000);
    }

    // The Sounds panel lives inside TikTok's video editor. Saving here is
    // mandatory; otherwise the next Add link click is executed on top of the
    // editor and the automation becomes stranded in the Products/Next modal.
    const saveClicked = await this.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 16 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const save = buttons.find(b => visible(b) && !b.disabled && /^(save|lưu|áp\s*dụng|apply)$/i.test((b.innerText || '').trim()));
      if (!save) return false;
      save.scrollIntoView({ block: 'center' });
      save.click();
      return true;
    })()`).catch(() => false);
    if (!saveClicked) {
      throw new Error("Đã chọn nhạc nhưng không tìm thấy nút Save/Lưu của trình chỉnh sửa TikTok.");
    }

    let editorClosed = false;
    const editorDeadline = Date.now() + 90000;
    while (Date.now() < editorDeadline) {
      const state = await this.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 20 && r.height > 16 && s.display !== 'none' && s.visibility !== 'hidden';
        };
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const saveVisible = buttons.some(b => visible(b) && /^(save|lưu|áp\s*dụng|apply)$/i.test((b.innerText || '').trim()));
        const caption = document.querySelector('div.public-DraftEditor-content[contenteditable="true"], [data-e2e*="caption"] [contenteditable="true"]');
        const post = document.querySelector('button[data-e2e="post_video_button"]') || buttons.find(b => /^(đăng|post|lên\s*lịch|schedule)$/i.test((b.innerText || '').trim()));
        return { saveVisible, composerReady: Boolean(caption || post) };
      })()`).catch(() => ({ saveVisible: true, composerReady: false }));
      if (!state.saveVisible && state.composerReady) {
        editorClosed = true;
        break;
      }
      const gate = await this.detectBlockingGate();
      if (gate?.blocked) throw new Error(gate.reason || "TikTok chặn khi lưu chỉnh sửa âm thanh.");
      await sleep(1000);
    }
    if (!editorClosed) {
      throw new Error("TikTok chưa đóng trình chỉnh sửa sau khi bấm Save/Lưu trong 90 giây.");
    }
    await this.dismissStudioOverlays();
    return { ok: true, saved: true };
  }

  async fillMetadata({ title = "", caption = "", hashtags = [] } = {}) {
    const rawText = [caption || title, Array.isArray(hashtags) ? hashtags.join(" ") : hashtags]
      .filter(Boolean)
      .join("\n") || title || "#xuhuong #review";
    let fullText = sanitizeTikTokText(rawText, 2200) || "#xuhuong #review";

    // Focus editor
    await this.evaluate(`(() => {
      const ed = document.querySelector('div.public-DraftEditor-content[contenteditable="true"], [data-e2e*="caption"] [contenteditable="true"], [contenteditable="true"]');
      if (ed) {
        ed.scrollIntoView({ block: 'center' });
        ed.focus();
        ed.click();
      }
    })()`);
    await sleep(500);

    // Select all and clear
    const modifier = process.platform === "darwin" ? 8 : 2; // Meta or Ctrl
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: modifier, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: modifier, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await sleep(300);

    // Insert new caption
    await this.send("Input.insertText", { text: fullText });
    await sleep(700);

    // TikTok sometimes reports the exact rejected token after the text is
    // entered. Remove that token and retype once instead of leaving the job
    // blocked on a validation banner.
    const validation = await this.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('[role="alert"], [class*="error" i], [class*="warning" i], [data-e2e*="error"]'));
      const texts = nodes.map(n => (n.innerText || '').trim()).filter(Boolean);
      return texts.find(t => /không\s*được\s*phép|bị\s*cấm|vi\s*phạm|không\s*hợp\s*lệ|not\s*allowed|prohibited|invalid/i.test(t)) || '';
    })()`).catch(() => "");
    if (validation) {
      const quoted = String(validation).match(/["“'‘]([^"”'’]{2,60})["”'’]/)?.[1]?.trim();
      if (quoted) {
        const escaped = quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        fullText = sanitizeTikTokText(fullText.replace(new RegExp(escaped, "giu"), " "), 2200) || "#xuhuong #review";
        await this.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: modifier, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: modifier, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
        await this.send("Input.insertText", { text: fullText });
        await sleep(500);
      }
    }
    return { ok: true, caption: fullText, sanitized: fullText !== rawText, validationRemoved: validation || "" };
  }

  async openShowcasePicker() {
    const opened = await this.evaluate(`(() => {
      const anchor = document.querySelector('div[data-e2e="anchor_container"]');
      let btn = anchor ? Array.from(anchor.querySelectorAll('button')).find(b => !b.disabled) : null;
      if (!btn) btn = Array.from(document.querySelectorAll('button')).find(b => !b.disabled && /^(thêm\\s*liên\\s*kết|add\\s*link|thêm\\s*sản\\s*phẩm)$/i.test((b.innerText || '').trim()));
      if (!btn) {
        const label = Array.from(document.querySelectorAll('div,span,p,label')).find(e => e.children.length === 0 && /^(add\\s*link|thêm\\s*liên\\s*kết)$/i.test((e.innerText || '').trim()));
        let box = label?.parentElement;
        for (let i = 0; i < 6 && box && !btn; i++, box = box.parentElement) {
          btn = Array.from(box.querySelectorAll('button')).find(b => !b.disabled && /^(add|thêm)$/i.test((b.innerText || '').trim()));
        }
      }
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' }); btn.click(); return true;
    })()`);
    if (!opened) return false;
    await sleep(700);
    const advanced = await this.evaluate(`(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal'));
      const dialog = dialogs[dialogs.length - 1] || document;
      const item = Array.from(dialog.querySelectorAll('[role="menuitem"], [role="option"]')).find(el => /^(sản\\s*phẩm|products?|tiktok\\s*shop|trưng\\s*bày|showcase)$/i.test((el.innerText || '').trim()));
      if (item) item.click();
      const next = Array.from(dialog.querySelectorAll('button')).find(b => !b.disabled && /^(next|tiếp|tiếp\\s*theo)$/i.test((b.innerText || '').trim()));
      if (next) { next.click(); return true; }
      return false;
    })()`);
    if (!advanced) return false;
    for (let i = 0; i < 20; i++) {
      const ready = await this.evaluate(`Boolean(document.querySelector('.product-selector-modal .product-tb-row, .product-table-container .product-tb-row'))`).catch(() => false);
      if (ready) return true;
      await sleep(200);
    }
    return false;
  }

  async collectShowcaseProducts(maxPages = 60) {
    const all = new Map();
    let stagnantPasses = 0;
    for (let page = 0; page < maxPages; page++) {
      const sizeBefore = all.size;
      const rawProducts = await this.scrapeVisibleShowcaseProducts().catch(() => []);
      const products = Array.isArray(rawProducts) ? rawProducts : [];
      for (const product of products) {
        if (product && product.id) all.set(String(product.id), product);
      }
      stagnantPasses = all.size === sizeBefore ? stagnantPasses + 1 : 0;
      if (stagnantPasses >= 3) break;
      const moved = await this.evaluate(`(() => {
        const modals = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]'));
        const scope = document.querySelector('.product-selector-modal') || modals[modals.length - 1] || document;
        const pager = scope.querySelector('.product-table-pagination');
        if (pager) {
          const active = Number((pager.querySelector('.tiktok-pagination-item-is-active')?.innerText || '0').trim());
          const pages = Array.from(pager.querySelectorAll('.tiktok-pagination-item')).map(el => Number((el.innerText || '').trim())).filter(Number.isFinite);
          const last = pages.length ? Math.max(...pages) : 0;
          const nextPage = pager.querySelector('.tiktok-pagination-item-right-arrow');
          if (nextPage && active && (!last || active < last) && !/disabled/i.test(nextPage.className || '')) { nextPage.click(); return true; }
        }
        const scrollables = Array.from(scope.querySelectorAll('div')).filter(el => el.scrollHeight > el.clientHeight + 80);
        const scroller = scrollables.sort((a,b) => b.scrollHeight - a.scrollHeight)[0];
        if (scroller && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 10) {
          scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(400, scroller.clientHeight * 0.8));
          return true;
        }
        const buttons = Array.from(scope.querySelectorAll('button'));
        const next = buttons.find(b => !b.disabled && (/next|tiếp/i.test(b.getAttribute('aria-label') || '') || /next/i.test(b.getAttribute('data-e2e') || '')));
        if (!next) return false; next.click(); return true;
      })()`);
      if (!moved) break;
      await sleep(250);
    }
    return Array.from(all.values());
  }

  async discardCurrentDraft() {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }).catch(() => {});
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }).catch(() => {});
    let clicked = false;
    for (let attempt = 0; attempt < 16 && !clicked; attempt++) {
      clicked = Boolean(await this.evaluate(`(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = buttons.find(b => /^(discard|hủy\\s*bỏ|xóa\\s*video|remove)$/i.test((b.innerText || '').trim()) && !b.disabled);
        if (!btn) return false;
        if (!body.includes("wasn't saved") && !body.includes('chưa được lưu') && !btn.matches('[data-e2e="discard_post_button"]')) return false;
        btn.scrollIntoView({ block: 'center' }); btn.click(); return true;
      })()`).catch(() => false));
      if (!clicked) await sleep(750);
    }
    await sleep(1200);
    await this.evaluate(`(() => {
      const modal = document.querySelector('[role="dialog"], .TUXModal, div[class*="modal" i]');
      if (!modal) return;
      const ok = Array.from(modal.querySelectorAll('button')).find(b => /^(discard|hủy\\s*bỏ|xác\\s*nhận|confirm|xóa|remove)$/i.test((b.innerText || '').trim()) && !b.disabled);
      if (ok) ok.click();
    })()`).catch(() => {});
    await sleep(800);
    const clean = await this.evaluate(`Boolean(document.querySelector('input[type="file"][accept*="video"], input[type="file"]'))`).catch(() => false);
    if (!clean) await this.send("Page.navigate", { url: TIKTOK_STUDIO_URL }).catch(() => {});
    return { ok: true };
  }

  async attachProductCart(productTarget, customDisplayName = "") {
    const lockedProductId = String(productTarget?.productId || "").trim();
    if (!lockedProductId) throw new Error("Chưa khóa Product ID; dừng đăng để tránh gắn nhầm sản phẩm.");
    // 1. Click anchor container / Add link
    const anchorCoord = await this.evaluate(`(() => {
      const anchor = document.querySelector('div[data-e2e="anchor_container"]');
      let btn = anchor ? Array.from(anchor.querySelectorAll('button')).find(b => !b.disabled) : null;
      if (!btn) {
        const lbl = Array.from(document.querySelectorAll('span, div, p, label')).find(
          e => e.children.length === 0 && /^(thêm\\s*liên\\s*kết|add\\s*link|thêm\\s*sản\\s*phẩm)$/i.test((e.innerText || '').trim())
        );
        let box = lbl;
        for (let i = 0; i < 6 && box; i++) {
          const found = Array.from(box.querySelectorAll('button')).find(b => /^(thêm|add|\\+\\s*thêm|thêm\\s*liên\\s*kết)$/i.test((b.innerText || '').trim()));
          if (found) { btn = found; break; }
          box = box.parentElement;
        }
      }
      if (!btn) btn = document.querySelector('[data-e2e*="add_link"], [data-e2e*="add-link"]');
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

    if (!anchorCoord) {
      throw new Error("Không tìm thấy nút Thêm liên kết / Giỏ hàng; bài chưa được phép đăng.");
    }
    await sleep(1500);

    // 2. Select "Sản phẩm" in menu/modal, then advance through the explicit
    // Products -> Next screen used by the current TikTok Studio UI.
    await this.evaluate(`(() => {
      const menuItem = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button')).find(el => {
        return /^(sản\\s*phẩm|product|tiktok\\s*shop|trưng\\s*bày|showcase)$/i.test((el.innerText || '').trim());
      });
      if (menuItem) menuItem.click();
    })()`);
    await sleep(500);

    const advanced = await this.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 16 && getComputedStyle(el).visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]')).filter(visible);
      const scope = dialogs.at(-1) || document;
      const next = Array.from(scope.querySelectorAll('button')).find(b => visible(b) && !b.disabled && /^(next|tiếp|tiếp\s*theo)$/i.test((b.innerText || '').trim()));
      if (next) {
        next.click();
        return true;
      }
      return Boolean(scope.querySelector('input[type="search"], input[placeholder*="search" i], input[placeholder*="tìm" i]'));
    })()`).catch(() => false);
    if (!advanced) throw new Error("Hộp Add link không có nút Next hoặc danh sách sản phẩm.");

    let productPickerReady = false;
    let showcaseEmpty = false;
    const pickerDeadline = Date.now() + 30000;
    while (Date.now() < pickerDeadline) {
      const status = await this.evaluate(`(() => {
        const modal = document.querySelector('.product-selector-modal, [role="dialog"], .TUXModal, div[class*="modal" i]') || document;
        const text = (modal.innerText || '').toLowerCase();
        if (/no products in your showcase|không có sản phẩm nào trong mục trưng bày|chưa có sản phẩm trong mục trưng bày|go to tiktok app/i.test(text)) {
          return { ready: true, empty: true };
        }
        const input = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')).find(i => {
          const ph = (i.placeholder || i.getAttribute('aria-label') || '').toLowerCase();
          return ph.includes('tìm') || ph.includes('search') || ph.includes('id') || ph.includes('sản phẩm') || ph.includes('product');
        });
        const row = document.querySelector('.product-selector-modal .product-tb-row, .product-table-container .product-tb-row, tr.product-tb-row, tbody tr, [data-product-id], div[class*="product-item" i], div[class*="product-card" i]');
        return { ready: Boolean(input || row), empty: false };
      })()`).catch(() => ({ ready: false, empty: false }));
      if (status.ready) {
        productPickerReady = true;
        showcaseEmpty = Boolean(status.empty);
        break;
      }
      await sleep(500);
    }
    if (showcaseEmpty) {
      await this.evaluate(`(() => {
        const modal = document.querySelector('.product-selector-modal, [role="dialog"], .TUXModal') || document;
        const cancelBtn = Array.from(modal.querySelectorAll('button')).find(b => /^(hủy|huỷ|cancel|close|đóng)$/i.test((b.innerText || '').trim()));
        if (cancelBtn) cancelBtn.click();
      })()`).catch(() => {});
      throw new Error("Kênh TikTok này chưa có sản phẩm nào trong mục Trưng bày (Showcase). Hãy mở app TikTok trên điện thoại > Hồ sơ > TikTok Shop để thêm sản phẩm vào Trưng bày trước khi gắn giỏ hàng.");
    }
    if (!productPickerReady) throw new Error("TikTok không mở danh sách sản phẩm sau khi bấm Next trong 30 giây.");

    // 3. Ensure search box is clean so full Showcase catalog is visible
    await this.evaluate(`(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
      const inp = inputs.find(i => {
        const ph = (i.placeholder || i.getAttribute('aria-label') || '').toLowerCase();
        return ph.includes('tìm') || ph.includes('search') || ph.includes('id') || ph.includes('sản phẩm');
      });
      if (inp && inp.value) {
        inp.focus();
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
    })()`);
    await sleep(800);

    // 4. Select the row matching Product ID (or keyword) across pages
    let selected = null;
    const maxPages = 30;
    for (let p = 1; p <= maxPages; p++) {
      selected = await this.evaluate(`((wantedId, wantedKw) => {
        const fold = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
        const readId = (row) => {
          const attrs = ['data-product-id','data-id','data-item-id','product-id'];
          for (const name of attrs) {
            const val = row.getAttribute && row.getAttribute(name);
            if (val && String(val).trim() === wantedId) return wantedId;
          }
          const rowText = row.innerText || '';
          if (rowText.includes(wantedId)) return wantedId;
          const tokens = rowText.split(/[^0-9]+/);
          if (tokens.includes(wantedId)) return wantedId;
          const nodes = [row, ...Array.from(row.querySelectorAll('td, div, span, p, a, [data-product-id],[data-id],[data-item-id]'))];
          for (const node of nodes) {
            for (const name of attrs) {
              const val = node.getAttribute && node.getAttribute(name);
              if (val && String(val).trim() === wantedId) return wantedId;
            }
            if ((node.innerText || '').includes(wantedId)) return wantedId;
          }
          return '';
        };
        const rows = Array.from(document.querySelectorAll('.product-selector-modal .product-tb-row, .product-table-container .product-tb-row, tr.product-tb-row, tbody tr, [role="row"], [data-product-id], div[class*="product-item" i], div[class*="product-card" i]'));
        let target = wantedId ? rows.find(row => readId(row) === wantedId) : null;
        if (!target && wantedKw) {
          const fKw = fold(wantedKw);
          target = rows.find(row => fold(row.innerText).includes(fKw));
        }
        if (!target) return null;
        target.scrollIntoView({ block: 'center' });
        const radio = target.querySelector('.TUXRadio, .TUXRadioStandalone, input[type="radio"], input[type="checkbox"], [role="radio"]');
        if (radio) radio.click(); else target.click();
        return { ok: true, productId: wantedId || readId(target), title: (target.innerText || '').trim().slice(0, 200) };
      })(${JSON.stringify(lockedProductId)}, ${JSON.stringify(productTarget?.keyword || productTarget?.searchKeyword || "")})`);

      if (selected?.ok) break;

      const paged = await this.evaluate(`(() => {
        const selectors = [
          '.product-selector-modal .tiktok-pagination-item-right-arrow',
          '.tiktok-pagination-item-right-arrow',
          'li.arco-pagination-next:not(.arco-pagination-disabled)',
          'li[class*="pagination-next"]:not([class*="disabled"])',
          'li[class*="pagination-item-next"]:not([class*="disabled"])',
          'li.semi-page-item-next:not([class*="disabled"])',
          'button[aria-label*="next page" i]:not([disabled])',
          'button[aria-label*="trang sau" i]:not([disabled])',
          'button[aria-label*="trang tiếp" i]:not([disabled])',
          '[data-e2e="pagination-next"]:not([disabled])',
          '.tiktok-pagination-next:not([class*="disabled"])'
        ];
        let a = null;
        for (const sel of selectors) {
          a = document.querySelector(sel);
          if (a) break;
        }
        if (!a) return false;
        if (a.disabled || a.classList.contains('tiktok-pagination-item-disabled') ||
            a.classList.contains('arco-pagination-disabled') || a.getAttribute('aria-disabled') === 'true') {
          return false;
        }
        try { (a.querySelector('a, button, span') || a).click(); } catch (_) { a.click(); }
        return true;
      })()`);

      if (!paged) {
        const scrolled = await this.evaluate(`(() => {
          const c = document.querySelector('.product-selector-modal tbody, .product-table-container, [class*="product-list" i]');
          if (c && c.scrollHeight > c.clientHeight) { c.scrollTop += 600; return true; }
          return false;
        })()`);
        if (!scrolled) break;
      }
      await sleep(1500);
    }

    if (!selected?.ok) throw new Error(`TikTok không tìm thấy Product ID ${lockedProductId} sau khi duyệt qua các trang Showcase; dừng để tránh chọn sai sản phẩm.`);
    await sleep(1000);

    // Click Next button
    await this.evaluate(`(() => {
      const modal = document.querySelector('.product-selector-modal') ||
        Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]')).pop() || document;
      const btns = Array.from(modal.querySelectorAll('button')).filter(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      const nextBtn = btns.reverse().find(b => /^(tiếp|tiếp\\s*theo|next)$/i.test((b.innerText || '').trim()));
      if (nextBtn) nextBtn.click();
    })()`);
    await sleep(1500);

    // 5. Fill custom product display name if provided (<= 30 chars)
    if (customDisplayName) {
      const cleanName = customDisplayName.slice(0, 30);
      await this.evaluate(`((nameVal) => {
        const nameInput = document.querySelector('input[placeholder*="tên" i], input[data-e2e*="product-name"], input[maxlength="30"]');
        if (nameInput) {
          nameInput.focus();
          nameInput.value = nameVal;
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })(${JSON.stringify(cleanName)})`);
      await sleep(800);
    }

    // 6. Confirm attachment
    await this.evaluate(`(() => {
      const addBtn = Array.from(document.querySelectorAll('button')).find(b => !b.disabled && /^(thêm|add|hoàn\\s*tất|done|xác\\s*nhận)$/i.test((b.innerText || '').trim()));
      if (addBtn) addBtn.click();
    })()`);
    await sleep(2000);

    return { ok: true, attached: true, productId: lockedProductId, evidence: selected };
  }

  async attachProductCartVerified(productTarget, customDisplayName = "") {
    const lockedProductId = String(productTarget?.productId || "").trim();
    if (!lockedProductId) throw new Error("Chưa khóa Product ID; dừng đăng để tránh gắn nhầm sản phẩm.");
    const waitFor = async (reader, timeoutMs, message) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await reader().catch(() => null);
        if (value) return value;
        await sleep(500);
      }
      throw new Error(message);
    };

    const addLink = await waitFor(() => this.evaluate(`(() => {
      const visible = el => { const r = el?.getBoundingClientRect(); return Boolean(r && r.width > 20 && r.height > 16); };
      const anchor = document.querySelector('div[data-e2e="anchor_container"]');
      let btn = anchor ? Array.from(anchor.querySelectorAll('button, [role="button"]')).find(b => visible(b) && !b.disabled) : null;
      if (!btn) btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => visible(b) && !b.disabled && /^(add\s*link|thêm\s*liên\s*kết|thêm\s*sản\s*phẩm)$/i.test((b.innerText || '').trim()));
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`), 15000, "Không tìm thấy nút Thêm liên kết / Giỏ hàng.");
    await this.physicalClick(addLink);

    const firstNext = await waitFor(() => this.evaluate(`(() => {
      const visible = el => { const r = el?.getBoundingClientRect(); return Boolean(r && r.width > 20 && r.height > 16); };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]')).filter(visible);
      const scope = dialogs.at(-1) || document;
      const products = Array.from(scope.querySelectorAll('[role="option"], [role="menuitem"], button, div')).find(el => visible(el) && /^(products?|sản\s*phẩm)$/i.test((el.innerText || '').trim()));
      if (products && products.getAttribute('aria-selected') === 'false') products.click();
      const btn = Array.from(scope.querySelectorAll('button')).find(b => visible(b) && !b.disabled && /^(next|tiếp|tiếp\s*theo)$/i.test((b.innerText || '').trim()));
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`), 20000, "Hộp Add link chưa bật nút Next.");
    await this.physicalClick(firstNext);

    await waitFor(() => this.evaluate(`(() => {
      const modal = document.querySelector('.product-selector-modal, [role="dialog"], .TUXModal, div[class*="modal" i]') || document;
      const text = (modal.innerText || '').toLowerCase();
      if (/no products in your showcase|không có sản phẩm nào trong mục trưng bày|chưa có sản phẩm trong mục trưng bày|go to tiktok app/i.test(text)) {
        return true;
      }
      return Boolean(Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')).find(i => {
        const ph = (i.placeholder || i.getAttribute('aria-label') || '').toLowerCase();
        return ph.includes('search') || ph.includes('tìm') || ph.includes('product') || ph.includes('sản phẩm') || ph.includes('id');
      }) || document.querySelector('.product-tb-row, tr.product-tb-row, tbody tr'));
    })()`), 30000, "TikTok không mở danh sách sản phẩm sau khi bấm Next.");

    const isShowcaseEmpty = await this.evaluate(`(() => {
      const modal = document.querySelector('.product-selector-modal, [role="dialog"], .TUXModal, div[class*="modal" i]') || document;
      const text = (modal.innerText || '').toLowerCase();
      return /no products in your showcase|không có sản phẩm nào trong mục trưng bày|chưa có sản phẩm trong mục trưng bày|go to tiktok app/i.test(text);
    })()`);
    if (isShowcaseEmpty) {
      await this.evaluate(`(() => {
        const modal = document.querySelector('.product-selector-modal, [role="dialog"], .TUXModal') || document;
        const cancelBtn = Array.from(modal.querySelectorAll('button')).find(b => /^(hủy|huỷ|cancel|close|đóng)$/i.test((b.innerText || '').trim()));
        if (cancelBtn) cancelBtn.click();
      })()`).catch(() => {});
      throw new Error("Kênh TikTok này chưa có sản phẩm nào trong mục Trưng bày (Showcase). Hãy mở app TikTok trên điện thoại > Hồ sơ > TikTok Shop để thêm sản phẩm vào Trưng bày trước khi gắn giỏ hàng.");
    }

    // 1. Ensure search input is clean so full Showcase catalog is visible across pages
    await this.evaluate(`(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
      const inp = inputs.find(i => {
        const ph = (i.placeholder || i.getAttribute('aria-label') || '').toLowerCase();
        return ph.includes('search') || ph.includes('tìm') || ph.includes('product') || ph.includes('sản phẩm') || ph.includes('id');
      });
      if (inp && inp.value) {
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(inp, ''); else inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
    })()`);
    await sleep(800);

    // Helper to find matching row on current page
    const findRowCoords = async (wantedId, wantedKw) => {
      return this.evaluate(`((wantedId, wantedKw) => {
        const fold = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
        const readId = row => {
          const attrs = ['data-product-id', 'data-id', 'data-item-id', 'product-id'];
          for (const name of attrs) {
            const val = row.getAttribute && row.getAttribute(name);
            if (val && String(val).trim() === wantedId) return wantedId;
          }
          const rowText = row.innerText || '';
          if (rowText.includes(wantedId)) return wantedId;
          const tokens = rowText.split(/[^0-9]+/);
          if (tokens.includes(wantedId)) return wantedId;

          const nodes = [row, ...Array.from(row.querySelectorAll('td, div, span, p, a, [data-product-id],[data-id],[data-item-id]'))];
          for (const node of nodes) {
            for (const name of attrs) {
              const val = node.getAttribute && node.getAttribute(name);
              if (val && String(val).trim() === wantedId) return wantedId;
            }
            if ((node.innerText || '').includes(wantedId)) return wantedId;
          }
          return '';
        };
        const rows = Array.from(document.querySelectorAll('.product-selector-modal .product-tb-row, .product-table-container .product-tb-row, tr.product-tb-row, tbody tr, [role="row"], [data-product-id], div[class*="product-item" i], div[class*="product-card" i]'));
        let row = wantedId ? rows.find(r => readId(r) === wantedId) : null;
        if (!row && wantedKw) {
          const fKw = fold(wantedKw);
          row = rows.find(r => fold(r.innerText).includes(fKw));
        }
        if (!row) return null;
        row.scrollIntoView({ block: 'center' });
        const visible = el => { const r = el?.getBoundingClientRect(); return Boolean(r && r.width >= 10 && r.height >= 10 && getComputedStyle(el).visibility !== 'hidden'); };
        const controls = Array.from(row.querySelectorAll('[role="radio"], label, [class*="radio" i], [class*="Radio"], input[type="radio"], input[type="checkbox"]'));
        const visibleControls = controls.filter(visible);
        const clickable = visibleControls.find(el => { const r = el.getBoundingClientRect(); return r.width <= 80 && r.height <= 80; }) || visibleControls[0];
        const rowRect = row.getBoundingClientRect();
        const rect = clickable?.getBoundingClientRect();
        const x = rect ? rect.left + rect.width / 2 : rowRect.left + 34;
        const y = rect ? rect.top + rect.height / 2 : rowRect.top + rowRect.height / 2;
        return { ok: true, productId: wantedId || readId(row), title: (row.innerText || '').trim().slice(0, 200), x: Math.round(x), y: Math.round(y) };
      })(${JSON.stringify(lockedProductId)}, ${JSON.stringify(productTarget?.keyword || productTarget?.searchKeyword || "")})`);
    };

    // Helper to click next page in pagination
    const clickNextPage = async () => {
      const nextCoords = await this.evaluate(`(() => {
        const selectors = [
          '.product-selector-modal .tiktok-pagination-item-right-arrow',
          '.tiktok-pagination-item-right-arrow',
          'li.arco-pagination-next:not(.arco-pagination-disabled)',
          'li[class*="pagination-next"]:not([class*="disabled"])',
          'li[class*="pagination-item-next"]:not([class*="disabled"])',
          'li.semi-page-item-next:not([class*="disabled"])',
          'button[aria-label*="next page" i]:not([disabled])',
          'button[aria-label*="trang sau" i]:not([disabled])',
          'button[aria-label*="trang tiếp" i]:not([disabled])',
          '[data-e2e="pagination-next"]:not([disabled])',
          '.tiktok-pagination-next:not([class*="disabled"])'
        ];
        let a = null;
        for (const sel of selectors) {
          a = document.querySelector(sel);
          if (a) break;
        }
        if (!a) return null;
        if (a.disabled || a.classList.contains('tiktok-pagination-item-disabled') ||
            a.classList.contains('arco-pagination-disabled') || a.getAttribute('aria-disabled') === 'true') {
          return null;
        }
        try { (a.querySelector('a, button, span') || a).click(); } catch (_) { a.click(); }
        const r = a.getBoundingClientRect();
        return r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
      })()`);
      if (nextCoords) {
        await this.physicalClick(nextCoords);
        await sleep(1500);
        return true;
      }
      const scrolled = await this.evaluate(`(() => {
        const c = document.querySelector('.product-selector-modal tbody, .product-table-container, [class*="product-list" i]');
        if (c && c.scrollHeight > c.clientHeight) { c.scrollTop += 600; return true; }
        return false;
      })()`);
      if (scrolled) {
        await sleep(1200);
        return true;
      }
      return false;
    };

    let selected = null;
    const maxSearchPages = 30;
    for (let page = 1; page <= maxSearchPages; page++) {
      selected = await findRowCoords(lockedProductId, productTarget?.keyword || productTarget?.searchKeyword || "");
      if (selected?.ok) break;
      const hasNext = await clickNextPage();
      if (!hasNext) break;
    }

    // Fallback: If not found across pages by ID, and user specified a text keyword (not numeric), try typing text keyword
    const textKeyword = String(productTarget?.keyword || productTarget?.searchKeyword || "").trim();
    const hasMeaningfulTextKeyword = textKeyword && !/^[0-9]+$/.test(textKeyword) && textKeyword !== lockedProductId;
    if (!selected?.ok && hasMeaningfulTextKeyword) {
      const typed = await this.evaluate(`((kw) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
        const inp = inputs.find(i => { const ph = (i.placeholder || i.getAttribute('aria-label') || '').toLowerCase(); return ph.includes('search') || ph.includes('tìm') || ph.includes('product') || ph.includes('sản phẩm') || ph.includes('id'); });
        if (!inp) return false;
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(inp, kw); else inp.value = kw;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
      })(${JSON.stringify(textKeyword.slice(0, 30))})`);
      if (typed) {
        await sleep(1500);
        for (let page = 1; page <= 5; page++) {
          selected = await findRowCoords(lockedProductId, textKeyword);
          if (selected?.ok) break;
          const hasNext = await clickNextPage();
          if (!hasNext) break;
        }
      }
    }

    if (!selected?.ok) {
      throw new Error(`TikTok không tìm thấy Product ID ${lockedProductId} sau khi duyệt qua các trang Showcase; dừng để tránh chọn sai sản phẩm.`);
    }

    await this.physicalClick(selected);
    await sleep(800);

    const secondNext = await waitFor(() => this.evaluate(`((wantedId) => {
      const visible = el => { const r = el?.getBoundingClientRect(); return Boolean(r && r.width > 20 && r.height > 16); };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]')).filter(visible);
      const scope = dialogs.at(-1) || document;
      const btn = Array.from(scope.querySelectorAll('button')).find(b => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && /^(next|tiếp|tiếp\\s*theo)$/i.test((b.innerText || '').trim()));
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect();
      return { selectedProductId: wantedId, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })(${JSON.stringify(lockedProductId)})`), 20000, "Đã tìm đúng sản phẩm nhưng radio chưa được chọn nên nút Next vẫn khóa.");
    await this.physicalClick(secondNext);

    const cleanName = sanitizeTikTokText(customDisplayName || productTarget?.keyword || "Sản phẩm", 30) || "Sản phẩm";
    await waitFor(() => this.evaluate(`(() => Boolean(
      document.querySelector('input[placeholder*="tên" i], input[data-e2e*="product-name"], input[maxlength="30"]') ||
      Array.from(document.querySelectorAll('button')).some(b => !b.disabled && /^(add|thêm|done|hoàn\s*tất|confirm|xác\s*nhận)$/i.test((b.innerText || '').trim()))
    ))()`), 20000, "TikTok chưa mở bước xác nhận sản phẩm.");
    await this.evaluate(`((nameVal) => {
      const inp = document.querySelector('input[placeholder*="tên" i], input[data-e2e*="product-name"], input[maxlength="30"]');
      if (!inp) return false;
      inp.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(inp, nameVal); else inp.value = nameVal;
      inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); return true;
    })(${JSON.stringify(cleanName)})`);

    const confirm = await waitFor(() => this.evaluate(`(() => {
      const visible = el => { const r = el?.getBoundingClientRect(); return Boolean(r && r.width > 20 && r.height > 16); };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]')).filter(visible);
      const scope = dialogs.at(-1) || document;
      const btn = Array.from(scope.querySelectorAll('button')).find(b => visible(b) && !b.disabled && /^(add|thêm|done|hoàn\s*tất|confirm|xác\s*nhận)$/i.test((b.innerText || '').trim()));
      if (!btn) return null; btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`), 20000, "Không tìm thấy nút Add/Xác nhận cuối để gắn giỏ hàng.");
    await this.physicalClick(confirm);

    const evidence = await waitFor(() => this.evaluate(`((expectedName) => {
      const visible = el => { const r = el?.getBoundingClientRect(); return Boolean(r && r.width > 20 && r.height > 16); };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]')).filter(visible);
      const productDialogOpen = dialogs.some(d => /add\s*link|thêm\s*liên\s*kết|products?|sản\s*phẩm/i.test((d.innerText || '')));
      const anchor = document.querySelector('div[data-e2e="anchor_container"], [data-e2e*="product-link"], [data-e2e*="anchor"]');
      const anchorText = (anchor?.innerText || '').trim();
      const nameVisible = expectedName && (document.body?.innerText || '').toLowerCase().includes(expectedName.toLowerCase());
      const anchorHasProduct = Boolean(anchorText && !/^(add\s*link|thêm\s*liên\s*kết|thêm\s*sản\s*phẩm)$/i.test(anchorText));
      return !productDialogOpen && (nameVisible || anchorHasProduct) ? { anchorText, expectedName } : null;
    })(${JSON.stringify(cleanName)})`), 30000, "TikTok chưa hiển thị sản phẩm trong bài; dừng để không đăng thiếu giỏ hàng.");

    return { ok: true, attached: true, productId: lockedProductId, evidence: { ...selected, ...evidence } };
  }

  async scrapeVisibleShowcaseProducts() {
    const result = await this.evaluate(`(() => {
      const unique = new Map();
      const rows = Array.from(document.querySelectorAll('.product-selector-modal .product-tb-row, .product-table-container .product-tb-row, tr.product-tb-row, tbody tr, [role="row"], [data-product-id], div[class*="product-item" i], div[class*="product-card" i]'));
      const idFrom = (row) => {
        const direct = row.getAttribute?.('data-product-id') || row.getAttribute?.('data-item-id') || '';
        if (/^[0-9]{10,24}$/.test(direct)) return direct;
        const candidates = [row.innerText, ...Array.from(row.querySelectorAll('[data-product-id],[data-item-id],a[href]')).flatMap(n => [n.getAttribute?.('data-product-id'), n.getAttribute?.('data-item-id'), n.getAttribute?.('href'), n.innerText])];
        for (const value of candidates) {
          const match = String(value || '').match(/(?:product(?:_id)?|item(?:_id)?|\\/product\\/)[^0-9]*([0-9]{10,24})/i) || String(value || '').match(/\\b([0-9]{14,24})\\b/);
          if (match) return match[1];
        }
        return '';
      };
      for (const row of rows) {
        const id = idFrom(row);
        if (!id || unique.has(id)) continue;
        const img = row.querySelector('img');
        const text = (row.innerText || '').split('\\n').map(v => v.trim()).filter(Boolean);
        const title = text.find(v => v !== id && !/^chọn|select$/i.test(v)) || '';
        unique.set(id, { id, title, imageUrl: img?.currentSrc || img?.src || '', status: 'active' });
      }
      return Array.from(unique.values());
    })()`).catch(() => []);
    return Array.isArray(result) ? result : [];
  }

  async configureSchedule({ mode, scheduledTime } = {}) {
    if (mode !== "native_schedule") {
      return { ok: true, mode: "immediate" };
    }

    await this.dismissStudioOverlays();

    // 1. Select schedule radio
    const radioSelected = await this.evaluate(`(() => {
      const directRadio = document.querySelector('input[type="radio"][name="postSchedule"][value="schedule"], input[type="radio"][value="schedule"]');
      if (directRadio) {
        directRadio.click();
        return true;
      }
      const labels = Array.from(document.querySelectorAll('label, [role="radio"], button, div, span'));
      const sched = labels.find(el => /^(lên\\s*lịch|schedule|hẹn\\s*giờ)$/i.test((el.innerText || el.getAttribute('aria-label') || '').trim()));
      if (sched) {
        sched.click();
        return true;
      }
      return false;
    })()`);

    if (!radioSelected) {
      return {
        ok: false,
        error: "SCHEDULE_NOT_PERMITTED_ON_UI",
        message: "Giao diện hiện tại chỉ cho phép Đăng ngay, không thể chọn Lên lịch"
      };
    }

    await sleep(1000);

    // Confirm permission dialog if shown
    await this.evaluate(`(() => {
      const modals = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal, div[class*="modal" i]'));
      for (const m of modals) {
        const allowBtn = Array.from(m.querySelectorAll('button')).find(b => /^(cho\\s*phép|allow|đồng\\s*ý|agree|xác\\s*nhận|confirm)$/i.test((b.innerText || '').trim()));
        if (allowBtn) allowBtn.click();
      }
    })()`);
    await sleep(1000);

    // Format target date and time
    const targetDate = scheduledTime ? new Date(scheduledTime) : new Date(Date.now() + 3600000);
    const targetDay = String(targetDate.getDate());
    const targetH = String(targetDate.getHours()).padStart(2, "0");
    const targetM = String(Math.floor(targetDate.getMinutes() / 5) * 5).padStart(2, "0");

    // Click date trigger and select day
    await this.evaluate(`((targetDay) => {
      const triggers = Array.from(document.querySelectorAll('.schedule-picker .Picker__trigger, .scheduled-picker .Picker__trigger, [role="combobox"]'));
      const dateTrig = triggers.find(t => {
        const txt = (t.innerText || '').toLowerCase();
        return txt.includes('tháng') || txt.includes('month') || (t.getAttribute('aria-label') || '').toLowerCase().includes('date');
      }) || triggers[0];
      if (dateTrig) dateTrig.click();
    })(${JSON.stringify(targetDay)})`);
    await sleep(800);

    await this.evaluate(`((targetDay) => {
      const dayButtons = Array.from(document.querySelectorAll('.DatePicker__day, button[class*="day" i]'));
      const btn = dayButtons.find(b => (b.innerText || '').trim() === String(targetDay) && !b.disabled);
      if (btn) btn.click();
    })(${JSON.stringify(targetDay)})`);
    await sleep(800);

    // Click time trigger and select hour / minute
    await this.evaluate(`((hVal, mVal) => {
      const triggers = Array.from(document.querySelectorAll('.schedule-picker .Picker__trigger, .scheduled-picker .Picker__trigger, [role="combobox"]'));
      const timeTrig = triggers.find(t => /\\d{1,2}:\\d{2}/.test(t.innerText || '')) || triggers[1];
      if (timeTrig) timeTrig.click();
    })(${JSON.stringify(targetH)}, ${JSON.stringify(targetM)})`);
    await sleep(800);

    await this.evaluate(`((hVal, mVal) => {
      const cols = Array.from(document.querySelectorAll('.TimePicker__column'));
      if (cols.length >= 2) {
        const hItem = Array.from(cols[0].querySelectorAll('.TimePicker__item')).find(b => b.innerText.trim() === hVal);
        if (hItem) hItem.click();
        const mItem = Array.from(cols[1].querySelectorAll('.TimePicker__item')).find(b => b.innerText.trim() === mVal);
        if (mItem) mItem.click();
      }
    })(${JSON.stringify(targetH)}, ${JSON.stringify(targetM)})`);
    await sleep(800);

    // Close picker by clicking title/body
    await this.evaluate(`(() => {
      const title = document.querySelector('.scheduled-title-container, h1, h2, label');
      if (title) title.click();
      else document.body.click();
    })()`).catch(() => {});
    await sleep(500);

    return { ok: true, mode: "native_schedule", scheduledTime: targetDate.getTime() };
  }

  async verifySubmitActionSafety(requestedMode) {
    const buttonInfo = await this.evaluate(`(() => {
      const btn = document.querySelector('button[data-e2e="post_video_button"]') ||
        Array.from(document.querySelectorAll('button')).find(b => /^(đăng|post|lên\\s*lịch|schedule)$/i.test((b.innerText || '').trim()));
      if (!btn) return { exists: false };
      const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      const disabled = Boolean(btn.disabled || btn.getAttribute('aria-disabled') === 'true');
      return { exists: true, text, disabled };
    })()`);

    if (!buttonInfo || !buttonInfo.exists) {
      throw createError(ERROR_CODES.STUDIO_SELECTOR_MISMATCH, "Không tìm thấy nút Đăng/Lên lịch trên TikTok Studio");
    }

    if (buttonInfo.disabled) {
      throw createError(ERROR_CODES.UNKNOWN_ERROR, "Nút Đăng/Lên lịch trên TikTok Studio đang bị vô hiệu hóa.");
    }

    // Safety rule FR-013: if requested native_schedule but button says only "đăng" and not "lịch"
    if (requestedMode === "native_schedule" && !/lên\\s*lịch|schedule/i.test(buttonInfo.text)) {
      throw createError(
        ERROR_CODES.SCHEDULE_NOT_PERMITTED_ON_UI,
        "Giao diện hiển thị nút Đăng ngay thay vì Lên lịch. Dừng an toàn để chống đăng nhầm."
      );
    }

    return { ok: true, buttonText: buttonInfo.text };
  }

  async submitPost({ mode = "native_schedule" } = {}) {
    await this.verifySubmitActionSafety(mode);

    // Click post button
    const clicked = await this.evaluate(`(() => {
      const btn = document.querySelector('button[data-e2e="post_video_button"]') ||
        Array.from(document.querySelectorAll('button')).find(b => /^(đăng|post|lên\\s*lịch|schedule)$/i.test((b.innerText || '').trim()));
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    })()`);

    if (!clicked) {
      throw createError(ERROR_CODES.STUDIO_SELECTOR_MISMATCH, "Không thể bấm nút Đăng/Lên lịch");
    }

    await sleep(2000);

    // Handle any popups/dialogs
    await this.evaluate(`(() => {
      const modalBtns = Array.from(document.querySelectorAll('[role="dialog"] button, .TUXModal button'));
      const ok = modalBtns.find(b => /^(đăng\\s*ngay|post\\s*now|xác\\s*nhận|confirm|tiếp\\s*tục|continue)$/i.test((b.innerText || '').trim()));
      if (ok) ok.click();
    })()`).catch(() => {});

    // Poll for confirmation evidence
    const timeout = Date.now() + 45000;
    let confirmed = false;

    while (Date.now() < timeout) {
      const res = await this.evaluate(`(() => {
        const url = location.href || '';
        const txt = (document.body?.innerText || '');
        return {
          redirected: /\\/tiktokstudio\\/content|\\/manage/i.test(url),
          doneText: /đã\\s*đăng|đã\\s*lên\\s*lịch|video\\s*(của\\s*bạn\\s*)?đang\\s*được\\s*tải\\s*lên|your\\s*video\\s*(is\\s*being|has\\s*been)\\s*(uploaded|posted|scheduled)/i.test(txt)
        };
      })()`);

      if (res && (res.redirected || res.doneText)) {
        confirmed = true;
        break;
      }

      const gate = await this.detectBlockingGate();
      if (gate && gate.blocked) {
        throw createError(gate.type === "captcha" ? ERROR_CODES.CAPTCHA_DETECTED : ERROR_CODES.LOGIN_REQUIRED, gate.reason);
      }

      await sleep(1500);
    }

    const evidenceType = mode === "native_schedule" ? "schedule_confirmed" : "post_confirmed";
    const evidenceId = `tiktok-${Date.now()}`;

    return {
      ok: true,
      evidence: {
        type: evidenceType,
        evidenceId,
        confirmed,
        timestamp: new Date().toISOString()
      }
    };
  }

  async close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }
}

module.exports = {
  SELECTORS,
  StudioAdapter
};
