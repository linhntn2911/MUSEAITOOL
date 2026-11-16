# Automated smoke test for Muse Automation & TikTok Publishing
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$rootDir = (Get-Item $PSScriptRoot).Parent.FullName
Set-Location $rootDir

Write-Host "=== 1. Checking JS syntax on all source files ==="
$jsFiles = Get-ChildItem -Path "source" -Filter "*.js" -Recurse
foreach ($file in $jsFiles) {
    node -c $file.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Syntax error in $($file.FullName)"
    }
}
Write-Host "All $($jsFiles.Count) source files passed syntax check."

Write-Host "`n=== 2. Running unit, contract, and integration test suite ==="
node tests/run-all.js
if ($LASTEXITCODE -ne 0) {
    Write-Error "Test suite failed."
}

Write-Host "`n=== 3. Validating required modules and exports ==="
$checkScript = @"
const assert = require('assert');
const { StateStore } = require('./source/core/state-store');
const { logger, redactString } = require('./source/core/redacted-log');
const { createError, ERROR_CODES } = require('./source/core/errors');
const { validateJob, validateSettings, validateAccount } = require('./source/models/validators');
const { JOB_STATUSES, canTransition } = require('./source/models/state-machine');
const { TikTokController } = require('./source/tiktok/controller');
const { AccountManager } = require('./source/tiktok/account-manager');
const { ReconciliationManager } = require('./source/tiktok/reconciliation');
const { recalculateTimeline, resolveCollisions } = require('./source/tiktok/scheduler');
const { matchProduct } = require('./source/tiktok/product-matcher');
const { SecretStore } = require('./source/services/secret-store');
const { validateGeneratedContent } = require('./source/services/content-generator');
const { probeMedia } = require('./source/services/media-probe');
const { mixAudio } = require('./source/services/audio-mixer');
const { cleanupExpiredMedia } = require('./source/services/media-cleanup');

assert.ok(StateStore);
assert.ok(TikTokController);
assert.ok(AccountManager);
console.log('All modules successfully loaded and validated.');
"@

node -e $checkScript
if ($LASTEXITCODE -ne 0) {
    Write-Error "Module export validation failed."
}

Write-Host "`n=== SMOKE TEST PASSED SUCCESSFULLY ==="
