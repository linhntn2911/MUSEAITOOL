"use strict";

class FakeStudioAdapter {
  constructor(options = {}) {
    this.options = Object.assign({
      loginState: "live",
      accountHandle: "@testuser",
      accountNickname: "Test Creator",
      failUpload: false,
      failSubmit: false,
      simulateCaptcha: false,
      simulateImmediateOnly: false,
      uploadDurationMs: 50,
      postEvidenceId: "mock-video-post-12345",
      scheduleEvidenceId: "mock-video-schedule-67890",
      products: [
        { id: "PROD-101", title: "Áo thun cotton cao cấp", price: "199.000đ", imageUrl: "https://example.com/p1.jpg" },
        { id: "PROD-102", title: "Quần jean unisex", price: "350.000đ", imageUrl: "https://example.com/p2.jpg" }
      ]
    }, options);
    this.isConnected = false;
    this.lastAction = null;
    this.uploadedFile = null;
    this.filledMetadata = null;
    this.selectedSchedule = null;
  }

  async connect(cdpPort) {
    if (this.options.failConnect) {
      throw new Error("Cannot connect to CDP port " + cdpPort);
    }
    this.isConnected = true;
    return { ok: true, port: cdpPort };
  }

  async checkAccount() {
    if (this.options.simulateCaptcha) {
      return { status: "verification_required", reason: "CAPTCHA_DETECTED" };
    }
    if (this.options.loginState === "login_required") {
      return { status: "login_required", handle: null, nickname: null };
    }
    return {
      status: "live",
      handle: this.options.accountHandle,
      nickname: this.options.accountNickname
    };
  }

  async uploadVideo(filePath) {
    if (this.options.failUpload) {
      throw new Error("Upload failed: Video format or network error");
    }
    this.uploadedFile = filePath;
    return { ok: true, uploadedPath: filePath };
  }

  async fillMetadata({ title, caption, hashtags }) {
    this.filledMetadata = { title, caption, hashtags };
    return { ok: true };
  }

  async configureSchedule({ mode, scheduledTime }) {
    if (this.options.simulateImmediateOnly && mode === "native_schedule") {
      return {
        ok: false,
        error: "SCHEDULE_NOT_PERMITTED_ON_UI",
        message: "Giao diện hiện tại chỉ cho phép Đăng ngay, không thể chọn Lên lịch"
      };
    }
    this.selectedSchedule = { mode, scheduledTime };
    return { ok: true, mode, scheduledTime };
  }

  async searchShowcase(query) {
    const q = (query || "").toLowerCase();
    const matches = this.options.products.filter(p =>
      p.id.toLowerCase() === q || p.title.toLowerCase().includes(q)
    );
    return { ok: true, products: matches };
  }

  async submitPost({ mode }) {
    if (this.options.failSubmit) {
      throw new Error("Submit failed: Network disconnected during submission");
    }
    if (this.options.simulateCaptcha) {
      return { ok: false, error: "CAPTCHA_DETECTED", requiresUser: true };
    }

    if (mode === "native_schedule") {
      return {
        ok: true,
        evidence: {
          type: "schedule_confirmed",
          evidenceId: this.options.scheduleEvidenceId,
          timestamp: new Date().toISOString()
        }
      };
    }

    return {
      ok: true,
      evidence: {
        type: "post_confirmed",
        evidenceId: this.options.postEvidenceId,
        timestamp: new Date().toISOString()
      }
    };
  }

  async close() {
    this.isConnected = false;
  }
}

module.exports = FakeStudioAdapter;
