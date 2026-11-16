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

      const cookies = Array.isArray(cookiesRes?.cookies) ? cookiesRes.cookies : [];
      hasSession = cookies.some(c =>
        ["sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt"].includes(c.name) &&
        String(c.value || "").trim().length > 0
      );
    } catch (_) {}

    // Extract profile info from page context
    const profile = await this.evaluate(`(() => {
      const out = { handle: '', nickname: '', avatar: '', hasLoginModal: false };
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

        return out;
      } catch (_) {
        return out;
      }
    })()`).catch(() => ({ handle: "", nickname: "", avatar: "", hasLoginModal: false }));

    const isLive = (hasSession || Boolean(profile.handle || profile.nickname)) && !profile.hasLoginModal;
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

    // Close panel / save
    await this.dismissStudioOverlays();
    return { ok: true };
  }

  async fillMetadata({ title = "", caption = "", hashtags = [] } = {}) {
    const fullText = [caption || title, Array.isArray(hashtags) ? hashtags.join(" ") : hashtags]
      .filter(Boolean)
      .join("\n") || title || "#xuhuong #review";

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
    await sleep(500);
    return { ok: true, caption: fullText };
  }

  async attachProductCart(productTarget, customDisplayName = "") {
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
      logger.warn("studio-adapter", "Không tìm thấy nút Thêm liên kết / Giỏ hàng.");
      return { skipped: true, reason: "anchor_not_found" };
    }
    await sleep(1500);

    // 2. Select "Sản phẩm" in menu/modal
    await this.evaluate(`(() => {
      const menuItem = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button')).find(el => {
        return /^(sản\\s*phẩm|product|tiktok\\s*shop|trưng\\s*bày|showcase)$/i.test((el.innerText || '').trim());
      });
      if (menuItem) menuItem.click();
    })()`);
    await sleep(1500);

    // 3. Search product
    const kw = productTarget.productId || productTarget.keyword || "";
    if (kw) {
      await this.evaluate(`((searchVal) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
        const inp = inputs.find(i => {
          const ph = (i.placeholder || i.getAttribute('aria-label') || '').toLowerCase();
          return ph.includes('tìm') || ph.includes('search') || ph.includes('id') || ph.includes('sản phẩm');
        }) || inputs[0];
        if (inp) {
          inp.focus();
          inp.value = searchVal;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        }
      })(${JSON.stringify(kw)})`);
      await sleep(2000);
    }

    // 4. Select candidate product row and click Next
    await this.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('tr.product-tb-row, tbody tr, [role="row"], div[class*="product" i]'));
      if (rows.length > 0) {
        const target = rows[0];
        const radio = target.querySelector('input[type="radio"], input[type="checkbox"], button');
        if (radio) radio.click();
        else target.click();
      }
    })()`);
    await sleep(1000);

    // Click Next button
    await this.evaluate(`(() => {
      const nextBtn = Array.from(document.querySelectorAll('button')).find(b => !b.disabled && /^(tiếp|tiếp\\s*theo|next)$/i.test((b.innerText || '').trim()));
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

    return { ok: true, attached: true };
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
