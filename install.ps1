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

# Enforce TLS 1.2+ for all HTTPS calls (prevents downgrade on older Windows)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Fix encoding: native commands (git, winget, npm) output UTF-8,
# but PowerShell defaults to system locale (e.g. CP949 on Korean Windows)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Run native commands safely under $ErrorActionPreference='Stop'.
# ScriptBlock preserves caller's quoting. Stderr is collected and shown on failure.
# Stdout passes through to the host for diagnostic visibility.
function Invoke-NativeCommand {
    param([Parameter(Mandatory)][ScriptBlock]$ScriptBlock)
    $backupEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $stderrLines = @()
        & $ScriptBlock 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $stderrLines += $_.ToString()
            } else {
                Write-Host $_
            }
        }
        if ($LASTEXITCODE -ne 0) {
            $stderrMsg = if ($stderrLines.Count -gt 0) { "`n" + ($stderrLines -join "`n") } else { "" }
            throw "Command failed with exit code $LASTEXITCODE$stderrMsg"
        }
    } finally {
        $ErrorActionPreference = $backupEAP
    }
}

# Run native commands silently (stdout suppressed), for commands where output is noise.
function Invoke-NativeCommandSilent {
    param([Parameter(Mandatory)][ScriptBlock]$ScriptBlock)
    $backupEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $stderrLines = @()
        & $ScriptBlock 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $stderrLines += $_.ToString()
            }
            # stdout silently discarded
        }
        if ($LASTEXITCODE -ne 0) {
            $stderrMsg = if ($stderrLines.Count -gt 0) { "`n" + ($stderrLines -join "`n") } else { "" }
            throw "Command failed with exit code $LASTEXITCODE$stderrMsg"
        }
    } finally {
        $ErrorActionPreference = $backupEAP
    }
}

# Run winget install, tolerating "already installed" and "reboot required" exit codes.
function Invoke-WingetInstall {
    param([Parameter(Mandatory)][ScriptBlock]$ScriptBlock)
    $backupEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $stderrLines = @()
        & $ScriptBlock 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $stderrLines += $_.ToString()
            } else {
                Write-Host $_
            }
        }
        # 0              = success
        # -1978335189    = already installed
        # -1978335140    = no applicable upgrade
        # 3010           = reboot required (success, but needs restart)
        $acceptableCodes = @(0, -1978335189, -1978335140, 3010)
        if ($LASTEXITCODE -notin $acceptableCodes) {
            $stderrMsg = if ($stderrLines.Count -gt 0) { "`n" + ($stderrLines -join "`n") } else { "" }
            throw "winget failed with exit code $LASTEXITCODE$stderrMsg"
        }
        if ($LASTEXITCODE -eq 3010) {
            Write-Host "  [*] A reboot may be required to complete the installation" -ForegroundColor Yellow
        }
    } finally {
        $ErrorActionPreference = $backupEAP
    }
}

# Safely capture stdout from a native command.
function Get-NativeOutput {
    param([Parameter(Mandatory)][ScriptBlock]$ScriptBlock)
    $backupEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $ScriptBlock 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { } else { $_ }
        }
        return ($output | Out-String).Trim()
    } finally {
        $ErrorActionPreference = $backupEAP
    }
}

# PS 5.1-safe JSON parsing. ConvertFrom-Json returns PSCustomObject for single-element
# arrays in PS 5.1 (no .Count). Also handles malformed/non-JSON output gracefully.
function ConvertFrom-JsonSafe {
    param([string]$Json)
    if (-not $Json -or $Json.Trim() -eq '') { return @() }
    try {
        $result = $Json | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return @()
    }
    if ($null -eq $result) { return @() }
    return @($result)
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

$repo = 'openwong2kim/wmux'
$installDir = "$env:LOCALAPPDATA\wmux"

if (-not $env:LOCALAPPDATA -or -not $installDir) {
    Write-Host "  [!] Cannot determine install directory (LOCALAPPDATA is not set)" -ForegroundColor Red
    return
}

Write-Host ""
Write-Host "  wmux installer" -ForegroundColor Cyan
Write-Host "  AI Agent Terminal for Windows" -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

# Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "  [!] Git is required. Install from https://git-scm.com" -ForegroundColor Red
    return
}

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [!] Node.js 18+ is required. Install from https://nodejs.org" -ForegroundColor Red
    return
}

$nodeVersion = (Get-NativeOutput { node --version }) -replace 'v', ''
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 18) {
    Write-Host "  [!] Node.js 18+ required (found v$nodeVersion)" -ForegroundColor Red
    return
}

# Python 3 (required by node-gyp)
$hasPython3 = $false
if (Get-Command python -ErrorAction SilentlyContinue) {
    $pyVer = Get-NativeOutput { python --version }
    if ($pyVer -match 'Python 3') { $hasPython3 = $true }
}
if (-not $hasPython3) {
    Write-Host "  [*] Python 3 not found — installing via winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Invoke-WingetInstall { winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements --silent }
        # Discover actual install path dynamically
        $pyPath = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python" -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^Python3' } |
            Sort-Object Name -Descending |
            Select-Object -First 1
        if ($pyPath -and (Test-Path "$($pyPath.FullName)\python.exe")) {
            $env:Path = "$($pyPath.FullName);$($pyPath.FullName)\Scripts;$env:Path"
            Write-Host "  [*] Python installed ($($pyPath.Name))" -ForegroundColor Green
        } else {
            Write-Host "  [!] Python was installed but could not locate the install directory" -ForegroundColor Yellow
            Write-Host "       Restart your terminal and re-run the installer" -ForegroundColor Yellow
            return
        }
    } else {
        Write-Host "  [!] Python 3 is required for native modules." -ForegroundColor Red
        Write-Host "       Option 1: Install winget — https://aka.ms/getwinget" -ForegroundColor Red
        Write-Host "       Option 2: Install Python manually — https://www.python.org" -ForegroundColor Red
        return
    }
}

# Visual Studio Build Tools / VCTools workload (required by node-gyp for C++ compilation)
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVCTools = $false

if (Test-Path $vsWhere) {
    $vsWithVCJson = Get-NativeOutput { & $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json }
    $vsWithVC = @(ConvertFrom-JsonSafe $vsWithVCJson)
    if ($vsWithVC.Count -gt 0) { $hasVCTools = $true }
}

if (-not $hasVCTools) {
    # Check if Build Tools product exists (without VCTools workload)
    $buildToolsInstanceId = $null
    if (Test-Path $vsWhere) {
        $btJson = Get-NativeOutput { & $vsWhere -products Microsoft.VisualStudio.Product.BuildTools -format json }
        $btInstalls = @(ConvertFrom-JsonSafe $btJson)
        if ($btInstalls.Count -gt 0) {
            $buildToolsInstallPath = $btInstalls[0].installationPath
        }
    }

    if ($buildToolsInstallPath) {
        # Build Tools installed but VCTools workload missing — modify via setup.exe
        # Note: vs_installer.exe delegates to setup.exe which has a different arg schema.
        # --instanceId and --wait are not recognized by setup.exe (exit code 87).
        # Use setup.exe directly with --installPath.
        Write-Host "  [*] Build Tools found but C++ workload missing — adding VCTools..." -ForegroundColor Yellow
        $setupExe = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe"
        if (Test-Path $setupExe) {
            Invoke-NativeCommand { & "$setupExe" modify --installPath "$buildToolsInstallPath" --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --norestart }
            Write-Host "  [*] C++ workload added" -ForegroundColor Green
        } else {
            Write-Host "  [!] VS setup.exe not found. Add 'Desktop development with C++' workload manually." -ForegroundColor Red
            Write-Host "       Open Visual Studio Installer → Modify → check 'Desktop development with C++'" -ForegroundColor Red
            return
        }
    } else {
        # Build Tools not installed — fresh install via winget
        Write-Host "  [*] Visual Studio Build Tools not found — installing via winget..." -ForegroundColor Yellow
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Invoke-WingetInstall { winget install Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements --override "--passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" }
            Write-Host "  [*] Visual Studio Build Tools installed" -ForegroundColor Green
        } else {
            Write-Host "  [!] Visual Studio Build Tools required." -ForegroundColor Red
            Write-Host "       Option 1: Install winget — https://aka.ms/getwinget" -ForegroundColor Red
            Write-Host "       Option 2: Install manually — https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Red
            Write-Host "                 Select 'Desktop development with C++' workload" -ForegroundColor Red
            return
        }
    }

    # Wait for VS setup processes to finish before verification.
    # setup.exe spawns an elevated child process and returns immediately (non-blocking).
    # Actual installation runs in background and can take 150s+.
    Write-Host "  [*] Waiting for VS installer to finish..." -ForegroundColor DarkGray -NoNewline
    $setupWaitElapsed = 0
    while ($setupWaitElapsed -lt 600) {
        $setupProcs = Get-Process -Name "setup" -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -like "*Visual Studio*" }
        if (-not $setupProcs) { break }
        Write-Host "." -NoNewline
        Start-Sleep -Seconds 10
        $setupWaitElapsed += 10
    }
    Write-Host ""

    # Post-install verification: confirm VCTools is actually available.
    # vswhere may have been installed just now as part of Build Tools,
    # so re-check the path (it may not have existed at script start).
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    Write-Host "  [*] Verifying VCTools installation..." -ForegroundColor DarkGray -NoNewline
    $retries = 0
    $maxRetries = 24  # 120 seconds max wait
    while ($retries -lt $maxRetries) {
        if (Test-Path $vsWhere) {
            $checkJson = Get-NativeOutput { & $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json }
            $checkResult = @(ConvertFrom-JsonSafe $checkJson)
            if ($checkResult.Count -gt 0) {
                $hasVCTools = $true
                break
            }
        }
        Write-Host "." -NoNewline
        Start-Sleep -Seconds 5
        $retries++
    }
    Write-Host ""  # newline after dots
    if (-not $hasVCTools) {
        Write-Host "  [!] VCTools not detected after installation (waited ${maxRetries}x5s)." -ForegroundColor Red
        Write-Host "       A reboot may be required. Restart and re-run this installer." -ForegroundColor Red
        return
    }
    Write-Host "  [*] VCTools verified" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

Write-Host "  [1/5] Checking latest release..." -ForegroundColor DarkGray

try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" `
        -Headers @{ 'User-Agent' = 'wmux-installer' } `
        -TimeoutSec 15
    $version = $release.tag_name
    # Validate version format
    if ($version -notmatch '^v?\d+\.\d+') {
        Write-Host "  [1/5] Unexpected version format '$version', using main branch" -ForegroundColor Yellow
        $version = "main"
    } else {
        Write-Host "  [1/5] Latest version: $version" -ForegroundColor Green
    }
} catch {
    $version = "main"
    Write-Host "  [1/5] No releases found, installing from main branch ($($_.Exception.Message))" -ForegroundColor Yellow
}

Write-Host "  [2/5] Cloning repository..." -ForegroundColor DarkGray

if (Test-Path $installDir) {
    # Check for junction/symlink before removing
    $dirItem = Get-Item $installDir -Force -ErrorAction SilentlyContinue
    if ($dirItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Write-Host "  [!] $installDir is a symbolic link or junction — removing link only" -ForegroundColor Yellow
        $dirItem.Delete()
    } else {
        try {
            Remove-Item -Recurse -Force $installDir -ErrorAction Stop
        } catch {
            Write-Host "  [!] Cannot remove existing install: $_" -ForegroundColor Red
            Write-Host "       Close wmux and any terminals using $installDir, then re-run." -ForegroundColor Red
            return
        }
    }
}

if ($version -eq "main") {
    Invoke-NativeCommandSilent { git clone --depth 1 "https://github.com/$repo.git" "$installDir" }
} else {
    Invoke-NativeCommandSilent { git clone --depth 1 --branch $version "https://github.com/$repo.git" "$installDir" }
}

if (-not (Test-Path "$installDir\package.json")) {
    Write-Host "  [!] Clone failed" -ForegroundColor Red
    return
}

Write-Host "  [2/5] Cloned to $installDir" -ForegroundColor Green

Write-Host "  [3/5] Installing dependencies..." -ForegroundColor DarkGray

Push-Location $installDir
try {
    Invoke-NativeCommand { npm install --no-audit --no-fund }

    # Rebuild native modules for Electron
    Invoke-NativeCommand { npx electron-rebuild -f -w node-pty }

    # Build CLI
    Invoke-NativeCommand { npm run build:cli }

    # Build Electron app (.exe installer)
    Write-Host "  [4/5] Building app..." -ForegroundColor DarkGray
    Invoke-NativeCommand { npm run make }
    Write-Host "  [4/5] App built" -ForegroundColor Green

    # Link CLI globally — may fail without admin/Developer Mode (symlink permissions).
    # Falls back to a .cmd wrapper + user PATH entry.
    try {
        Invoke-NativeCommand { npm link }
    } catch {
        Write-Host "  [*] npm link failed (needs admin or Developer Mode) — using PATH fallback" -ForegroundColor Yellow
        $cliEntry = "$installDir\dist\cli\cli\index.js"
        if (-not (Test-Path $cliEntry)) {
            Write-Host "  [!] CLI build output not found at $cliEntry" -ForegroundColor Red
            return
        }
        # Create a .cmd wrapper
        $nodePath = (Get-Command node).Source
        $wmuxCmd = "$installDir\wmux.cmd"
        Set-Content -Path $wmuxCmd -Value "@echo off`r`n`"$nodePath`" `"$cliEntry`" %*" -Encoding ASCII
        # Add to user PATH persistently (exact match, not substring)
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $pathEntries = if ($userPath) { $userPath.Split(';') } else { @() }
        if ($installDir -notin $pathEntries) {
            [Environment]::SetEnvironmentVariable('Path', "$installDir;$userPath", 'User')
            $env:Path = "$installDir;$env:Path"
            Write-Host "  [*] Added $installDir to user PATH" -ForegroundColor Green
        }
    }
} finally {
    Pop-Location
}

Write-Host "  [3/5] Dependencies installed" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

Write-Host "  [5/5] Verifying installation..." -ForegroundColor DarkGray

$wmuxPath = (Get-Command wmux -ErrorAction SilentlyContinue).Source
if ($wmuxPath) {
    Write-Host "  [5/5] wmux CLI available at: $wmuxPath" -ForegroundColor Green
} else {
    Write-Host "  [5/5] CLI linked (restart terminal to use 'wmux' command)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Usage:" -ForegroundColor Cyan
Write-Host "    cd $installDir" -ForegroundColor White
Write-Host "    npm start              # Run wmux (dev mode)" -ForegroundColor White
Write-Host "    npm run make           # Build installer (.exe)" -ForegroundColor White
Write-Host "    wmux --help            # CLI help" -ForegroundColor White
Write-Host ""
