"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { probeMedia } = require("./services/media-probe");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientCdpError(error) {
  const message = String(error?.message || error || "");
  return /Runtime\.evaluate timeout|CDP connection timeout|Cannot connect to Chrome|CDP socket|WebSocket|execution context|context was destroyed|cannot find default execution context|target closed|session closed/i.test(message);
}

function httpJson(url, timeout = 3000, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { timeout, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
    req.on("error", reject);
    req.end();
  });
}

function findChrome() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

class CDP {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async connect() {
    if (typeof WebSocket !== "function") throw new Error("Electron runtime does not provide WebSocket");
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.url);
    this.ws = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 8000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Cannot connect to Chrome")); }, { once: true });
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message.id) {
        const listeners = this.listeners.get(message.method) || [];
        listeners.slice().forEach((listener) => listener(message.params || {}));
        return;
      }
      if (!this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
    socket.addEventListener("close", () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.rejectPending(new Error("CDP socket closed"));
    });
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  once(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const listener = (params) => {
        clearTimeout(timer);
        const listeners = this.listeners.get(method) || [];
        this.listeners.set(method, listeners.filter((item) => item !== listener));
        resolve(params);
      };
      const timer = setTimeout(() => {
        const listeners = this.listeners.get(method) || [];
        this.listeners.set(method, listeners.filter((item) => item !== listener));
        reject(new Error(`${method} timeout`));
      }, timeout);
      this.listeners.set(method, [...(this.listeners.get(method) || []), listener]);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("CDP socket is not connected"));
        return;
      }
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.exception?.value || result.exceptionDetails.text || "Browser evaluation failed");
    return result.result ? result.result.value : undefined;
  }
  async recover() {
    this.close();
    await delay(500);
    await this.connect();
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }
  close() {
    const socket = this.ws;
    this.ws = null;
    this.rejectPending(new Error("CDP socket closed"));
    try { socket && socket.close(); } catch {}
  }
}

class MuseController {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.downloadDir = options.downloadDir;
    this.port = options.port || 9224;
    this.log = options.log || (() => {});
    this.chrome = null;
    this.hidden = false;
    this.windowSequence = 0;
    this._ensureChromePromise = null;
    this._nativeHideTimer = null;
    this._claimedDownloadPaths = new Set();
  }

  _withOpenTabLock(fn) {
    // Every job owns a distinct target/client, so opening windows concurrently
    // is safe and avoids serialising the full page-load time for the batch.
    return Promise.resolve().then(fn);
  }

  _withSendLock(fn) {
    // File chooser interception is target-scoped. Keep image + prompt atomic
    // inside each job, but do not block unrelated Muse windows.
    return Promise.resolve().then(fn);
  }

  async ensureChrome() {
    if (this._ensureChromePromise) return this._ensureChromePromise;
    this._ensureChromePromise = this._ensureChrome();
    try { return await this._ensureChromePromise; }
    finally { this._ensureChromePromise = null; }
  }

  async _ensureChrome() {
    try {
      await httpJson(`http://127.0.0.1:${this.port}/json/version`, 1000);
      return;
    } catch {}
    const binary = findChrome();
    if (!binary) throw new Error("Không tìm thấy Google Chrome hoặc Microsoft Edge");
    const profile = path.join(this.dataDir, `chrome-profile-${this.port}`);
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "https://muse.ai/"
    ];
    this.chrome = spawn(binary, args, { detached: false, windowsHide: false, stdio: "ignore" });
    this.log("Đã mở Chrome profile riêng cho Muse.ai");
    for (let i = 0; i < 30; i++) {
      await delay(500);
      try { await httpJson(`http://127.0.0.1:${this.port}/json/version`, 1000); return; } catch {}
    }
    throw new Error("Chrome không mở được cổng điều khiển");
  }

  _runPowerShell(script, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let errorOutput = "";
      const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("Windows visibility command timeout")); }, timeoutMs);
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { errorOutput += chunk; });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output.trim());
        else reject(new Error(errorOutput.trim() || `PowerShell exit ${code}`));
      });
    });
  }

  async _setNativeChromeWindowsVisible(visible) {
    if (process.platform !== "win32") return 0;
    const port = Math.max(1, Number(this.port) || 19324);
    const script = `$ErrorActionPreference='Stop'\n` +
      `$token='--remote-debugging-port=${port}'\n` +
      `$ids=@(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like \"*$token*\" } | ForEach-Object { [int]$_.ProcessId })\n` +
      `if($ids.Count -eq 0){Write-Output 0;exit 0}\n` +
      `Add-Type -TypeDefinition @'\n` +
      `using System;\nusing System.Runtime.InteropServices;\npublic static class MuseWindowVisibility {\n` +
      `  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);\n` +
      `  [DllImport(\"user32.dll\")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);\n` +
      `  [DllImport(\"user32.dll\")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\n` +
      `  [DllImport(\"user32.dll\")] private static extern bool ShowWindow(IntPtr hWnd, int cmd);\n` +
      `  public static int Apply(int[] ids, bool visible) { int count=0; EnumWindows(delegate(IntPtr h, IntPtr l) { uint pid; GetWindowThreadProcessId(h,out pid); if(Array.IndexOf(ids,(int)pid)>=0){ShowWindow(h,visible?9:0);count++;} return true; },IntPtr.Zero); return count; }\n` +
      `}\n'@\n` +
      `$count=[MuseWindowVisibility]::Apply([int[]]$ids,${visible ? "$true" : "$false"})\nWrite-Output $count`;
    const result = await this._runPowerShell(script);
    return Number.parseInt(result, 10) || 0;
  }

  _scheduleNativeHide() {
    if (!this.hidden || process.platform !== "win32") return;
    clearTimeout(this._nativeHideTimer);
    this._nativeHideTimer = setTimeout(() => { this._setNativeChromeWindowsVisible(false).catch(() => {}); }, 300);
  }

  async pageClient() {
    await this.ensureChrome();
    const targets = await httpJson(`http://127.0.0.1:${this.port}/json/list`);
    let target = targets.find((item) => item.type === "page" && /muse\.ai/i.test(item.url || ""));
    if (!target) {
      target = await httpJson(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent("https://muse.ai/")}`, 5000, "PUT");
      await delay(1500);
    }
    const client = new CDP(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: this.downloadDir }).catch(() => {});
    return { client, target };
  }

  async status() {
    const { client } = await this.pageClient();
    try {
      return await client.evaluate(`(async()=>{try{const r=await fetch('https://muse.ai/api/session',{credentials:'include'});const d=await r.json().catch(()=>({}));return {ok:r.ok,status:r.status,session:d,url:location.href,title:document.title};}catch(e){return {ok:false,error:String(e),url:location.href};}})()`);
    } finally { client.close(); }
  }

  async openFreshThread() {
    return this._withOpenTabLock(async () => {
      await this.ensureChrome();
      const version = await httpJson(`http://127.0.0.1:${this.port}/json/version`, 5000);
      const browserClient = new CDP(version.webSocketDebuggerUrl);
      await browserClient.connect();
      let targetId = "";
      try {
        // Open the dedicated thread window in the background. Showing /thread/new
        // before the composer is ready creates the blank white windows users saw.
        const created = await browserClient.send("Target.createTarget", { url: "https://muse.ai/thread/new", newWindow: true, background: true });
        targetId = created.targetId || "";
      } catch (error) {
        browserClient.close();
        throw new Error(`Không tạo được cửa sổ Chrome riêng: ${error.message}`);
      }
      let target = null;
      for (let i = 0; i < 30; i++) {
        const targets = await httpJson(`http://127.0.0.1:${this.port}/json/list`, 5000);
        target = targets.find((item) => item.id === targetId || item.targetId === targetId);
        if (target?.webSocketDebuggerUrl) break;
        await delay(200);
      }
      if (!target?.webSocketDebuggerUrl) { browserClient.close(); throw new Error("Không tìm thấy tab trong cửa sổ Chrome mới"); }
      const client = new CDP(target.webSocketDebuggerUrl);
      await client.connect();
      await client.send("Runtime.enable");
      await client.send("Page.enable");
      await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: this.downloadDir }).catch(() => {});
      client.targetId = targetId;
      try {
        const initialWindow = await browserClient.send("Browser.getWindowForTarget", { targetId });
        client.windowId = initialWindow.windowId;
        await browserClient.send("Browser.setWindowBounds", { windowId: initialWindow.windowId, bounds: { windowState: "minimized" } });
      } catch {}
      this._scheduleNativeHide();
      let readyState = null;
      for (let i = 0; i < 120; i++) {
        try {
          readyState = await client.evaluate(`({url:location.href,path:location.pathname,hasComposer:!!document.querySelector('[data-hatch-composer-chrome="true"] textarea,textarea[aria-label="Message"],textarea[placeholder="Message"]'),bodyReady:!!document.body})`);
          if (/^\/thread\//.test(readyState?.path || "") && readyState?.hasComposer) break;
        } catch (error) {
          if (!isTransientCdpError(error)) throw error;
          await client.recover().catch(() => {});
        }
        await delay(500);
        if (i === 119) { browserClient.close(); client.close(); throw new Error("Muse chưa tải xong ô Message trong Side chat mới"); }
      }
      browserClient.close();
      return client;
    });
  }

  async revealThreadWindow(client) {
    if (this.hidden || !client?.targetId) return;
    let browserClient;
    try {
      const version = await httpJson(`http://127.0.0.1:${this.port}/json/version`, 5000);
      browserClient = new CDP(version.webSocketDebuggerUrl);
      await browserClient.connect();
      const screen = await client.evaluate(`({width:screen.availWidth||1920,height:screen.availHeight||1040})`);
      const cols = screen.width >= 1500 ? 3 : 2;
      const rows = screen.height >= 850 ? 2 : 1;
      const slot = this.windowSequence++ % (cols * rows);
      const width = Math.floor(screen.width / cols);
      const height = Math.floor(screen.height / rows);
      const windowInfo = await browserClient.send("Browser.getWindowForTarget", { targetId: client.targetId });
      await browserClient.send("Browser.setWindowBounds", { windowId: windowInfo.windowId, bounds: { left: (slot % cols) * width, top: Math.floor(slot / cols) * height, width, height, windowState: "normal" } });
    } catch {}
    finally { browserClient?.close(); }
  }

  isFashionTryOn(job = {}) {
    if (!job.characterImage) return false;
    if (String(job.mode || '').toLowerCase() === 'fashion') return true;
    const text = String(job.prompt || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const signals = [
      "virtual try-on", "virtual try on", "try-on", "try on", "outfit", "clothing", "garment",
      "fashion model", "wear this", "wearing the", "change clothes", "replace the clothes",
      "thay do", "thu do", "thay trang phuc", "trang phuc", "quan ao", "thoi trang",
      "cho mau mac", "cho nhan vat mac", "mac len nguoi", "mac bo do", "mac ao", "mac quan",
      "mac vay", "mac dam", "ao khoac", "ao so mi", "ao thun", "quan jean", "quan tay",
      "vay lien", "dam lien"
    ];
    return text.includes("fashion_try_on_mode") || signals.some((signal) => text.includes(signal));
  }

  isAcrylicBoxScene(job = {}) {
    const text = String(job.prompt || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const hasBox = text.includes("hop mica") || text.includes("mica/acrylic") || text.includes("acrylic box") || text.includes("acrylic case");
    const hasPresenter = text.includes("ban tay") || text.includes("cam quai") || text.includes("hand") || text.includes("present");
    return hasBox && hasPresenter;
  }

  buildVideoPrompt(job) {
    const seconds = parseInt(job.duration, 10) || 8;
    const aspect = job.aspect || "9:16";
    const quality = job.quality || "1K";
    const resolution = quality === "4K" ? "4K Ultra HD 2160p" : quality === "2K" ? "2K QHD 1440p" : "1K high definition";
    const fashionTryOn = this.isFashionTryOn(job);
    const acrylicBoxScene = !fashionTryOn && this.isAcrylicBoxScene(job);
    const identity = job.characterImage
      ? fashionTryOn
        ? " Strictly preserve the exact face, hairstyle, hair color, skin tone, body shape, body proportions and identity from the CHARACTER REFERENCE. Do NOT preserve that person's original clothing."
        : " Strictly preserve the exact face, hair, clothing, and identity shown in the attached character reference image."
      : "";
    const phase1 = Math.max(1, Math.round(seconds * 0.25));
    const phase2 = Math.max(phase1 + 1, Math.round(seconds * 0.5));
    const phase3 = Math.max(phase2 + 1, Math.round(seconds * 0.75));
    const fashionEntrances = [
      "Enter from frame-left with two diagonal steps toward center.",
      "Enter from frame-right with two measured runway steps.",
      "Begin centered, step backward once and forward once.",
      "Begin in a side profile and take two lateral steps toward center.",
      "Begin facing front, walk two steps away, then return one step toward camera."
    ];
    const fashionTurns = [
      "Turn 35 degrees left and finish in a front three-quarter pose.",
      "Pivot 40 degrees right, briefly show the side fit, then return near-front.",
      "Rotate slowly from side profile to front without repeating the starting pose.",
      "Cross one foot naturally and make a controlled half-turn before settling."
    ];
    const fashionGestures = [
      "The single free hand smooths the waistband once.",
      "The single free hand adjusts one cuff once.",
      "The single free hand briefly touches the outer pocket, then relaxes.",
      "The single free hand releases the top or trouser hem once, then rests at the waist."
    ];
    const fashionCameras = [
      "The camera tracks right with clear background parallax.",
      "The camera tracks left at waist height.",
      "The camera makes a gentle right arc while keeping the full body visible.",
      "The camera performs a small smooth dolly-in only during the final pose.",
      "The camera makes a slow left arc and ends on a full-body hero frame."
    ];
    const fashionVariationCount = 20;
    const variationKey = String(job.id || job.requestToken || job.productImage || Date.now());
    const hashedVariation = [...variationKey].reduce((sum, ch) => ((sum * 31) + ch.charCodeAt(0)) >>> 0, 0) % fashionVariationCount;
    const variationIndex = Number.isFinite(Number(job.motionVariant)) ? Math.abs(Number(job.motionVariant)) % fashionVariationCount : hashedVariation;
    const fashionVariation = `${fashionEntrances[variationIndex % fashionEntrances.length]} ${fashionTurns[Math.floor(variationIndex / fashionEntrances.length) % fashionTurns.length]} ${fashionGestures[(variationIndex * 3) % fashionGestures.length]} ${fashionCameras[(variationIndex * 2) % fashionCameras.length]}`;
    const stitching = seconds > 10 ? `\n\n[YÊU CẦU BẮT BUỘC VỀ ĐỘ DÀI ${seconds} GIÂY & LỆNH GHÉP VIDEO HOÀN CHỈNH / MANDATORY MULTI-CLIP & FFMPEG STITCHING]:\nVì mỗi đoạn video đơn lẻ có thể chỉ dài tối đa 5–10 giây, bạn BẮT BUỘC thực hiện đầy đủ hai bước:\n1. Chia kịch bản thành các phân cảnh nối tiếp mượt mà, tạo đủ các clip thành phần để tổng thời lượng là ${seconds} giây. Giữ bối cảnh, ánh sáng và sản phẩm nhất quán tuyệt đối giữa các clip.\n2. Sau khi tạo xong, dùng ffmpeg trong workspace để concatenate/stitch tất cả clip đúng thứ tự thành MỘT file MP4 hoàn chỉnh dài ${seconds} giây. Kiểm tra thời lượng và khung hình rồi chỉ đính kèm file cuối cùng tên final_stitched_${seconds}s.mp4.` : "";
    const requestToken = job.requestToken || `MVF-${Date.now()}`;
    const hardProductLock = fashionTryOn ? `[VIRTUAL TRY-ON ROLE MAP — HIGHEST PRIORITY]\n` +
      `There are two attached references with different roles. The FIRST attached image is the CHARACTER REFERENCE and supplies only the person's exact face, hairstyle, hair color, skin tone, body shape, body proportions and identity. The SECOND attached image is the OUTFIT REFERENCE and is immutable ground truth for the new clothing. Never swap these roles.\n` +
      `Dress the person in the COMPLETE outfit shown in the SECOND image. If it contains a top AND trousers/skirt/shorts, replace BOTH pieces together as one coordinated set; never replace only the top, only the bottom, or invent a substitute. If it contains layers, shoes, belt or visible accessories, reproduce every visible piece in the correct order. Preserve each garment's category, complete silhouette, fit, exact length and hem position, neckline, collar, sleeves, cuffs, waist, layers, fabric, texture, seams, pockets, buttons, fasteners, prints, logo, text, colors and every visible design detail. The trouser/skirt hem must stop at the same relative height as in the SECOND reference; never make it longer, shorter, wider or slimmer. Do not substitute a similar garment, redesign it, recolor it, add or remove pieces, or keep any visible part of the character's old outfit.\n` +
      `This is a real full-wardrobe replacement, not a pasted clothing sticker. Fit and drape the complete outfit naturally over the preserved body with correct anatomy, cloth folds, gravity and contact. Keep the face and body identity stable in every frame. Prevent cloth/body intersections, extra limbs, changing body size, changing garment length, changing patterns, disappearing pieces and wardrobe flicker. The outfit must remain the same complete set from first frame to last frame. Reject and regenerate any clip in which even one garment piece is missing, duplicated, merged incorrectly or different from the reference.\n` +
      `[ABSOLUTE TWO-ARM ANATOMY LOCK — HIGHEST PRIORITY]\nThe model has exactly TWO arms, TWO hands, TEN fingers and no other limb. One existing hand continuously holds the phone directly in front of the face; that phone-hand may follow the head but must never release, duplicate, split, swap sides or touch the clothes. Only the one remaining existing free hand may adjust the garment, and it may touch only one garment area at a time. Never create a third arm, third hand, floating hand, duplicated forearm, extra fingers, fused limbs, hidden replacement arm or hand emerging from the torso/clothing. Do not show both a phone-holding hand and two garment-adjusting hands. If any extra limb appears in any frame, reject and regenerate that clip before stitching.` : `[ABSOLUTE HARD PRODUCT LOCK — HIGHEST PRIORITY]\n` +
      `The attached PRODUCT REFERENCE image is immutable ground truth and the only source of truth for the product. Use its exact product pixels, cutout, label texture, logo texture and packaging appearance as the visual identity reference. Preserve its exact SKU, silhouette, width-to-height ratio, package shape, cap/lid, material, logo, brand name, label layout, printed text positions, icons, colors, patterns and visible details. Do not replace it with a similar product and do not redesign, beautify, stretch, elongate, slim, widen, mirror or morph it.\n` +
      `Treat every product unit as one rigid object with locked geometry. Rigid-body movement of the whole product, box or group is REQUIRED and allowed; deformation of the product is forbidden. The product may translate and turn naturally with the container, but its proportions and packaging identity must remain unchanged. Keep the main label readable for most of the shot and avoid heavy motion blur or long occlusion of the branding.\n` +
      `For multiple units, create exact clones of the SAME locked reference asset; never generate variations. Before accepting each clip, compare it against the attached reference. Reject and regenerate any clip with even one mismatch in logo, label, text placement, color, cap, shape or proportions. Do not include a mismatched clip in the final stitch.`;
    const motionPlan = fashionTryOn ? `[MANDATORY FASHION VIDEO MOTION — DO NOT MAKE AN ANIMATED STILL]\n` +
      `Create a genuinely filmed full-body fashion video, not one generated still with zoom, pan, parallax wobble or camera shake. The model must perform continuous, anatomically natural movement while the new outfit remains temporally consistent and visibly reacts to the body.\n` +
      `[JOB-SPECIFIC CHOREOGRAPHY ${variationIndex + 1}/${fashionVariationCount} — DO NOT SUBSTITUTE OR REUSE ANOTHER JOB'S MOTION]\n${fashionVariation}\n` +
      `Required timeline for the final ${seconds}-second video:\n` +
      `• 0–${phase1}s — Show the complete model from head to toe wearing the NEW outfit. The model takes a natural step into position and lightly adjusts a sleeve, collar, waist or hem so the garment visibly moves and drapes.\n` +
      `• ${phase1}–${phase2}s — The model turns the whole body 30–45 degrees to present the front and side fit. Arms and hands move naturally and never hide the outfit for long.\n` +
      `• ${phase2}–${phase3}s — The model walks at least two clear steps while the camera smoothly tracks laterally, creating obvious perspective change and realistic fabric motion.\n` +
      `• ${phase3}–${seconds}s — The model turns back toward camera, changes pose and settles into a final full-body hero stance only at the end.\n` +
      `The model's body, arms, legs, hair and every garment piece must all show coherent motion. Show a visible pose, position or viewing-angle change every 1–2 seconds. Across separate clips, avoid reusing the exact same pose, camera angle or action; vary the walk direction, hand gesture, framing and background while preserving the identical complete outfit. No frozen section longer than 0.5 seconds, no repeated frames, no slideshow, no loop, no nearly-static output and no random shaking.` : `[MANDATORY REAL VIDEO MOTION — DO NOT MAKE AN ANIMATED STILL]\n` +
      `This must be a genuinely filmed-looking moving scene. Do NOT first create one still image and apply only a subtle Ken Burns zoom, tiny pan, parallax wobble, breathing effect or camera shake. Do NOT hold the same composition for the whole clip. A viewer must see clear physical action and a clearly changing viewpoint without comparing individual frames.\n` +
      `Required timeline for the final ${seconds}-second video:\n` +
      `• 0–${phase1}s — Establish the complete scene, then the hand visibly enters/repositions and securely grips the handle or product. The hand and foreground object must travel a noticeable distance.\n` +
      `• ${phase1}–${phase2}s — Perform the main action from the user's scene: visibly lift, carry, present, open, turn or rotate the whole rigid product/container by approximately 25–45 degrees. This is continuous object motion, not a still frame.\n` +
      `• ${phase2}–${phase3}s — Continue the action while the camera makes a smooth 10–20 degree lateral orbit or tracking move, producing obvious foreground/background parallax and revealing a genuinely different angle.\n` +
      `• ${phase3}–${seconds}s — Move into a final hero angle with a deliberate small push-in and let the hand/object settle naturally only during the final moment.\n` +
      `At least three elements must move independently: (1) hand/arm, (2) rigid product or its container as a whole, and (3) camera/background perspective. Show visible position or angle change every 1–2 seconds. No frozen section longer than 0.5 seconds, no repeated frames, no slideshow, no loop and no nearly-static output. Natural secondary motion and realistic contact physics are required. The motion must remain smooth and purposeful; do not use random shaking.`;
    const presenterPrivacy = acrylicBoxScene ? `[ABSOLUTE PRESENTER PRIVACY LOCK — NEVER REVEAL THE FACE]\n` +
      `The person holding the acrylic/mica box is an anonymous presenter. Frame that person from the neck or shoulders downward only. The presenter's complete face, eyes, nose, mouth and identifying facial features must remain outside the frame for the entire video. Do not tilt, pan, orbit, zoom out or cut to any angle that reveals the face. Do not reveal the face in mirrors, glass, polished shelves, acrylic reflections, shadows or background screens. If camera or hand motion risks exposing the face, crop lower and keep only the hand, forearm, torso or shoulder visible. This privacy lock overrides every scene, composition and motion instruction.` : "";
    const consistencyRule = fashionTryOn
      ? "The user scene controls the setting and performance but never authorizes changing the preserved person or the locked new outfit. Preserve realistic lighting, anatomy, garment fit, temporal consistency and no wardrobe flicker."
      : "The scene description controls the setting and action but never authorizes changing the locked product. Preserve realistic lighting, stable product geometry, smooth temporal continuity and no flicker.";
    return `[FRESH PRODUCTION REQUEST: ${requestToken}]\nThis is a NEW production run. You MUST generate a brand-new video from the attached images now. Do not reuse, reattach, copy, reference, or return any video/artifact from an earlier chat or previous run, even when the product and prompt look identical.\n\n${hardProductLock}\n\n${presenterPrivacy ? `${presenterPrivacy}\n\n` : ""}${motionPlan}\n\nCreate one complete ${seconds}-second video (aspect ratio ${aspect}, exact total duration ${seconds}s, resolution ${resolution}, photorealistic, high detail).${identity}\n\n[USER SCENE — APPLY THIS CONTENT WHILE OBEYING THE REFERENCE AND MOTION RULES ABOVE]\n${job.prompt}\n\n${consistencyRule}${stitching}\n\n[VIDEO OUTPUT ONLY — NO INTERMEDIATE IMAGE RESPONSE]\nUse Muse video generation immediately. Do not stop after creating a lock image, keyframe, preview, still image, caption, plan, explanation or confirmation question. A still image is not a valid result. Generate the moving clips and final MP4 in this same response.\n\nDo not explain, plan or return text only. Actually generate the new moving video now and attach the final playable MP4 for request ${requestToken}. Before finishing, verify that the MP4 contains obvious physical movement throughout and is not an animated still image.`;
  }

  imageItem(filePath, role) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return { filePath: path.resolve(filePath), mime, name: path.basename(filePath), role };
  }

  async composerState(client, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await client.evaluate(String.raw`(()=>{
          const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
          const box=document.querySelector('[data-hatch-composer-chrome="true"]')||document.querySelector('footer');
          if(!box)return {ready:false,count:0,hasAttachment:false,uploading:false,chars:0,hasSend:false};
          const text=box.innerText||'';
          const uploading=/uploading|đang tải|đang tải lên|processing attachment/i.test(text);
          const images=[...box.querySelectorAll('img')].filter(img=>visible(img)&&img.src&&!img.getAttribute('aria-hidden')&&(img.complete||img.naturalWidth>0)&&img.getBoundingClientRect().width>=24&&img.getBoundingClientRect().height>=24);
          const removes=[...box.querySelectorAll('button[aria-label*="Remove" i],button[aria-label*="xóa" i],[data-testid*="remove" i]')].filter(visible);
          const cards=[...box.querySelectorAll('[data-testid*="attachment" i],[data-testid*="upload-preview" i],[class*="attachment" i]')].filter(visible);
          const count=Math.max(images.length,removes.length);
          const input=box.querySelector('textarea[aria-label="Message"],textarea[placeholder="Message"],[data-hatch-composer-prehydration-input="true"],textarea');
          const send=box.querySelector('[data-testid="hatch-composer-send-button"],button[aria-label="Send"],button[aria-label*="send" i],button[aria-label*="gửi" i]');
          return {ready:!!input,count,hasAttachment:count>0||cards.length>0,uploading,chars:(input?.value||'').trim().length,hasSend:!!(send&&!send.disabled)};
        })()`);
      } catch (error) {
        lastError = error;
        if (!isTransientCdpError(error) || attempt >= attempts) throw error;
        await client.recover().catch(() => {});
        await delay(1000 * attempt);
      }
    }
    throw lastError;
  }

  async attachImages(client, fileItems) {
    if (!fileItems.length) return;
    const files = fileItems.map((item) => item.filePath);
    await client.send("Page.bringToFront").catch(() => {});
    await client.send("DOM.enable").catch(() => {});
    await client.send("Page.setInterceptFileChooserDialog", { enabled: true });

    let chooserBackendNodeId = null;
    const chooserPromise = client.once("Page.fileChooserOpened", 8000).then((c) => c?.backendNodeId).catch(() => null);

    const clicked = await client.evaluate(`(()=>{
      const box = document.querySelector('[data-hatch-composer-chrome="true"]') || document.querySelector('footer') || document;
      let button = box?.querySelector('button[aria-label="Attach file"],button[aria-label*="attach" i],button[aria-label*="đính kèm" i],button[aria-label*="Tải lên" i],button[aria-label*="upload" i],button[data-testid*="attach" i],button[data-testid*="upload" i]');
      if (!button) {
        const buttons = [...(box?.querySelectorAll('button') || [])];
        button = buttons.find(b => {
          const label = (b.getAttribute('aria-label') || b.title || b.innerText || '').toLowerCase();
          return !/send|gửi|stop|dừng|mic/i.test(label);
        });
      }
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error("Không tìm thấy nút đính kèm cạnh ô Message");

    chooserBackendNodeId = await chooserPromise;

    if (!chooserBackendNodeId) {
      try {
        const root = await client.send("DOM.getDocument");
        const node = await client.send("DOM.querySelector", { nodeId: root.root.nodeId, selector: 'input[type="file"]' });
        if (node?.nodeId) {
          const desc = await client.send("DOM.describeNode", { nodeId: node.nodeId });
          chooserBackendNodeId = desc.node?.backendNodeId;
        }
      } catch (e) {}
    }

    if (!chooserBackendNodeId) {
      await client.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      throw new Error("Muse không mở hộp chọn ảnh");
    }

    await client.send("DOM.setFileInputFiles", { backendNodeId: chooserBackendNodeId, files });
    await client.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});

    for (let i = 0; i < 100; i++) {
      const ready = await this.composerState(client);
      const enough = fileItems.length === 1 ? ready.hasAttachment : ready.count >= fileItems.length;
      if (enough && !ready.uploading) {
        await delay(250);
        return;
      }
      await delay(250);
    }
    throw new Error("Muse chưa hiển thị đầy đủ ảnh tham chiếu trong ô Message; prompt chưa được gửi");
  }

  async sendPrompt(client, prompt, fileItems = []) {
    let last = { chars: 0 };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const prepared = await client.evaluate(`(()=>{
        const input=document.querySelector('textarea[aria-label="Message"],textarea[placeholder="Message"],[data-hatch-composer-prehydration-input="true"],textarea');
        if(!input)return {ok:false,err:'Không tìm thấy đúng textarea Message của Muse'};
        input.focus();
        try {
          const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set;
          if(setter)setter.call(input,${JSON.stringify(prompt)});
          else input.value=${JSON.stringify(prompt)};
          input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(prompt)}}));
          input.dispatchEvent(new Event('change',{bubbles:true}));
        }catch(e){}
        return {ok:true,valLen:(input.value||'').length};
      })()`);
      if (!prepared?.ok) throw new Error(prepared?.err || "Không chuẩn bị được ô prompt");

      if ((prepared.valLen || 0) < 10) {
        await client.evaluate(`(()=>{const input=document.querySelector('textarea[aria-label="Message"],textarea[placeholder="Message"]');if(input){input.focus();input.select();}})()`);
        await client.send("Input.insertText", { text: prompt });
      }
      await delay(200);

      last = await this.composerState(client);
      const requiredAttachments = fileItems.length;
      const enoughAttachments = requiredAttachments === 0 || (requiredAttachments === 1 ? last.hasAttachment : last.count >= requiredAttachments);
      if (!enoughAttachments || last.uploading) {
        const error = new Error(`Chưa xác nhận đủ ${requiredAttachments} ảnh trong ô Message; tuyệt đối chưa gửi prompt`);
        error.code = "MUSE_ATTACHMENT_MISSING";
        throw error;
      }

      if (last?.chars >= 10 && last?.hasSend) {
        const clicked = await client.evaluate(`(()=>{
          const send=document.querySelector('[data-testid="hatch-composer-send-button"],button[aria-label="Send"],button[aria-label*="send" i],button[aria-label*="gửi" i]');
          if(!send||send.disabled)return false;
          send.click();
          return true;
        })()`);
        if (clicked) {
          for (let i = 0; i < 20; i++) {
            await delay(200);
            const sent = await client.evaluate(`(()=>{const box=document.querySelector('[data-hatch-composer-chrome="true"]')||document.querySelector('footer');const input=box?.querySelector('textarea[aria-label="Message"],textarea[placeholder="Message"],textarea');const stop=document.querySelector('[data-testid="hatch-composer-stop-button"],button[aria-label*="Stop" i],button[aria-label*="Dừng" i]');return (input&&(input.value||'').trim().length===0)||!!stop;})()`);
            if (sent) {
              await delay(300);
              return;
            }
          }
          // The click has already happened. Do not retry and risk sending a
          // duplicate request; continue to the media watcher instead.
          return;
        }
      }
      await delay(400);
    }
    throw new Error(`Composer chưa sẵn sàng: prompt ${last?.chars || 0} ký tự`);
  }

  async agentState(client, options = {}) {
    const attempts = Math.max(1, Number(options.attempts) || 2);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await client.evaluate(`(()=>{
          const root=document.querySelector('main')||document.querySelector('[role="main"]')||document.body;
          const media=[];const seen=new Set();
          const add=(src,type,duration=0,name='',ready=true)=>{if(!src||seen.has(src))return;seen.add(src);media.push({src,type,duration,name,ready})};
          [...root.querySelectorAll('video:not([data-hatch-media-owner="avatar-layer"])')].forEach(v=>add(v.currentSrc||v.src||v.querySelector('source')?.src||'','video',Number.isFinite(v.duration)?v.duration:0,v.getAttribute('aria-label')||'',v.readyState>=2||Number.isFinite(v.duration)&&v.duration>0));
          [...root.querySelectorAll('[data-hatch-video-src]')].forEach(el=>add(el.getAttribute('data-hatch-video-src')||'','video',0,el.getAttribute('aria-label')||'',true));
          [...root.querySelectorAll('a[href],source[src]')].forEach(el=>{const src=el.href||el.src||'';const lower=src.toLowerCase();const clean=lower.split('?')[0].split('#')[0];if(clean.endsWith('.mp4')||clean.endsWith('.webm')||lower.includes('video')||lower.includes('deliverable')||lower.includes('artifact'))add(src,'video',0,el.textContent||'',true)});
          [...root.querySelectorAll('[data-testid="hatch-chat-attachment-presentation-image"]')].forEach(card=>{const img=card.querySelector('img:not([aria-hidden="true"])');add(img&&(img.currentSrc||img.src)||'','image',0,img?.alt||'',true)});
          const composer=document.querySelector('[data-hatch-composer-chrome="true"]');
          const busy=!!composer?.querySelector('[data-testid="hatch-composer-stop-button"],button[aria-label*="Stop" i],button[aria-label*="Dừng" i],[role="progressbar"],[data-testid*="loading" i]');
          const chatText=(root.innerText||'').trim();
          return {media,busy,status:chatText.slice(-500),tail:chatText.slice(-1800)};
        })()`);
      } catch (error) {
        lastError = error;
        if (!isTransientCdpError(error) || attempt >= attempts) throw error;
        options.onTransient?.(error, attempt);
        await client.recover().catch(() => {});
        await delay(1500 * attempt);
      }
    }
    throw lastError;
  }

  async waitForMedia(client, type, baseline, timeoutMs, onProgress, range, control = {}) {
    const started = Date.now();
    let candidate = null;
    let stable = 0;
    let transientFailures = 0;
    let stillImageCorrectionSent = false;
    const imageBaseline = control.imageBaseline instanceof Set ? control.imageBaseline : new Set();
    while (Date.now() - started < timeoutMs) {
      if (control.isCancelled?.()) { const error = new Error("Đã dừng theo yêu cầu"); error.code = "MUSE_STOPPED"; throw error; }
      await control.waitIfPaused?.();
      let state;
      try {
        state = await this.agentState(client, { attempts: 2 });
        transientFailures = 0;
      } catch (error) {
        if (!isTransientCdpError(error)) throw error;
        transientFailures += 1;
        const elapsed = (Date.now() - started) / timeoutMs;
        const progress = Math.round(range[0] + (range[1] - range[0]) * Math.min(.92, elapsed));
        onProgress(progress, `Muse vẫn đang xử lý · đang nối lại Chrome (lần ${transientFailures})`);
        await client.recover().catch(() => {});
        await delay(Math.min(10000, 2000 * transientFailures));
        continue;
      }
      if (/about what\?|make a space|create a space|topic in a sentence/i.test(state.tail)) throw new Error("Muse mở nhầm chế độ Space; hãy chạy lại luồng trong Side chat mới");
      if (/giới hạn (tạo )?video.*reset|hạn mức.*reset|video (generation )?limit|video quota|try again when.*reset|khi .*reset.*video/i.test(state.tail)) throw new Error("Tài khoản Muse đã chạm giới hạn tạo video; Muse chỉ tạo ảnh khóa và chưa thể render MP4. Hãy đợi hạn mức video reset hoặc đổi tài khoản Muse.");
      if (/out of credits|hết lượt|hết credit|đạt giới hạn|额度不足|积分不足/i.test(state.tail)) throw new Error("Tài khoản Muse đã hết lượt/credit");
      const fresh = state.media.filter((item) => item.type === type && !baseline.has(item.src));
      if (fresh.length) {
        candidate = fresh[fresh.length - 1];
        stable += 1;
        const expectedSeconds = Math.max(0, Number(control.expectedSeconds) || 0);
        const hasExpectedDuration = expectedSeconds > 0 && Number(candidate.duration) >= expectedSeconds - 0.75;
        const looksFinal = /final|stitched|complete|hoàn chỉnh/i.test(candidate.name || "");
        // Muse may leave the generic busy flag active after the final file is
        // already present. Duration/name are stronger completion evidence,
        // while the check still avoids downloading an intermediate 5–10s clip.
        if (hasExpectedDuration || looksFinal || (!state.busy && stable >= 1)) return candidate;
      } else {
        stable = 0;
        const freshImages = state.media.filter((item) => item.type === "image" && !imageBaseline.has(item.src));
        if (type === "video" && freshImages.length && !state.busy && !stillImageCorrectionSent) {
          freshImages.forEach((item) => imageBaseline.add(item.src));
          stillImageCorrectionSent = true;
          onProgress(Math.max(range[0], 20), "Muse mới trả ảnh tĩnh · đang yêu cầu chuyển ngay sang tạo video");
          const correction = `[CONTINUE VIDEO NOW: ${control.requestToken || "CURRENT REQUEST"}] The image above is only an intermediate keyframe and is NOT the requested deliverable. Do not create another image, caption, explanation, plan or question. Immediately use Muse video generation to animate that exact locked image according to the previously assigned choreography, generate all required moving clips, stitch them into the exact requested duration, and attach only the final playable MP4. Preserve exactly two arms and two hands; the phone-hand keeps covering the face and only the other hand may adjust clothing.`;
          await this.sendPrompt(client, correction, []);
          await delay(1000);
          continue;
        }
      }
      const elapsed = (Date.now() - started) / timeoutMs;
      const progress = Math.round(range[0] + (range[1] - range[0]) * Math.min(.92, elapsed));
      const elapsedMinutes = Math.max(1, Math.round((Date.now() - started) / 60000));
      onProgress(progress, `${type === "image" ? "Muse đang dựng ảnh sản phẩm" : "Muse đang render video"} · ${elapsedMinutes} phút`);
      await delay(2000);
    }
    if (candidate) return candidate;
    throw new Error(`Hết thời gian chờ Muse tạo ${type === "image" ? "ảnh" : "video"}`);
  }

  async _verifyDownloadedMedia(filePath, expectedSeconds = 0) {
    if (!fs.existsSync(filePath)) throw new Error("File video tải về không tồn tại");
    const size = fs.statSync(filePath).size;
    if (size < 100 * 1024) throw new Error(`File video tải về quá nhỏ (${size} byte)`);
    const info = await probeMedia(filePath);
    if (!info.hasVideo || !info.durationSeconds) throw new Error("File tải về không phải video MP4 hợp lệ");
    if (expectedSeconds > 0 && info.durationSeconds < expectedSeconds - 1.25) {
      throw new Error(`Muse mới tạo video ${info.durationSeconds.toFixed(1)} giây, chưa đủ ${expectedSeconds} giây`);
    }
    return info;
  }

  async downloadFromPage(client, mediaUrl, baseName, fallbackType, onProgress = () => {}, options = {}) {
    const ext = String(fallbackType || "").includes("video") ? ".mp4" : String(fallbackType || "").includes("png") ? ".png" : String(fallbackType || "").includes("webp") ? ".webp" : ".jpg";
    const isVideo = String(fallbackType || "").includes("video");
    const expectedSeconds = Math.max(0, Number(options.expectedSeconds) || 0);
    const safe = String(baseName || "muse-result").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0, 90);
    const filePath = path.join(this.downloadDir, `${safe}-${Date.now()}${ext}`);
    const partialPath = `${filePath}.part`;

    // Fast path: Muse normally exposes a signed HTTPS media URL. Stream it
    // straight to disk without copying the whole file through page JavaScript.
    if (/^https?:/i.test(mediaUrl)) {
      try {
        onProgress("Đang tải MP4 trực tiếp từ Muse");
        const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(180000) });
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !response.body || (!/video|octet-stream/i.test(contentType) && !/\.(mp4|webm)(\?|$)/i.test(mediaUrl))) throw new Error(`HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partialPath));
        if (!fs.existsSync(partialPath) || fs.statSync(partialPath).size < 1024) throw new Error("File tải về rỗng");
        fs.renameSync(partialPath, filePath);
        if (isVideo) await this._verifyDownloadedMedia(filePath, expectedSeconds);
        return filePath;
      } catch (error) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
        try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch {}
      }
    }

    // Session/blob path: let Chrome's native downloader write the file. This
    // keeps cookies and avoids the very slow Base64/CDP chunk loop.
    const downloadScope = String(options.requestToken || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-z0-9_-]/gi, "-").slice(0, 120);
    const nativeDownloadDir = path.join(this.downloadDir, ".inflight", downloadScope);
    try {
      onProgress("Đang tải MP4 bằng trình tải của Chrome");
      fs.mkdirSync(nativeDownloadDir, { recursive: true });
      await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: nativeDownloadDir }).catch(() => {});
      const startedAt = Date.now();
      const baseline = new Map(fs.readdirSync(nativeDownloadDir).map(name => {
        const p = path.join(nativeDownloadDir, name);
        try { const stat = fs.statSync(p); return [p, `${stat.size}:${stat.mtimeMs}`]; } catch { return [p, ""]; }
      }));
      const fileName = path.basename(filePath);
      const clicked = await client.evaluate(`(()=>{try{const a=document.createElement('a');a.href=${JSON.stringify(mediaUrl)};a.download=${JSON.stringify(fileName)};a.style.display='none';document.body.appendChild(a);a.click();setTimeout(()=>a.remove(),1000);return true}catch(e){return false}})()`);
      if (clicked) {
        const stableSizes = new Map();
        // Give Chrome one minute, then use the authenticated page-fetch
        // fallback below instead of leaving the job at 97% for three minutes.
        for (let i = 0; i < 120; i++) {
          const candidates = fs.readdirSync(nativeDownloadDir)
            .filter(name => /\.(mp4|webm)$/i.test(name))
            .map(name => path.join(nativeDownloadDir, name))
            .filter(candidate => {
              if (this._claimedDownloadPaths.has(candidate)) return false;
              try {
                const stat = fs.statSync(candidate);
                const signature = `${stat.size}:${stat.mtimeMs}`;
                return candidate === filePath || !baseline.has(candidate) || (baseline.get(candidate) !== signature && stat.mtimeMs >= startedAt - 2000);
              } catch { return false; }
            })
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

          for (const candidate of candidates) {
            const size = fs.statSync(candidate).size;
            const previous = stableSizes.get(candidate);
            stableSizes.set(candidate, { size, count: previous?.size === size ? (previous.count + 1) : 0 });
            if (size < 100 * 1024 || (stableSizes.get(candidate)?.count || 0) < 2) continue;
            try {
              if (isVideo) await this._verifyDownloadedMedia(candidate, expectedSeconds);
              this._claimedDownloadPaths.add(candidate);
              if (candidate !== filePath) fs.copyFileSync(candidate, filePath);
              if (isVideo) await this._verifyDownloadedMedia(filePath, expectedSeconds);
              try { fs.rmSync(nativeDownloadDir, { recursive: true, force: true }); } catch {}
              return filePath;
            } catch {}
          }
          if (i > 0 && i % 20 === 0) onProgress(98, "Chrome chưa trả file · chuyển sang tải trực tiếp có phiên đăng nhập");
          await delay(500);
        }
      }
    } catch {}

    try { fs.rmSync(nativeDownloadDir, { recursive: true, force: true }); } catch {}

    // Compatibility fallback for unusual Muse URLs only.
    onProgress("Đang dùng chế độ tải tương thích");
    const key = `dl_${Date.now()}`;
    const prepared = await client.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(mediaUrl)});if(!r.ok)return {ok:false,err:'HTTP '+r.status};const b=await r.blob();const bytes=new Uint8Array(await b.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));window[${JSON.stringify(key)}]=btoa(binary);return {ok:true,size:b.size,length:window[${JSON.stringify(key)}].length};}catch(e){return {ok:false,err:String(e)}}})()`);
    if (!prepared?.ok) throw new Error(`Không tải được media: ${prepared?.err || "unknown"}`);
    const parts = [];
    for (let offset = 0; offset < prepared.length; offset += 2000000) parts.push(await client.evaluate(`window[${JSON.stringify(key)}].slice(${offset},${offset + 2000000})`));
    await client.evaluate(`delete window[${JSON.stringify(key)}]`).catch(() => {});
    fs.writeFileSync(filePath, Buffer.from(parts.join(""), "base64"));
    if (isVideo) await this._verifyDownloadedMedia(filePath, expectedSeconds);
    return filePath;
  }

  async produceVideo(job, onProgress = () => {}, control = {}) {
    if (!job.productImage || !fs.existsSync(job.productImage)) throw new Error("Luồng chưa có ảnh sản phẩm hợp lệ");
    job.requestToken = `MVF-${job.id || "job"}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const client = await this.openFreshThread();
    let videoPrompt = "";
    let beforeVideo = new Set();
    let beforeImage = new Set();
    try {
      const checkpoint = async () => { if (control.isCancelled?.()) { const error = new Error("Đã dừng theo yêu cầu"); error.code = "MUSE_STOPPED"; throw error; } await control.waitIfPaused?.(); };
      await checkpoint();
      onProgress(5, "Đã mở tab Muse riêng cho luồng này");
      const fashionJob = this.isFashionTryOn(job);
      const refs = fashionJob
        ? [this.imageItem(job.productImage, "outfit"), ...(job.characterImage && fs.existsSync(job.characterImage) ? [this.imageItem(job.characterImage, "character")] : [])]
        : [this.imageItem(job.productImage, "product"), ...(job.characterImage && fs.existsSync(job.characterImage) ? [this.imageItem(job.characterImage, "character")] : [])];
      await this._withSendLock(async () => {
        await this.attachImages(client, refs);
        await checkpoint();
        // Snapshot every pre-existing artifact before the request is sent. A
        // repeated product must never make an older card look like new output.
        const initialMediaState = await this.agentState(client, { attempts: 4 });
        beforeVideo = new Set(initialMediaState.media.filter((m) => m.type === "video").map((m) => m.src));
        beforeImage = new Set(initialMediaState.media.filter((m) => m.type === "image").map((m) => m.src));
        videoPrompt = this.buildVideoPrompt(job);
        job.generatedPrompt = videoPrompt;
        onProgress(12, `Đã tải ${refs.length} ảnh tham chiếu · chuẩn bị prompt tự động`);
        try {
          await this.sendPrompt(client, videoPrompt, refs);
        } catch (error) {
          if (error.code !== "MUSE_ATTACHMENT_MISSING") throw error;
          onProgress(12, "Ảnh chưa nằm chắc trong ô Message · đang tải lại trước khi gửi");
          await this.attachImages(client, refs);
          await this.sendPrompt(client, videoPrompt, refs);
        }
      });
      onProgress(18, "Đã tự điền và gửi prompt hoàn chỉnh cho Muse");
      let requestVisible = false;
      for (let attempt = 0; attempt < 12 && !requestVisible; attempt++) {
        requestVisible = await client.evaluate(`(() => (document.body?.innerText || '').includes(${JSON.stringify(job.requestToken)}))()`).catch(() => false);
        if (!requestVisible) await delay(500);
      }
      if (!requestVisible) {
        throw new Error("Muse không xác nhận request token trong tab hiện tại; dừng để không lấy nhầm video từ tab khác.");
      }
      await this.revealThreadWindow(client);
      // Nhiều luồng Muse chạy đồng thời có thể nằm trong hàng render rất lâu.
      // 90 phút tránh đánh lỗi giả ở phút 20 trong khi Muse vẫn đang xử lý.
      const expectedSeconds = parseInt(job.duration, 10) || 0;
      const videoDeadline = Date.now() + 90 * 60 * 1000;
      let videoPath = "";
      let lastDownloadError = null;
      while (!videoPath && Date.now() < videoDeadline) {
        const remaining = Math.max(1000, videoDeadline - Date.now());
        const video = await this.waitForMedia(client, "video", beforeVideo, remaining, onProgress, [18, 94], { ...control, expectedSeconds, imageBaseline: beforeImage, requestToken: job.requestToken });
        onProgress(96, "Đã thấy ứng viên video · đang kiểm tra thời lượng và MP4");
        try {
          const modePrefix = job.mode === "fashion" ? "thoi-trang" : job.mode === "household" ? "gia-dung" : job.mode === "store" ? "cua-hang" : "video";
          videoPath = await this.downloadFromPage(client, video.src, `${modePrefix}-${path.parse(job.productImage).name}`, "video/mp4", (detail) => onProgress(97, detail), { expectedSeconds, requestToken: job.requestToken });
        } catch (error) {
          lastDownloadError = error;
          beforeVideo.add(video.src);
          onProgress(93, `${error.message} · tiếp tục chờ video hoàn chỉnh trên Muse`);
          await delay(1500);
        }
      }
      if (!videoPath) throw lastDownloadError || new Error("Muse chưa trả video MP4 hoàn chỉnh trong thời gian chờ");
      onProgress(100, "Hoàn tất và đã tải video về máy");
      this.log(`Hoàn tất ${path.basename(job.productImage)} → ${path.basename(videoPath)}`);
      return { videoPath, generatedPrompt: videoPrompt };
    } finally { client.close(); }
  }

  async submit(job) {
    const { client } = await this.pageClient();
    try {
      await client.send("Page.bringToFront");
      const instruction = job.mode === "video"
        ? `Create a ${job.duration || "8s"} video, ${job.aspect || "9:16"}, ${job.quality || "1K"}. ${job.prompt}`
        : job.mode === "image"
          ? `Create an image, aspect ratio ${job.aspect || "1:1"}. ${job.prompt}`
          : job.prompt;
      const payload = JSON.stringify({ mode: job.mode, text: instruction });
      const result = await client.evaluate(`(async()=>{
        const job=${payload};
        const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
        const visible=(el)=>!!(el&&el.getBoundingClientRect().width&&el.getBoundingClientRect().height);
        const allButtons=()=>Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
        const textOf=(el)=>(el.innerText||el.textContent||el.getAttribute('aria-label')||el.title||'').trim();
        const modeNames=job.mode==='video'?['muse-video','video']:job.mode==='image'?['muse-image','image']:['muse-spark','chat'];
        const exact=allButtons().find(b=>modeNames.some(n=>textOf(b).toLowerCase().includes(n)));
        if(exact){ exact.click(); await wait(600); }
        let input=Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')).filter(visible).pop();
        if(!input) return {ok:false,reason:'Không tìm thấy ô nhập prompt. Hãy mở trang chat Muse.ai rồi thử lại.'};
        input.focus();
        if(input.tagName==='TEXTAREA'||input.tagName==='INPUT'){
          const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set;
          if(setter) setter.call(input,job.text); else input.value=job.text;
        }else{
          input.textContent=job.text;
          input.innerHTML=''; input.appendChild(document.createTextNode(job.text));
        }
        input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:job.text}));
        input.dispatchEvent(new Event('change',{bubbles:true}));
        await wait(500);
        const sendRx=/send|submit|generate|create|gửi|tạo|go|arrow-up/i;
        let send=allButtons().filter(b=>!b.disabled).find(b=>sendRx.test(textOf(b)));
        if(!send){
          const form=input.closest('form');
          if(form) send=Array.from(form.querySelectorAll('button')).filter(visible).find(b=>!b.disabled);
        }
        if(send){send.click();return {ok:true,method:'button',button:textOf(send)};}
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
        input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
        return {ok:true,method:'enter'};
      })()`);
      if (!result || !result.ok) throw new Error(result?.reason || "Không gửi được prompt");
      this.log(`Đã gửi ${job.mode}: ${job.prompt.slice(0, 80)}`);
      return result;
    } finally { client.close(); }
  }

  async scanMedia() {
    const { client } = await this.pageClient();
    try {
      const links = await client.evaluate(`(()=>Array.from(new Set(Array.from(document.querySelectorAll('video[src],video source[src],img[src],a[href]')).map(el=>el.currentSrc||el.src||el.href).filter(u=>{const lower=String(u||'').toLowerCase();const clean=lower.split('?')[0].split('#')[0];return (lower.startsWith('http://')||lower.startsWith('https://'))&&(['.mp4','.webm','.png','.jpg','.jpeg','.webp'].some(ext=>clean.endsWith(ext))||['media','artifact','deliverable','generated'].some(h=>lower.includes(h)))}))))()`);
      const saved = [];
      for (const url of links || []) {
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const type = response.headers.get("content-type") || "";
          const ext = type.includes("video") ? ".mp4" : type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : ".jpg";
          const name = `muse-${Date.now()}-${saved.length + 1}${ext}`;
          fs.writeFileSync(path.join(this.downloadDir, name), Buffer.from(await response.arrayBuffer()));
          saved.push(name);
        } catch {}
      }
      this.log(`Quét media: lưu được ${saved.length} file mới`);
      return saved;
    } finally { client.close(); }
  }

  async setVisible(visible) {
    await this.ensureChrome();
    this.hidden = !visible;
    if (visible) await this._setNativeChromeWindowsVisible(true).catch(() => {});
    const version = await httpJson(`http://127.0.0.1:${this.port}/json/version`, 5000);
    const browserClient = new CDP(version.webSocketDebuggerUrl);
    await browserClient.connect();
    try {
      const targets = await httpJson(`http://127.0.0.1:${this.port}/json/list`, 5000);
      const windowIds = new Set();
      for (const target of targets.filter((item) => item.type === "page" && /muse\.ai/i.test(item.url || ""))) {
        try {
          const info = await browserClient.send("Browser.getWindowForTarget", { targetId: target.id || target.targetId });
          if (info?.windowId) windowIds.add(info.windowId);
        } catch {}
      }
      for (const windowId of windowIds) {
        await browserClient.send("Browser.setWindowBounds", { windowId, bounds: { windowState: visible ? "normal" : "minimized" } }).catch(() => {});
      }
      if (!visible) await this._setNativeChromeWindowsVisible(false);
      return true;
    } finally { browserClient.close(); }
  }
}

module.exports = { MuseController, isTransientCdpError };

