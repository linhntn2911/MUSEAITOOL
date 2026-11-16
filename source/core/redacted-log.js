"use strict";

const REDACTION_PATTERNS = [
  /AIza[0-9A-Za-z-_]{35}/g,                                      // Google Gemini API keys
  /Bearer\s+[A-Za-z0-9-_.]+/gi,                                  // Bearer tokens
  /(sessionid|sid_guard|tt_chain_token|passport_csrf_token)=[^;&\s]+/gi, // TikTok auth cookies
  /(password|apiKey|api_key|secret|token)\s*[:=]\s*["']?[^"'\s,]+/gi, // Generic secrets
  /--remote-debugging-port=\d+/gi                                 // Internal debug flags
];

function redactString(str) {
  if (typeof str !== "string") return str;
  let result = str;
  for (const pattern of REDACTION_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith("bearer")) {
        return "Bearer ***REDACTED***";
      }
      if (match.includes("=")) {
        const parts = match.split("=");
        return `${parts[0]}=***REDACTED***`;
      }
      if (match.includes(":")) {
        const parts = match.split(":");
        return `${parts[0]}: "***REDACTED***"`;
      }
      return "***REDACTED***";
    });
  }
  return result;
}

function redactObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactString(obj);
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item));
  }

  const sanitized = {};
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("cookie") ||
      lowerKey.includes("password") ||
      lowerKey === "apikey" ||
      lowerKey === "api_key" ||
      lowerKey === "secret" ||
      lowerKey === "token" ||
      lowerKey === "cdppayload"
    ) {
      sanitized[key] = "***REDACTED***";
    } else {
      sanitized[key] = redactObject(obj[key]);
    }
  }
  return sanitized;
}

class RedactedLogger {
  constructor(options = {}) {
    this.logs = [];
    this.maxMemoryLogs = options.maxMemoryLogs || 500;
    this.listeners = new Set();
  }

  onLog(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  log(level, scope, message, meta = {}) {
    const cleanMessage = redactString(typeof message === "string" ? message : JSON.stringify(message));
    const cleanMeta = redactObject(meta);

    const record = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      scope: scope || "app",
      message: cleanMessage,
      accountId: cleanMeta.accountId || null,
      jobId: cleanMeta.jobId || null,
      step: cleanMeta.step || null
    };

    this.logs.push(record);
    if (this.logs.length > this.maxMemoryLogs) {
      this.logs.shift();
    }

    const logLine = `[${record.timestamp}] [${record.level}] [${record.scope}] ${record.message}`;
    if (record.level === "ERROR") {
      console.error(logLine);
    } else if (record.level === "WARN") {
      console.warn(logLine);
    } else {
      console.log(logLine);
    }

    for (const listener of this.listeners) {
      try {
        listener(record, logLine);
      } catch (err) {
        // ignore listener errors
      }
    }

    return record;
  }

  info(scope, message, meta) {
    return this.log("INFO", scope, message, meta);
  }

  warn(scope, message, meta) {
    return this.log("WARN", scope, message, meta);
  }

  error(scope, message, meta) {
    return this.log("ERROR", scope, message, meta);
  }

  getLogs() {
    return this.logs.slice();
  }

  clear() {
    this.logs = [];
  }
}

const defaultLogger = new RedactedLogger();

module.exports = {
  RedactedLogger,
  redactString,
  redactObject,
  logger: defaultLogger
};
