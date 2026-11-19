"use strict";

const fs = require("node:fs");

function mimeFor(filePath) {
  const lower = String(filePath || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function imagePartFromUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 4 * 1024 * 1024) return null;
  return { inlineData: { mimeType: response.headers.get("content-type") || "image/jpeg", data: bytes.toString("base64") } };
}

async function rankShowcaseProducts({ apiKey, model, referencePath, products = [] }) {
  if (!apiKey) throw new Error("Chưa có Gemini API key để đối chiếu hình ảnh.");
  if (!referencePath || !fs.existsSync(referencePath)) throw new Error("Không tìm thấy ảnh sản phẩm gốc để đối chiếu.");
  const candidates = products.filter(p => p && p.id).slice(0, 8);
  if (!candidates.length) return { selectedProductId: "", confidence: 0, reason: "Showcase chưa có sản phẩm hợp lệ." };

  const parts = [
    { text: "ẢNH GỐC CẦN TÌM (ground truth):" },
    { inlineData: { mimeType: mimeFor(referencePath), data: fs.readFileSync(referencePath).toString("base64") } }
  ];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    parts.push({ text: `ỨNG VIÊN ${i + 1}; Product ID=${p.id}; tên=${p.title || p.name || ""}` });
    try {
      const imagePart = await imagePartFromUrl(p.imageUrl || p.image || "");
      if (imagePart) parts.push(imagePart);
    } catch (_) {}
  }
  parts.push({ text: "Chọn đúng cùng SKU/bao bì. Nếu logo, nhãn, màu, hình dáng hoặc biến thể không khớp thì không chọn." });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || "gemini-3.5-flash-lite")}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      systemInstruction: { parts: [{ text: "Bạn là bộ đối chiếu ảnh sản phẩm cực kỳ nghiêm ngặt. Không đoán. Chỉ trả Product ID khi cùng chính xác SKU và bao bì; không chọn sản phẩm gần giống." }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: ["selectedProductId", "confidence", "reason"],
          properties: {
            selectedProductId: { type: "STRING" },
            confidence: { type: "NUMBER" },
            reason: { type: "STRING" }
          }
        },
        temperature: 0
      }
    }),
    signal: AbortSignal.timeout(45000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Gemini đối chiếu ảnh lỗi HTTP ${response.status}: ${raw.slice(0, 240)}`);
  const parsed = JSON.parse(raw);
  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const result = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  const found = candidates.find(p => String(p.id) === String(result.selectedProductId || ""));
  return {
    selectedProductId: found ? String(found.id) : "",
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    reason: String(result.reason || ""),
    selectedProduct: found || null
  };
}

module.exports = { rankShowcaseProducts };
