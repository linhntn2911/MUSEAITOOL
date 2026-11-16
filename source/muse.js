"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 8000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Cannot connect to Chrome")); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
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
  close() {
    try { this.ws && this.ws.close(); } catch {}
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
  }

  async ensureChrome() {
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
    await this.ensureChrome();
    const version = await httpJson(`http://127.0.0.1:${this.port}/json/version`, 5000);
    const browserClient = new CDP(version.webSocketDebuggerUrl);
    await browserClient.connect();
    let targetId = "";
    try {
      const created = await browserClient.send("Target.createTarget", { url: "https://muse.ai/", newWindow: true, background: false });
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
    try {
      const initialWindow = await browserClient.send("Browser.getWindowForTarget", { targetId });
      await browserClient.send("Browser.setWindowBounds", { windowId: initialWindow.windowId, bounds: { left: 0, top: 0, width: 1200, height: 850, windowState: "normal" } });
    } catch {}
    await delay(3000);
    const opened = await client.evaluate(`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<60;i++){const button=document.querySelector('[data-testid="hatch-chat-compose"],button[aria-label="New side chat"],button[title="New side chat"]');if(button){button.click();return {ok:true,method:'hatch-chat-compose'};}await wait(250);}return {ok:false};})()`);
    if (!opened?.ok) {
      await client.send("Page.navigate", { url: "https://muse.ai/thread/new" });
      await delay(1800);
    }
    for (let i = 0; i < 40; i++) {
      try {
        const ready = await client.evaluate(`({url:location.href,path:location.pathname,hasComposer:!!document.querySelector('textarea[aria-label="Message"],textarea[placeholder="Message"]')})`);
        if (/^\/thread\//.test(ready?.path || "") && ready?.hasComposer) break;
      } catch (error) {
        if (!/execution context|context was destroyed|cannot find default/i.test(error.message)) throw error;
      }
      await delay(250);
      if (i === 39) { browserClient.close(); client.close(); throw new Error("Muse không chuyển sang URL Side chat mới"); }
    }
    try {
      const screen = await client.evaluate(`({width:screen.availWidth||1920,height:screen.availHeight||1040})`);
      const cols = screen.width >= 1500 ? 3 : 2;
      const rows = screen.height >= 850 ? 2 : 1;
      const slot = this.windowSequence++ % (cols * rows);
      const width = Math.floor(screen.width / cols);
      const height = Math.floor(screen.height / rows);
      const windowInfo = await browserClient.send("Browser.getWindowForTarget", { targetId });
      await browserClient.send("Browser.setWindowBounds", { windowId: windowInfo.windowId, bounds: { left: (slot % cols) * width, top: Math.floor(slot / cols) * height, width, height, windowState: "normal" } });
    } catch {}
    browserClient.close();
    return client;
  }

  buildVideoPrompt(job) {
    const seconds = parseInt(job.duration, 10) || 8;
    const aspect = job.aspect || "9:16";
    const quality = job.quality || "1K";
    const resolution = quality === "4K" ? "4K Ultra HD 2160p" : quality === "2K" ? "2K QHD 1440p" : "1K high definition";
    const identity = job.characterImage ? " Strictly preserve the exact face, hair, clothing, and identity shown in the attached character reference image." : "";
    const stitching = seconds > 10 ? `\n\n[YÊU CẦU BẮT BUỘC VỀ ĐỘ DÀI ${seconds} GIÂY & LỆNH GHÉP VIDEO HOÀN CHỈNH / MANDATORY MULTI-CLIP & FFMPEG STITCHING]:\nVì mỗi đoạn video đơn lẻ có thể chỉ dài tối đa 5–10 giây, bạn BẮT BUỘC thực hiện đầy đủ hai bước:\n1. Chia kịch bản thành các phân cảnh nối tiếp mượt mà, tạo đủ các clip thành phần để tổng thời lượng là ${seconds} giây. Giữ bối cảnh, ánh sáng và sản phẩm nhất quán tuyệt đối giữa các clip.\n2. Sau khi tạo xong, dùng ffmpeg trong workspace để concatenate/stitch tất cả clip đúng thứ tự thành MỘT file MP4 hoàn chỉnh dài ${seconds} giây. Kiểm tra thời lượng và khung hình rồi chỉ đính kèm file cuối cùng tên final_stitched_${seconds}s.mp4.` : "";
    return `Please create a complete ${seconds}-second video (aspect ratio ${aspect}, total duration ${seconds}s, resolution ${resolution}, photorealistic, high detail), strictly preserve the exact appearance, logo, packaging, printed text, colors, proportions, and product details of the attached PRODUCT REFERENCE image.${identity}\n\nScene requirements from the user:\n${job.prompt}\n\nUse the attached product image as the mandatory visual reference. Show the exact same product throughout every frame; do not redesign, substitute, distort, or change the brand. Use natural camera and hand movement, stable product geometry, realistic lighting, and no flicker.${stitching}\n\nDo not merely explain the process. Actually create the video and attach the final playable MP4 result.`;
  }

  imageItem(filePath, role) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return { filePath: path.resolve(filePath), mime, name: path.basename(filePath), role };
  }

  async attachImages(client, fileItems) {
    if (!fileItems.length) return;
    const files = fileItems.map((item) => item.filePath);
    await client.send("Page.setInterceptFileChooserDialog", { enabled: true });
    const chooserPromise = client.once("Page.fileChooserOpened", 10000);
    const clicked = await client.evaluate(`(()=>{const box=document.querySelector('[data-hatch-composer-chrome="true"]');const button=box?.querySelector('button[aria-label="Attach file"],button[aria-label*="attach" i],button[aria-label*="đính kèm" i]');if(!button)return false;button.click();return true;})()`);
    if (!clicked) throw new Error("Không tìm thấy nút đính kèm cạnh ô Message");
    const chooser = await chooserPromise;
    if (!chooser?.backendNodeId) throw new Error("Muse không mở hộp chọn ảnh");
    await client.send("DOM.setFileInputFiles", { backendNodeId: chooser.backendNodeId, files });
    const expected = files.map((file) => path.basename(file));
    for (let i = 0; i < 60; i++) {
      const ready = await client.evaluate(`(()=>{const expected=${JSON.stringify(expected)};const box=document.querySelector('[data-hatch-composer-chrome="true"]');const text=box?.innerText||'';const images=[...(box?.querySelectorAll('img[alt]')||[])].map(img=>({alt:img.alt,src:img.currentSrc||img.src||'',complete:img.complete,naturalWidth:img.naturalWidth}));const names=new Set(images.filter(img=>img.src&&img.complete&&img.naturalWidth>0).map(img=>img.alt));const matched=expected.filter(name=>names.has(name));const clip=images[0]&&box.querySelector('img[alt]')?.closest('.overflow-clip');const clipHeight=clip?clip.getBoundingClientRect().height:0;return {matched:matched.length,images,removeButtons:box?.querySelectorAll('button[aria-label="Remove attachment"]').length||0,uploading:/uploading|đang tải|đang tải lên/i.test(text),clipHeight};})()`);
      if (ready.matched >= fileItems.length && ready.removeButtons >= fileItems.length && !ready.uploading && ready.clipHeight > 20) { await delay(1200); return; }
      await delay(750);
    }
    throw new Error("Muse chưa hiển thị đầy đủ ảnh tham chiếu trong ô Message; prompt chưa được gửi");
  }

  async sendPrompt(client, prompt, fileItems = []) {
    let last = { chars: 0 };
    const expected = fileItems.map((item) => path.basename(item.filePath));
    const baseline = await client.evaluate(`(()=>{const expected=${JSON.stringify(expected)};const composer=document.querySelector('[data-hatch-composer-chrome="true"]');return expected.map(name=>[...document.querySelectorAll('img[alt]')].filter(img=>img.alt===name&&!composer?.contains(img)).length);})()`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await client.evaluate(`(()=>{const expected=${JSON.stringify(expected)};const box=document.querySelector('[data-hatch-composer-chrome="true"]');const images=[...(box?.querySelectorAll('img[alt]')||[])];return {attachments:expected.filter(name=>images.some(img=>img.alt===name&&img.complete&&img.naturalWidth>0&&img.getBoundingClientRect().height>20)).length};})()`);
      if (fileItems.length && before.attachments < fileItems.length) await this.attachImages(client, fileItems);
      const prepared = await client.evaluate(`(()=>{const input=document.querySelector('textarea[aria-label="Message"],textarea[placeholder="Message"],[data-hatch-composer-prehydration-input="true"]');if(!input)return {ok:false,err:'Không tìm thấy đúng textarea Message của Muse'};input.focus();input.select();return {ok:true,tag:input.tagName};})()`);
      if (!prepared?.ok) throw new Error(prepared?.err || "Không chuẩn bị được ô prompt");
      await client.send("Input.insertText", { text: prompt });
      await delay(700 + attempt * 300);
      last = await client.evaluate(`(()=>{const expected=${JSON.stringify(expected)};const input=document.querySelector('textarea[aria-label="Message"],textarea[placeholder="Message"]');const box=document.querySelector('[data-hatch-composer-chrome="true"]');const value=(input?.value||'').trim();const images=[...(box?.querySelectorAll('img[alt]')||[])];const attachments=expected.filter(name=>images.some(img=>img.alt===name&&img.complete&&img.naturalWidth>0&&img.getBoundingClientRect().height>20)).length;const send=document.querySelector('[data-testid="hatch-composer-send-button"],button[aria-label="Send"],button[aria-label*="send" i],button[aria-label*="gửi" i]');return {chars:value.length,attachments,hasSend:!!(send&&!send.disabled),preview:value.slice(0,40)};})()`);
      const promptReady = last?.chars >= Math.min(80, Math.floor(prompt.length * 0.5));
      const filesReady = !fileItems.length || last?.attachments >= fileItems.length;
      if (promptReady && filesReady && last?.hasSend) {
        const clicked = await client.evaluate(`(()=>{const send=document.querySelector('[data-testid="hatch-composer-send-button"],button[aria-label="Send"],button[aria-label*="send" i],button[aria-label*="gửi" i]');if(!send||send.disabled)return false;send.click();return true;})()`);
        if (clicked) {
          for (let i = 0; i < 30; i++) {
            const delivered = await client.evaluate(`(()=>{const expected=${JSON.stringify(expected)},baseline=${JSON.stringify(baseline)};const composer=document.querySelector('[data-hatch-composer-chrome="true"]');return expected.every((name,index)=>[...document.querySelectorAll('img[alt]')].filter(img=>img.alt===name&&!composer?.contains(img)).length>(baseline[index]||0));})()`);
            if (!expected.length || delivered) { await delay(700); return; }
            await delay(300);
          }
          throw new Error("Muse đã nhận prompt nhưng không đính kèm ảnh vào tin nhắn; dừng luồng để tránh tạo sai sản phẩm");
        }
      }
      await delay(900);
    }
    throw new Error(`Composer chưa sẵn sàng: prompt ${last?.chars || 0} ký tự, ảnh ${last?.attachments || 0}/${fileItems.length}`);
  }

  async agentState(client) {
    return client.evaluate(`(()=>{const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left<innerWidth*.78};const bubbles=Array.from(document.querySelectorAll('div[class*="hatch-agent-bubble-bg"],[data-testid*="agent" i],[class*="assistant" i]')).filter(visible);const scope=bubbles.length?bubbles[bubbles.length-1]:(document.querySelector('main')||document.body);const media=[];const seen=new Set();const cards=[...document.querySelectorAll('[data-testid="hatch-chat-attachment-presentation-video"],[data-testid="hatch-chat-attachment-presentation-image"]')].filter(visible);cards.forEach(card=>{const v=card.querySelector('video:not([data-hatch-media-owner="avatar-layer"])');const img=card.querySelector('img:not([aria-hidden="true"])');const wrapper=card.querySelector('[data-hatch-video-src]');const src=(v&&(v.currentSrc||v.src))||wrapper?.getAttribute('data-hatch-video-src')||(img&&(img.currentSrc||img.src))||'';if(!src||seen.has(src))return;seen.add(src);media.push({src,type:(v||wrapper)?'video':'image',duration:v&&Number.isFinite(v.duration)?v.duration:0,name:(card.getAttribute('aria-label')||wrapper?.getAttribute('aria-label')||img?.alt||'')});});const composer=document.querySelector('[data-hatch-composer-chrome="true"]');const busy=!!composer?.querySelector('[data-testid="hatch-composer-stop-button"],button[aria-label*="Stop" i],button[aria-label*="Dừng" i],[role="progressbar"],[data-testid*="loading" i]');const lastText=(scope.innerText||'').trim();const chatRoot=document.querySelector('main')||document.body;const chatText=(chatRoot.innerText||'').trim();return {media,busy,status:lastText.slice(0,500),tail:chatText.slice(-1800)};})()`);
  }

  async waitForMedia(client, type, baseline, timeoutMs, onProgress, range, control = {}) {
    const started = Date.now();
    let candidate = null;
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
      if (control.isCancelled?.()) { const error = new Error("Đã dừng theo yêu cầu"); error.code = "MUSE_STOPPED"; throw error; }
      await control.waitIfPaused?.();
      const state = await this.agentState(client);
      if (/about what\?|make a space|create a space|topic in a sentence/i.test(state.tail)) throw new Error("Muse mở nhầm chế độ Space; hãy chạy lại luồng trong Side chat mới");
      if (/out of credits|hết lượt|hết credit|đạt giới hạn|额度不足|积分不足/i.test(state.tail)) throw new Error("Tài khoản Muse đã hết lượt/credit");
      const fresh = state.media.filter((item) => item.type === type && !baseline.has(item.src));
      if (fresh.length) {
        candidate = fresh[fresh.length - 1];
        stable = state.busy ? 0 : stable + 1;
        if (stable >= 3) return candidate;
      }
      const elapsed = (Date.now() - started) / timeoutMs;
      const progress = Math.round(range[0] + (range[1] - range[0]) * Math.min(.92, elapsed));
      const elapsedMinutes = Math.max(1, Math.round((Date.now() - started) / 60000));
      onProgress(progress, `${type === "image" ? "Muse đang dựng ảnh sản phẩm" : "Muse đang render video"} · ${elapsedMinutes} phút`);
      await delay(3000);
    }
    if (candidate) return candidate;
    throw new Error(`Hết thời gian chờ Muse tạo ${type === "image" ? "ảnh" : "video"}`);
  }

  async downloadFromPage(client, mediaUrl, baseName, fallbackType) {
    const key = `dl_${Date.now()}`;
    const prepared = await client.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(mediaUrl)});if(!r.ok)return {ok:false,err:'HTTP '+r.status};const b=await r.blob();const bytes=new Uint8Array(await b.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));window[${JSON.stringify(key)}]=btoa(binary);return {ok:true,mime:b.type,size:b.size,length:window[${JSON.stringify(key)}].length};}catch(e){return {ok:false,err:String(e)}}})()`);
    if (!prepared?.ok) throw new Error(`Không tải được media: ${prepared?.err || "unknown"}`);
    const parts = [];
    for (let offset = 0; offset < prepared.length; offset += 500000) parts.push(await client.evaluate(`window[${JSON.stringify(key)}].slice(${offset},${offset + 500000})`));
    await client.evaluate(`delete window[${JSON.stringify(key)}]`).catch(() => {});
    const mime = prepared.mime || fallbackType;
    const ext = mime.includes("video") ? ".mp4" : mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : ".jpg";
    const safe = String(baseName || "muse-result").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0, 90);
    const filePath = path.join(this.downloadDir, `${safe}-${Date.now()}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(parts.join(""), "base64"));
    return filePath;
  }

  async produceVideo(job, onProgress = () => {}, control = {}) {
    if (!job.productImage || !fs.existsSync(job.productImage)) throw new Error("Luồng chưa có ảnh sản phẩm hợp lệ");
    const client = await this.openFreshThread();
    try {
      const checkpoint = async () => { if (control.isCancelled?.()) { const error = new Error("Đã dừng theo yêu cầu"); error.code = "MUSE_STOPPED"; throw error; } await control.waitIfPaused?.(); };
      await checkpoint();
      onProgress(5, "Đã mở tab Muse riêng cho luồng này");
      const refs = [this.imageItem(job.productImage, "product")];
      if (job.characterImage && fs.existsSync(job.characterImage)) refs.unshift(this.imageItem(job.characterImage, "character"));
      await this.attachImages(client, refs);
      await checkpoint();
      const beforeVideo = new Set((await this.agentState(client)).media.map((m) => m.src));
      const videoPrompt = this.buildVideoPrompt(job);
      job.generatedPrompt = videoPrompt;
      onProgress(12, `Đã tải ${refs.length} ảnh tham chiếu · chuẩn bị prompt tự động`);
      await this.sendPrompt(client, videoPrompt, refs);
      onProgress(18, "Đã tự điền và gửi prompt hoàn chỉnh cho Muse");
      const video = await this.waitForMedia(client, "video", beforeVideo, 20 * 60 * 1000, onProgress, [18, 94], control);
      const videoPath = await this.downloadFromPage(client, video.src, `${path.parse(job.productImage).name}-video`, "video/mp4");
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
      const links = await client.evaluate(`(()=>Array.from(new Set(Array.from(document.querySelectorAll('video[src],video source[src],img[src],a[href]')).map(el=>el.currentSrc||el.src||el.href).filter(u=>/^https?:/i.test(u)&&(/\.(mp4|webm|png|jpe?g|webp)(\?|$)/i.test(u)||/media|artifact|deliverable|generated/i.test(u))))))()`);
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
    const { client } = await this.pageClient();
    try {
      const windowInfo = await client.send("Browser.getWindowForTarget");
      await client.send("Browser.setWindowBounds", { windowId: windowInfo.windowId, bounds: { windowState: visible ? "normal" : "minimized" } });
      this.hidden = !visible;
      return true;
    } finally { client.close(); }
  }
}

module.exports = { MuseController };

