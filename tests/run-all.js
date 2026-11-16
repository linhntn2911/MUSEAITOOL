"use strict";
const { run } = require("node:test");
const { spec } = require("node:test/reporters");
const path = require("node:path");
const fs = require("node:fs");

function findTestFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      if (file !== "fixtures" && file !== "node_modules") {
        results = results.concat(findTestFiles(fullPath));
      }
    } else if (file.endsWith(".test.js")) {
      results.push(fullPath);
    }
  }
  return results;
}

const testFiles = findTestFiles(__dirname);
console.log(`Found ${testFiles.length} test files to execute.`);

if (testFiles.length === 0) {
  console.log("No tests executed.");
  process.exit(0);
}

run({ files: testFiles })
  .compose(new spec())
  .pipe(process.stdout);
