"use strict";

function matchProduct(input = {}, availableProducts = []) {
  const queryId = (input.productId || "").trim().toLowerCase();
  const queryName = (input.keyword || input.title || "").trim().toLowerCase();

  // Rule 1: Exact ID match -> auto-confirmed (FR-018)
  if (queryId) {
    const exact = availableProducts.find(p => String(p.id).trim().toLowerCase() === queryId);
    if (exact) {
      return {
        confirmed: true,
        autoConfirmed: true,
        confidence: 1.0,
        selectedProduct: exact,
        productId: String(exact.id),
        productName: exact.title || exact.name || "",
        productImageUrl: exact.imageUrl || exact.image || "",
        candidates: [exact],
        verifiedAt: new Date().toISOString()
      };
    }
  }

  // Rule 2: Title / keyword query -> candidate match needing manual confirmation (FR-018)
  const candidates = [];
  if (queryName) {
    for (const p of availableProducts) {
      const pTitle = (p.title || "").toLowerCase();
      if (pTitle.includes(queryName) || queryName.includes(pTitle)) {
        candidates.push({
          product: p,
          confidence: 0.85
        });
      }
    }
  }

  if (candidates.length > 0) {
    return {
      confirmed: false,
      autoConfirmed: false,
      confidence: candidates[0].confidence,
      selectedProduct: candidates[0].product,
      productId: String(candidates[0].product.id || ""),
      productName: candidates[0].product.title || candidates[0].product.name || "",
      productImageUrl: candidates[0].product.imageUrl || candidates[0].product.image || "",
      candidates: candidates.map(c => c.product),
      verifiedAt: new Date().toISOString()
    };
  }

  return {
    confirmed: false,
    autoConfirmed: false,
    confidence: 0,
    selectedProduct: null,
    candidates: [],
    verifiedAt: new Date().toISOString()
  };
}

function lockProduct(product, options = {}) {
  if (!product || !String(product.id || "").trim()) throw new Error("Sản phẩm Showcase thiếu Product ID nên không thể khóa.");
  return {
    confirmed: true,
    autoConfirmed: Boolean(options.autoConfirmed),
    confidence: Number(options.confidence) || 1,
    productId: String(product.id).trim(),
    productName: product.title || product.name || "",
    productImageUrl: product.imageUrl || product.image || "",
    selectedProduct: product,
    candidates: [product],
    source: options.source || "manual_confirmation",
    verifiedAt: new Date().toISOString()
  };
}

module.exports = {
  matchProduct,
  lockProduct
};
