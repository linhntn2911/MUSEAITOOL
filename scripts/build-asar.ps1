# PowerShell build script for packaging source into app.pending.asar or app.asar
[CmdletBinding()]
param (
    [switch]$Direct = $false
)

$ErrorActionPreference = "Stop"
$rootDir = (Get-Item $PSScriptRoot).Parent.FullName
$sourceDir = Join-Path $rootDir "source"
$resourcesDir = Join-Path $rootDir "resources"
$packerScript = Join-Path $PSScriptRoot "pack-asar.js"

if (-not (Test-Path $sourceDir)) {
    Write-Error "Source directory not found at $sourceDir"
}

if (-not (Test-Path $resourcesDir)) {
    New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null
}

$targetAsar = if ($Direct) {
    Join-Path $resourcesDir "app.asar"
} else {
    Join-Path $resourcesDir "app.pending.asar"
}

Write-Host "Packaging source from $sourceDir to $targetAsar..."
node $packerScript $sourceDir $targetAsar

if (Test-Path $targetAsar) {
    Write-Host "ASAR build completed successfully: $targetAsar (Size: $((Get-Item $targetAsar).Length) bytes)"
} else {
    Write-Error "Failed to build asar: target file not created."
}
