"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { validateGeneratedContent } = require("../../source/services/content-generator");

test("Generated content schema contract conformance", async (t) => {
  await t.test("Validates conforming generated content payload", () => {
    const raw = {
      title: "Review hộp quà mica trong suốt cực xịn",
      caption: "Cùng mình mở hộp quà acrylic cao cấp siêu đẹp nhé mọi người!",
      hashtags: ["#fyp", "#xuhuong", "#review", "#hopquatang"],
      cartTitle: "Hộp mica acrylic trong suốt",
      productKeywords: ["hộp mica", "hộp acrylic", "hộp quà"]
    };

    const validated = validateGeneratedContent(raw);
    assert.strictEqual(validated.title, raw.title);
    assert.strictEqual(validated.caption, raw.caption);
    assert.strictEqual(validated.hashtags.length, 4);
    assert.strictEqual(validated.cartTitle, raw.cartTitle);
  });

  await t.test("Truncates overlong titles and normalizes hashtags", () => {
    const raw = {
      title: "A".repeat(100), // schema max is 60
      caption: "B".repeat(3000), // schema max is 2200
      hashtags: ["fyp", "#fyp", "xuhuong", "#xuhuong", "review", "#trending", "#shop", "#gift", "#box", "#extra"],
      cartTitle: "C".repeat(50), // max is 30
      productKeywords: ["kw1", "kw2", "kw3", "kw4", "kw5", "kw6"] // max 5
    };

    const validated = validateGeneratedContent(raw);
    assert.ok(validated.title.length <= 60);
    assert.ok(validated.caption.length <= 2200);
    assert.ok(validated.cartTitle.length <= 30);
    assert.ok(validated.hashtags.length <= 8);
    assert.ok(validated.hashtags.every(h => h.startsWith("#")));
    assert.ok(validated.productKeywords.length <= 5);
  });
});
