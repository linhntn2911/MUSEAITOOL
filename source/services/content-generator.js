"use strict";

const https = require("node:https");
const { deduplicateHashtags } = require("../models/validators");
const { createError, ERROR_CODES } = require("../core/errors");
const { logger } = require("../core/redacted-log");

function validateGeneratedContent(raw = {}) {
  const title = (raw.title || "Video TikTok").trim().substring(0, 60);
  const caption = (raw.caption || "").trim().substring(0, 2200);
  const cartTitle = (raw.cartTitle || "").trim().substring(0, 30);
  const rawTags = Array.isArray(raw.hashtags) ? raw.hashtags : [];
  const hashtags = deduplicateHashtags(rawTags).slice(0, 8);
  const productKeywords = Array.isArray(raw.productKeywords)
    ? Array.from(new Set(raw.productKeywords.map(k => String(k).trim()).filter(Boolean))).slice(0, 5)
    : [];

  return {
    title,
    caption,
    hashtags,
    cartTitle,
    productKeywords
  };
}

async function callGeminiApi({ apiKey, model = "gemini-3.8-flash", systemPrompt, userPrompt, imageBase64 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const parts = [];
  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: "image/jpeg",
        data: imageBase64
      }
    });
  }
  parts.push({ text: userPrompt });

  const requestBody = {
    contents: [{ role: "user", parts }],
    system_instruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      response_mime_type: "application/json",
      temperature: 0.7
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(createError(ERROR_CODES.AI_SERVICE_UNAVAILABLE, `Gemini API trả về mã lỗi HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(createError(ERROR_CODES.AI_RESPONSE_INVALID, "Gemini không trả về nội dung hợp lệ"));
          }
          const contentJson = JSON.parse(text);
          resolve(validateGeneratedContent(contentJson));
        } catch (err) {
          reject(createError(ERROR_CODES.AI_RESPONSE_INVALID, `Lỗi parse JSON phản hồi từ Gemini: ${err.message}`));
        }
      });
    });

    req.on("error", (err) => reject(createError(ERROR_CODES.AI_SERVICE_UNAVAILABLE, err.message)));
    req.setTimeout(20000, () => {
      req.destroy();
      reject(createError(ERROR_CODES.AI_SERVICE_UNAVAILABLE, "Timeout khi gọi Gemini API"));
    });

    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

async function generateContentForJob(job, options = {}) {
  const apiKey = options.apiKey;
  const tone = options.tone || job.content?.tone || "review";
  const hasCart = job.accountMode === "affiliate";
  const model = options.model || "gemini-3.8-flash";

  // System instruction with no_cart constraint enforcement
  let systemPrompt = `Bạn là trợ lý sáng tạo nội dung TikTok chuyên nghiệp bằng tiếng Việt.
Nhiệm vụ của bạn là tạo tiêu đề (title tối đa 60 ký tự), caption (tối đa 2200 ký tự hấp dẫn, tự nhiên), 4-8 hashtag liên quan (bắt đầu bằng #), tên hiển thị giỏ hàng (cartTitle tối đa 30 ký tự) và từ khóa sản phẩm (productKeywords tối đa 5 từ khóa).
Phong cách viết yêu cầu: ${tone}.
Định dạng đầu ra BẮT BUỘC là JSON khớp chính xác schema:
{
  "title": "string (1-60 ký tự)",
  "caption": "string (1-2200 ký tự)",
  "hashtags": ["#tag1", "#tag2"],
  "cartTitle": "string (tối đa 30 ký tự)",
  "productKeywords": ["keyword 1", "keyword 2"]
}`;

  if (!hasCart) {
    systemPrompt += `\n\n[RÀNG BUỘC BẮT BUỘC - CHẾ ĐỘ KHÔNG GIỎ HÀNG / NO CART]:
Bài đăng này KHÔNG có giỏ hàng TikTok Shop. BẠN TUYỆT ĐỐI KHÔNG ĐƯỢC nhắc đến 'giỏ hàng', 'link mua', 'mua ngay', 'đặt hàng' hoặc bất kỳ lời kêu gọi mua hàng trực tiếp nào. Để trường cartTitle rỗng hoặc tối giản.`;
  }

  const userPrompt = `Hãy viết nội dung TikTok cho video dựa trên prompt sản xuất và mô tả sau:
${job.sourcePrompt || "Sản phẩm video chất lượng cao"}
Vui lòng trả lời bằng duy nhất một khối JSON hợp lệ.`;

  if (!apiKey) {
    // Fallback template content when no key provided (keeps existing content if present)
    return validateGeneratedContent({
      title: job.content?.title || "Video review sản phẩm nổi bật",
      caption: job.content?.caption || (hasCart ? "Sản phẩm siêu chất lượng, mọi người tham khảo nhé! 👇" : "Trải nghiệm hình ảnh cực đẹp cùng sản phẩm!"),
      hashtags: job.content?.hashtags?.length ? job.content.hashtags : ["#fyp", "#xuhuong", "#review"],
      cartTitle: hasCart ? (job.content?.cartTitle || "Sản phẩm nổi bật") : "",
      productKeywords: ["sản phẩm"]
    });
  }

  return await callGeminiApi({
    apiKey,
    model,
    systemPrompt,
    userPrompt,
    imageBase64: options.imageBase64 || null
  });
}

module.exports = {
  validateGeneratedContent,
  callGeminiApi,
  generateContentForJob
};
