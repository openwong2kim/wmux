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

# Helper: run native commands safely under Stop mode
# stderr from native executables (git, npm, winget) contains progress messages,
# which PowerShell converts to ErrorRecord objects. Under $ErrorActionPreference='Stop',
# these non-fatal messages would throw terminating exceptions. This wrapper:
#   1. Temporarily sets ErrorActionPreference to 'Continue' (prevents stderr→exception)
#   2. Filters out stderr ErrorRecord objects (progress noise)
#   3. Checks $LASTEXITCODE for real failures
function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )
    $backupEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                # stderr progress/info — silently discard
            } else {
                $_  # pass stdout through
            }
        } | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "'$Command $Arguments' failed with exit code $LASTEXITCODE"
        }
    } finally {
        $ErrorActionPreference = $backupEAP
    }
}

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

# Check and install Python (required by node-gyp for native modules)
if (-not (Get-Command python -ErrorAction SilentlyContinue) -or -not (& python --version 2>&1 | Select-String 'Python 3')) {
    Write-Host "  [*] Python 3 not found — installing via winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Invoke-NativeCommand winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements --silent
        $env:Path = "$env:LOCALAPPDATA\Programs\Python\Python312;$env:LOCALAPPDATA\Programs\Python\Python312\Scripts;$env:Path"
        Write-Host "  [*] Python 3.12 installed" -ForegroundColor Green
    } else {
        Write-Host "  [!] Python 3 is required for native modules. Install from https://www.python.org" -ForegroundColor Red
        exit 1
    }
}

# Check and install Visual Studio Build Tools (required by node-gyp for C++ compilation)
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasBuildTools = $false
if (Test-Path $vsWhere) {
    $vsInstalls = & $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json 2>$null | ConvertFrom-Json
    if ($vsInstalls.Count -gt 0) { $hasBuildTools = $true }
}
if (-not $hasBuildTools) {
    Write-Host "  [*] Visual Studio Build Tools not found — installing via winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Invoke-NativeCommand winget install Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
        # Install VSSetup module for node-gyp detection
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -ErrorAction SilentlyContinue | Out-Null
        Install-Module VSSetup -Scope CurrentUser -Force -AllowClobber -ErrorAction SilentlyContinue | Out-Null
        Write-Host "  [*] Visual Studio Build Tools installed" -ForegroundColor Green
    } else {
        Write-Host "  [!] Visual Studio Build Tools required. Install 'Desktop development with C++' workload." -ForegroundColor Red
        Write-Host "       https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Red
        exit 1
    }
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
    Invoke-NativeCommand git clone --depth 1 "https://github.com/$repo.git" $installDir
} else {
    Invoke-NativeCommand git clone --depth 1 --branch $version "https://github.com/$repo.git" $installDir
}

if (-not (Test-Path "$installDir\package.json")) {
    Write-Host "  [!] Clone failed" -ForegroundColor Red
    exit 1
}

Write-Host "  [2/4] Cloned to $installDir" -ForegroundColor Green

Write-Host "  [3/4] Installing dependencies..." -ForegroundColor DarkGray

Push-Location $installDir
try {
    Invoke-NativeCommand npm install --no-audit --no-fund

    # Rebuild native modules for Electron
    Invoke-NativeCommand npx electron-rebuild -f -w node-pty

    # Build CLI
    Invoke-NativeCommand npm run build:cli

    # Link CLI globally
    Invoke-NativeCommand npm link
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
