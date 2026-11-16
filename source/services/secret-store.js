"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const ALGORITHM = "aes-256-gcm";

function getMachineKey() {
  const machineId = `${os.hostname()}-${os.platform()}-${os.arch()}-muse-secret`;
  return crypto.createHash("sha256").update(machineId).digest();
}

class SecretStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.cachedKey = null;
  }

  saveApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("API key không hợp lệ.");
    }
    const clean = apiKey.trim();
    this.cachedKey = clean;

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getMachineKey(), iv);
    let encrypted = cipher.update(clean, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");

    const payload = JSON.stringify({
      iv: iv.toString("hex"),
      tag,
      data: encrypted,
      suffix: clean.slice(-4),
      updatedAt: new Date().toISOString()
    });

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, payload, "utf8");

    return this.getMaskedKey();
  }

  getApiKey() {
    if (process.env.GEMINI_API_KEY) {
      return process.env.GEMINI_API_KEY.trim();
    }
    if (this.cachedKey) return this.cachedKey;

    if (!fs.existsSync(this.filePath)) return null;

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const { iv, tag, data } = JSON.parse(raw);
      const decipher = crypto.createDecipheriv(ALGORITHM, getMachineKey(), Buffer.from(iv, "hex"));
      decipher.setAuthTag(Buffer.from(tag, "hex"));
      let decrypted = decipher.update(data, "hex", "utf8");
      decrypted += decipher.final("utf8");
      this.cachedKey = decrypted;
      return decrypted;
    } catch (err) {
      return null;
    }
  }

  getMaskedKey() {
    if (process.env.GEMINI_API_KEY) {
      const k = process.env.GEMINI_API_KEY.trim();
      return `...${k.slice(-4)} (từ biến môi trường)`;
    }
    if (!fs.existsSync(this.filePath)) return null;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return `...${parsed.suffix || "XXXX"}`;
    } catch {
      return null;
    }
  }

  hasApiKey() {
    return Boolean(this.getApiKey());
  }

  removeApiKey() {
    this.cachedKey = null;
    if (fs.existsSync(this.filePath)) {
      try { fs.unlinkSync(this.filePath); } catch (_) {}
    }
  }
}

module.exports = {
  SecretStore
};
