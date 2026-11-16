"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { matchProduct } = require("../../source/tiktok/product-matcher");

test("Product matcher exact ID auto-confirm vs title/image review rules (FR-018)", async (t) => {
  const catalog = [
    { id: "PROD-1001", title: "Áo Thun Cotton Trắng", price: "150.000đ" },
    { id: "PROD-1002", title: "Áo Thun Unisex Màu Đen", price: "160.000đ" }
  ];

  await t.test("Exact ID match auto-confirms without requiring manual confirmation", () => {
    const res = matchProduct({ productId: "PROD-1001" }, catalog);
    assert.strictEqual(res.confirmed, true);
    assert.strictEqual(res.autoConfirmed, true);
    assert.strictEqual(res.confidence, 1.0);
    assert.strictEqual(res.selectedProduct.id, "PROD-1001");
  });

  await t.test("Title / keyword match returns candidates and requires manual user confirmation", () => {
    const res = matchProduct({ keyword: "Áo Thun" }, catalog);
    assert.strictEqual(res.confirmed, false);
    assert.strictEqual(res.autoConfirmed, false);
    assert.ok(res.confidence < 1.0);
    assert.strictEqual(res.candidates.length, 2);
  });

  await t.test("Returns unconfirmed and empty when no match exists", () => {
    const res = matchProduct({ productId: "UNKNOWN-999", keyword: "Giày dép" }, catalog);
    assert.strictEqual(res.confirmed, false);
    assert.strictEqual(res.candidates.length, 0);
  });
});
