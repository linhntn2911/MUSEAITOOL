"use strict";

const ERROR_CODES = {
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  CAPTCHA_DETECTED: "CAPTCHA_DETECTED",
  VERIFICATION_REQUIRED: "VERIFICATION_REQUIRED",
  ACCOUNT_BUSY: "ACCOUNT_BUSY",
  ACCOUNT_PAUSED: "ACCOUNT_PAUSED",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  CDP_PORT_UNAVAILABLE: "CDP_PORT_UNAVAILABLE",
  VIDEO_NOT_FOUND: "VIDEO_NOT_FOUND",
  INVALID_MEDIA_FILE: "INVALID_MEDIA_FILE",
  FFMPEG_MISSING: "FFMPEG_MISSING",
  FFPROBE_FAILED: "FFPROBE_FAILED",
  AUDIO_MIX_FAILED: "AUDIO_MIX_FAILED",
  AI_SERVICE_UNAVAILABLE: "AI_SERVICE_UNAVAILABLE",
  AI_KEY_INVALID: "AI_KEY_INVALID",
  AI_RESPONSE_INVALID: "AI_RESPONSE_INVALID",
  PRODUCT_UNVERIFIED: "PRODUCT_UNVERIFIED",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  SCHEDULE_COLLISION: "SCHEDULE_COLLISION",
  SCHEDULE_INVALID_TIME: "SCHEDULE_INVALID_TIME",
  SCHEDULE_NOT_PERMITTED_ON_UI: "SCHEDULE_NOT_PERMITTED_ON_UI",
  STUDIO_SELECTOR_MISMATCH: "STUDIO_SELECTOR_MISMATCH",
  SUBMIT_CONFIRMATION_TIMEOUT: "SUBMIT_CONFIRMATION_TIMEOUT",
  RECONCILIATION_NEEDED: "RECONCILIATION_NEEDED",
  STALE_EDIT_CONFLICT: "STALE_EDIT_CONFLICT",
  MUTATION_NOT_ALLOWED: "MUTATION_NOT_ALLOWED"
};

const DEFAULT_MESSAGES = {
  [ERROR_CODES.UNKNOWN_ERROR]: "Đã xảy ra lỗi không xác định.",
  [ERROR_CODES.LOGIN_REQUIRED]: "Tài khoản TikTok chưa đăng nhập. Vui lòng mở Chrome để đăng nhập.",
  [ERROR_CODES.SESSION_EXPIRED]: "Phiên đăng nhập TikTok đã hết hạn. Vui lòng đăng nhập lại và bấm Kiểm tra.",
  [ERROR_CODES.CAPTCHA_DETECTED]: "Phát hiện CAPTCHA / OTP. Vui lòng giải quyết trực tiếp trên cửa sổ trình duyệt.",
  [ERROR_CODES.VERIFICATION_REQUIRED]: "Tài khoản yêu cầu xác minh danh tính hoặc thiết bị.",
  [ERROR_CODES.ACCOUNT_BUSY]: "Tài khoản đang thực hiện một job khác. Mỗi tài khoản chỉ chạy 1 job tại một thời điểm.",
  [ERROR_CODES.ACCOUNT_PAUSED]: "Tài khoản đang bị tạm dừng. Bấm Kiểm tra và Resume để tiếp tục.",
  [ERROR_CODES.ACCOUNT_NOT_FOUND]: "Không tìm thấy tài khoản TikTok đã chọn.",
  [ERROR_CODES.CDP_PORT_UNAVAILABLE]: "Không thể khởi động Chrome vì cổng CDP đang bị tiến trình khác chiếm dụng.",
  [ERROR_CODES.VIDEO_NOT_FOUND]: "Không tìm thấy file video nguồn hoặc file đã bị di chuyển/xóa.",
  [ERROR_CODES.INVALID_MEDIA_FILE]: "File media không hợp lệ hoặc không có stream tương thích.",
  [ERROR_CODES.FFMPEG_MISSING]: "Không tìm thấy công cụ FFmpeg hoặc ffprobe trên hệ thống.",
  [ERROR_CODES.FFPROBE_FAILED]: "Không thể kiểm tra thông số video bằng ffprobe.",
  [ERROR_CODES.AUDIO_MIX_FAILED]: "Quá trình ghép/xử lý âm thanh thất bại.",
  [ERROR_CODES.AI_SERVICE_UNAVAILABLE]: "Không thể kết nối đến dịch vụ Gemini API. Vui lòng kiểm tra mạng hoặc API key.",
  [ERROR_CODES.AI_KEY_INVALID]: "Gemini API key không hợp lệ hoặc thiếu quyền.",
  [ERROR_CODES.AI_RESPONSE_INVALID]: "Nội dung AI trả về không đúng cấu trúc yêu cầu.",
  [ERROR_CODES.PRODUCT_UNVERIFIED]: "Chưa xác minh sản phẩm Showcase. Chế độ giỏ hàng yêu cầu duyệt sản phẩm trước khi đăng.",
  [ERROR_CODES.PRODUCT_NOT_FOUND]: "Không tìm thấy sản phẩm tương ứng trong Showcase.",
  [ERROR_CODES.SCHEDULE_COLLISION]: "Thời gian lên lịch bị trùng hoặc quá gần một bài đăng khác của cùng kênh.",
  [ERROR_CODES.SCHEDULE_INVALID_TIME]: "Thời gian lên lịch không hợp lệ (phải trong tương lai và nằm trong giới hạn của TikTok).",
  [ERROR_CODES.SCHEDULE_NOT_PERMITTED_ON_UI]: "Giao diện TikTok Studio không hỗ trợ lên lịch cho tài khoản/nội dung này (chỉ hiển thị Đăng ngay).",
  [ERROR_CODES.STUDIO_SELECTOR_MISMATCH]: "Không nhận diện được phần tử giao diện trên TikTok Studio. Có thể TikTok vừa cập nhật giao diện.",
  [ERROR_CODES.SUBMIT_CONFIRMATION_TIMEOUT]: "Đã bấm Đăng/Lên lịch nhưng không nhận được bằng chứng xác nhận. Job cần đối soát.",
  [ERROR_CODES.RECONCILIATION_NEEDED]: "Job ở trạng thái chưa rõ kết quả đăng. Vui lòng mở kênh để đối soát thủ công.",
  [ERROR_CODES.STALE_EDIT_CONFLICT]: "Dữ liệu job đã được thay đổi từ phiên khác. Vui lòng tải lại trước khi lưu.",
  [ERROR_CODES.MUTATION_NOT_ALLOWED]: "Thao tác không được phép với trạng thái hiện tại của job."
};

function createError(code, customMessage = null, extra = {}) {
  const message = customMessage || DEFAULT_MESSAGES[code] || "Đã xảy ra lỗi.";
  const retryable = extra.retryable !== undefined ? extra.retryable : false;
  const requiresUser = extra.requiresUser !== undefined ? extra.requiresUser : false;

  return {
    code,
    message,
    retryable,
    requiresUser,
    step: extra.step || null,
    action: extra.action || null,
    details: extra.details || null
  };
}

module.exports = {
  ERROR_CODES,
  DEFAULT_MESSAGES,
  createError
};
