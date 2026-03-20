#Requires -Version 5.1
<#
.SYNOPSIS
    wmux installer for Windows
.DESCRIPTION
    Downloads and installs wmux — AI Agent Terminal for Windows
.EXAMPLE
    irm https://raw.githubusercontent.com/openwong2kim/wmux/main/install.ps1 | iex
#>

$ErrorActionPreference = 'Stop'

$repo = 'openwong2kim/wmux'
$installDir = "$env:LOCALAPPDATA\wmux"

Write-Host ""
Write-Host "  wmux installer" -ForegroundColor Cyan
Write-Host "  AI Agent Terminal for Windows" -ForegroundColor DarkGray
Write-Host ""

# Check prerequisites
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [!] Node.js is required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

$nodeVersion = (node --version) -replace 'v', ''
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 18) {
    Write-Host "  [!] Node.js 18+ required (found v$nodeVersion)" -ForegroundColor Red
    exit 1
}

Write-Host "  [1/4] Checking latest release..." -ForegroundColor DarkGray

# Get latest release info from GitHub
try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'wmux-installer' }
    $version = $release.tag_name
    Write-Host "  [1/4] Latest version: $version" -ForegroundColor Green
} catch {
    # No releases yet — clone from main
    $version = "main"
    Write-Host "  [1/4] No releases found, installing from main branch" -ForegroundColor Yellow
}

Write-Host "  [2/4] Cloning repository..." -ForegroundColor DarkGray

if (Test-Path $installDir) {
    Remove-Item -Recurse -Force $installDir
}

if ($version -eq "main") {
    git clone --depth 1 "https://github.com/$repo.git" $installDir 2>&1 | Out-Null
} else {
    git clone --depth 1 --branch $version "https://github.com/$repo.git" $installDir 2>&1 | Out-Null
}

if (-not (Test-Path "$installDir\package.json")) {
    Write-Host "  [!] Clone failed" -ForegroundColor Red
    exit 1
}

Write-Host "  [2/4] Cloned to $installDir" -ForegroundColor Green

Write-Host "  [3/4] Installing dependencies..." -ForegroundColor DarkGray

Push-Location $installDir
try {
    npm install --no-audit --no-fund 2>&1 | Out-Null

    # Rebuild native modules for Electron
    npx electron-rebuild -f -w node-pty 2>&1 | Out-Null

    # Build CLI
    npm run build:cli 2>&1 | Out-Null

    # Link CLI globally
    npm link 2>&1 | Out-Null
} finally {
    Pop-Location
}

Write-Host "  [3/4] Dependencies installed" -ForegroundColor Green

# Verify
Write-Host "  [4/4] Verifying installation..." -ForegroundColor DarkGray

$wmuxPath = (Get-Command wmux -ErrorAction SilentlyContinue).Source
if ($wmuxPath) {
    Write-Host "  [4/4] wmux CLI available at: $wmuxPath" -ForegroundColor Green
} else {
    Write-Host "  [4/4] CLI linked (may need to restart terminal)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Usage:" -ForegroundColor Cyan
Write-Host "    cd $installDir" -ForegroundColor White
Write-Host "    npm start              # Run wmux" -ForegroundColor White
Write-Host "    npm run package        # Build executable" -ForegroundColor White
Write-Host "    wmux --help            # CLI help" -ForegroundColor White
Write-Host ""
