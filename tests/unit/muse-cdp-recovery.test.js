"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MuseController, isTransientCdpError } = require("../../source/muse");

test("classifies Runtime.evaluate timeout as a recoverable CDP failure", () => {
  assert.equal(isTransientCdpError(new Error("Runtime.evaluate timeout")), true);
});

test("classifies execution-context navigation errors as recoverable", () => {
  assert.equal(isTransientCdpError(new Error("Cannot find default execution context")), true);
  assert.equal(isTransientCdpError(new Error("Execution context was destroyed")), true);
});

test("does not hide real Muse errors as CDP failures", () => {
  assert.equal(isTransientCdpError(new Error("Tài khoản Muse đã hết lượt/credit")), false);
  assert.equal(isTransientCdpError(new Error("Muse mở nhầm chế độ Space")), false);
});

test("refuses to send a prompt when the required image is absent", async () => {
  const controller = new MuseController({ dataDir: ".", downloadDir: "." });
  const client = {
    async evaluate(expression) {
      if (expression.includes("Không tìm thấy đúng textarea")) return { ok: true, valLen: 100 };
      if (expression.includes("processing attachment")) {
        return { ready: true, count: 0, hasAttachment: false, uploading: false, chars: 100, hasSend: true };
      }
      throw new Error("Unexpected evaluation in test");
    },
    async send() { return {}; },
    async recover() {}
  };
  await assert.rejects(
    controller.sendPrompt(client, "create a product video", [{ filePath: "product.jpg" }]),
    (error) => error.code === "MUSE_ATTACHMENT_MISSING"
  );
});

test("accepts a final video by expected duration even if Muse leaves busy active", async () => {
  const controller = new MuseController({ dataDir: ".", downloadDir: "." });
  controller.agentState = async () => ({
    busy: true,
    tail: "",
    media: [{ src: "https://cdn.example/final.mp4", type: "video", duration: 20, name: "" }]
  });
  const result = await controller.waitForMedia(
    {}, "video", new Set(), 1000, () => {}, [18, 94], { expectedSeconds: 20 }
  );
  assert.equal(result.src, "https://cdn.example/final.mp4");
});

test("agent media scanner emits syntactically valid browser JavaScript", async () => {
  const controller = new MuseController({ dataDir: ".", downloadDir: "." });
  const client = {
    async evaluate(expression) {
      assert.doesNotThrow(() => new Function(`return (${expression});`));
      return { busy: false, tail: "", status: "", media: [] };
    }
  };
  await controller.agentState(client, { attempts: 1 });
});

test("video prompt requires a fresh run and exact product identity", () => {
  const controller = new MuseController({ dataDir: ".", downloadDir: "." });
  const prompt = controller.buildVideoPrompt({
    requestToken: "MVF-test-unique",
    duration: "20s",
    aspect: "9:16",
    quality: "1K",
    prompt: "Show the product in a store"
  });
  assert.match(prompt, /FRESH PRODUCTION REQUEST: MVF-test-unique/);
  assert.match(prompt, /Do not reuse, reattach, copy/);
  assert.match(prompt, /ABSOLUTE HARD PRODUCT LOCK/);
  assert.match(prompt, /immutable ground truth/);
  assert.match(prompt, /exact product pixels, cutout, label texture/);
  assert.match(prompt, /create exact clones/);
  assert.match(prompt, /Reject and regenerate any clip/);
});

test("fashion try-on prompt preserves identity but replaces original clothing", () => {
  const controller = new MuseController({ dataDir: ".", downloadDir: "." });
  const prompt = controller.buildVideoPrompt({
    requestToken: "MVF-fashion-test",
    duration: "20s",
    aspect: "9:16",
    quality: "1K",
    characterImage: "character.jpg",
    productImage: "outfit.jpg",
    prompt: "Cho mẫu mặc bộ quần áo trong ảnh và trình diễn thời trang"
  });
  assert.equal(controller.isFashionTryOn({ characterImage: "character.jpg", prompt: "Cho mẫu mặc váy trong ảnh" }), true);
  assert.match(prompt, /VIRTUAL TRY-ON ROLE MAP/);
  assert.match(prompt, /FIRST attached image is the CHARACTER REFERENCE/);
  assert.match(prompt, /SECOND attached image is the OUTFIT REFERENCE/);
  assert.match(prompt, /Do NOT preserve that person's original clothing/);
  assert.match(prompt, /MANDATORY FASHION VIDEO MOTION/);
  assert.match(prompt, /walks at least two clear steps/);
  assert.doesNotMatch(prompt, /preserve the exact face, hair, clothing, and identity/);
});

test("character reference alone does not switch ordinary product jobs to fashion mode", () => {
  const controller = new MuseController({ dataDir: ".", downloadDir: "." });
  const prompt = controller.buildVideoPrompt({
    duration: "8s",
    characterImage: "character.jpg",
    prompt: "Nhân vật cầm hộp sản phẩm và giới thiệu trong cửa hàng"
  });
  assert.equal(controller.isFashionTryOn({ characterImage: "character.jpg", prompt: "Nhân vật cầm hộp sản phẩm" }), false);
  assert.match(prompt, /ABSOLUTE HARD PRODUCT LOCK/);
  assert.doesNotMatch(prompt, /VIRTUAL TRY-ON ROLE MAP/);
});

test("acrylic box scene injects absolute presenter face privacy lock", () => {
  const controller = new MuseController({ dataDir: ".", downloadDir: "." });
  const prompt = controller.buildVideoPrompt({
    prompt: "Sản phẩm trong hộp mica/acrylic, một bàn tay nữ cầm quai giới thiệu hộp",
    productImage: "product.jpg",
    duration: "20s"
  });
  assert.equal(controller.isAcrylicBoxScene({ prompt: "Hộp mica có bàn tay cầm quai" }), true);
  assert.match(prompt, /ABSOLUTE PRESENTER PRIVACY LOCK/);
  assert.match(prompt, /complete face, eyes, nose, mouth/);
  assert.match(prompt, /mirrors, glass, polished shelves, acrylic reflections/);
});
