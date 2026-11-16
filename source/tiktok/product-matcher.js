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

module.exports = {
  matchProduct
};
