"use strict";

const fs = require("node:fs");
const path = require("node:path");

function walkDir(dir, baseDir = dir) {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      files.push({ path: relPath, isDir: true });
      files = files.concat(walkDir(fullPath, baseDir));
    } else {
      files.push({ path: relPath, isDir: false, fullPath, size: fs.statSync(fullPath).size });
    }
  }
  return files;
}

function createAsarArchive(sourceDir, destFile) {
  const allEntries = walkDir(sourceDir);
  const header = { files: {} };
  let currentOffset = 0;

  for (const entry of allEntries) {
    const parts = entry.path.split("/");
    let current = header.files;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        if (entry.isDir) {
          if (!current[part]) current[part] = { files: {} };
        } else {
          current[part] = {
            size: entry.size,
            offset: String(currentOffset)
          };
          currentOffset += entry.size;
        }
      } else {
        if (!current[part]) current[part] = { files: {} };
        current = current[part].files;
      }
    }
  }

  const jsonHeader = JSON.stringify(header);
  const jsonHeaderBuffer = Buffer.from(jsonHeader, "utf8");

  // Asar pickle header format:
  // 4 bytes: uint32 header size (headerBuf.length + 8)
  // 4 bytes: uint32 payload size (headerBuf.length + 4)
  // 4 bytes: uint32 json length + 4
  // 4 bytes: uint32 json length
  // jsonHeaderBuffer
  // padding to 4-byte boundary
  const align = (n) => (n % 4 === 0 ? n : n + (4 - (n % 4)));
  const jsonPaddedSize = align(jsonHeaderBuffer.length);
  const paddedJsonBuf = Buffer.alloc(jsonPaddedSize);
  jsonHeaderBuffer.copy(paddedJsonBuf);

  const headerPickleSize = jsonPaddedSize + 8;
  const headerBuf = Buffer.alloc(16);
  headerBuf.writeUInt32LE(4, 0); // pickle size
  headerBuf.writeUInt32LE(headerPickleSize, 4); // payload size
  headerBuf.writeUInt32LE(headerPickleSize - 4, 8); // payload size - 4
  headerBuf.writeUInt32LE(jsonHeaderBuffer.length, 12); // json length

  const destDir = path.dirname(destFile);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const outFd = fs.openSync(destFile, "w");
  fs.writeSync(outFd, headerBuf);
  fs.writeSync(outFd, paddedJsonBuf);

  const fileEntries = allEntries.filter(e => !e.isDir);
  const readBuf = Buffer.alloc(65536);
  for (const file of fileEntries) {
    const inFd = fs.openSync(file.fullPath, "r");
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(inFd, readBuf, 0, readBuf.length, null)) > 0) {
      fs.writeSync(outFd, readBuf, 0, bytesRead);
    }
    fs.closeSync(inFd);
  }
  fs.closeSync(outFd);

  console.log(`Successfully packed ${fileEntries.length} files into ${destFile}`);
}

if (require.main === module) {
  const src = process.argv[2] || path.join(__dirname, "..", "source");
  const dest = process.argv[3] || path.join(__dirname, "..", "resources", "app.pending.asar");
  createAsarArchive(src, dest);
}

module.exports = { createAsarArchive };
