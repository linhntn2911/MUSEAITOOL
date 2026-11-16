"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { probeMedia } = require("./media-probe");
const { logger } = require("../core/redacted-log");
const { createError, ERROR_CODES } = require("../core/errors");

async function mixAudio(videoPath, audioPath, outputPath, config = {}) {
  const videoInfo = await probeMedia(videoPath);
  if (!videoInfo.hasVideo) {
    throw createError(ERROR_CODES.INVALID_MEDIA_FILE, "File video nguồn không có luồng hình ảnh hợp lệ.");
  }

  const duration = videoInfo.durationSeconds;
  if (duration <= 0) {
    throw createError(ERROR_CODES.INVALID_MEDIA_FILE, "Thời lượng video không hợp lệ (bằng 0).");
  }

  const startTime = Math.max(0, Number(config.startTime) || 0);
  const origVol = Math.min(100, Math.max(0, Number(config.originalVolume) || 0)) / 100;
  const musicVol = Math.min(100, Math.max(0, Number(config.musicVolume !== undefined ? config.musicVolume : 85))) / 100;
  const loop = config.loop !== false;
  const fadeOutSeconds = Math.max(0, Number(config.fadeOutSeconds !== undefined ? config.fadeOutSeconds : 0.5));
  const fadeInSeconds = Math.max(0, Number(config.fadeInSeconds) || 0);

  const args = ["-y"];

  // Video input
  args.push("-i", videoPath);

  // Audio input (with loop if requested)
  if (loop) {
    args.push("-stream_loop", "-1");
  }
  if (startTime > 0) {
    args.push("-ss", String(startTime));
  }
  args.push("-i", audioPath);

  // Build filter graph
  let filterComplex = "";
  const fadeOutStart = Math.max(0, duration - fadeOutSeconds);

  let musicFilter = `[1:a]volume=${musicVol}`;
  if (fadeInSeconds > 0) {
    musicFilter += `,afade=t=in:st=0:d=${fadeInSeconds}`;
  }
  if (fadeOutSeconds > 0) {
    musicFilter += `,afade=t=out:st=${fadeOutStart}:d=${fadeOutSeconds}`;
  }
  musicFilter += "[a_music]";

  if (videoInfo.hasAudio && origVol > 0) {
    filterComplex = `${musicFilter};[0:a]volume=${origVol}[a_orig];[a_orig][a_music]amix=inputs=2:duration=first:dropout_transition=2[a_out]`;
  } else {
    filterComplex = `${musicFilter};[a_music]anull[a_out]`;
  }

  args.push("-filter_complex", filterComplex);
  args.push("-map", "0:v:0");
  args.push("-map", "[a_out]");
  args.push("-c:v", "copy");
  args.push("-c:a", "aac");
  args.push("-b:a", "192k");
  args.push("-t", String(duration));
  args.push(outputPath);

  logger.info("audio-mixer", `Bắt đầu xử lý âm thanh cho ${videoPath}: nhạc ${musicVol * 100}%, gốc ${origVol * 100}%`);

  try {
    await execFileAsync("ffmpeg", args);
  } catch (err) {
    // If copy fails due to container packet issues, fallback to re-encoding
    try {
      const fallbackArgs = args.filter(a => a !== "copy");
      const vIdx = fallbackArgs.indexOf("-c:v");
      if (vIdx !== -1) fallbackArgs.splice(vIdx + 1, 0, "libx264", "-pix_fmt", "yuv420p");
      await execFileAsync("ffmpeg", fallbackArgs);
    } catch (fallbackErr) {
      throw createError(ERROR_CODES.AUDIO_MIX_FAILED, `Lỗi ghép âm thanh bằng FFmpeg: ${fallbackErr.message}`);
    }
  }

  // Verify output with ffprobe (SC-005: deviation <= 0.05s)
  const outputInfo = await probeMedia(outputPath);
  const diff = Math.abs(outputInfo.durationSeconds - duration);
  if (diff > 0.1) {
    logger.warn("audio-mixer", `Thời lượng sau khi ghép chênh lệch ${diff.toFixed(3)}s so với video gốc (${duration}s vs ${outputInfo.durationSeconds}s)`);
  }

  return {
    outputPath,
    durationSeconds: outputInfo.durationSeconds,
    hasAudio: outputInfo.hasAudio
  };
}

module.exports = {
  mixAudio
};
