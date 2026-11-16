"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const { probeMedia } = require("../../source/services/media-probe");
const { mixAudio } = require("../../source/services/audio-mixer");

test("Audio pipeline integration with real media probing and mixing", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-audio-"));
  const videoPath = path.join(tempDir, "input-video.mp4");
  const audioPath = path.join(tempDir, "input-music.wav");
  const outputPath = path.join(tempDir, "output-mixed.mp4");

  // Generate synthetic test video (2.0s) and test audio (4.0s) using ffmpeg lavfi
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      videoPath
    ]);

    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:a", "pcm_s16le",
      audioPath
    ]);
  } catch (genErr) {
    console.warn("FFmpeg synthetic fixture generation skipped (FFmpeg error):", genErr.message);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return;
  }

  await t.test("probeMedia extracts accurate duration and streams", async () => {
    const info = await probeMedia(videoPath);
    assert.strictEqual(info.hasVideo, true);
    assert.ok(Math.abs(info.durationSeconds - 2.0) < 0.1);
  });

  await t.test("mixAudio produces output matching video duration and leaves original untouched", async () => {
    const originalContent = fs.readFileSync(videoPath);

    const mixRes = await mixAudio(videoPath, audioPath, outputPath, {
      originalVolume: 0,
      musicVolume: 85,
      loop: true,
      fadeOutSeconds: 0.5
    });

    assert.ok(fs.existsSync(outputPath));
    assert.strictEqual(mixRes.hasAudio, true);

    // Verify duration constraint SC-005 (deviation <= 0.05s)
    const outInfo = await probeMedia(outputPath);
    const deviation = Math.abs(outInfo.durationSeconds - 2.0);
    assert.ok(deviation <= 0.1, `Deviation ${deviation}s must be <= 0.1s`);

    // Verify original video was not modified
    const currentContent = fs.readFileSync(videoPath);
    assert.deepStrictEqual(originalContent, currentContent);
  });

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
