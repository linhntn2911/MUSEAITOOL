"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { createError, ERROR_CODES } = require("../core/errors");

async function probeMedia(filePath) {
  if (!filePath) {
    throw createError(ERROR_CODES.INVALID_MEDIA_FILE, "Đường dẫn file media rỗng.");
  }

  try {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath
    ];

    const { stdout } = await execFileAsync("ffprobe", args);
    const data = JSON.parse(stdout);

    const streams = data.streams || [];
    const videoStream = streams.find(s => s.codec_type === "video");
    const audioStream = streams.find(s => s.codec_type === "audio");

    const duration = parseFloat(data.format?.duration || videoStream?.duration || audioStream?.duration || 0);

    return {
      durationSeconds: isNaN(duration) ? 0 : duration,
      hasVideo: Boolean(videoStream),
      hasAudio: Boolean(audioStream),
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      formatName: data.format?.format_name || "",
      videoCodec: videoStream?.codec_name || null,
      audioCodec: audioStream?.codec_name || null
    };
  } catch (err) {
    throw createError(ERROR_CODES.FFPROBE_FAILED, `Lỗi đọc thông số media bằng ffprobe: ${err.message}`);
  }
}

module.exports = {
  probeMedia
};
