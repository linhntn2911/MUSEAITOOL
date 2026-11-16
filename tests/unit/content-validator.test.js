"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { normalizeHashtag, deduplicateHashtags, validateContent } = require("../../source/models/validators");

test("Content validator character bounds and hashtag deduplication", async (t) => {
  await t.test("Normalizes hashtag prefix and trims whitespace", () => {
    assert.strictEqual(normalizeHashtag("xuhuong"), "#xuhuong");
    assert.strictEqual(normalizeHashtag("#xuhuong"), "#xuhuong");
    assert.strictEqual(normalizeHashtag("  #trending  "), "#trending");
  });

  await t.test("Deduplicates case-insensitively while preserving case of first instance", () => {
    const list = ["#TikTok", "#tiktok", "review", "#REVIEW", "#Shop"];
    const result = deduplicateHashtags(list);
    assert.deepStrictEqual(result, ["#TikTok", "#review", "#Shop"]);
  });

  await t.test("validateContent enforces limits and initializes versionHistory", () => {
    const res = validateContent({
      title: "Tiêu đề hợp lệ",
      caption: "Mô tả bài đăng",
      hashtags: ["#v1", "#v2"]
    });

    assert.strictEqual(res.title, "Tiêu đề hợp lệ");
    assert.deepStrictEqual(res.versionHistory, []);
  });
});
