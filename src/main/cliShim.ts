/**
 * X4 — `wmux` CLI shim installation (Windows / Squirrel).
 *
 * The packaged app ships the bundled CLI at `<app>/resources/cli-bundle/index.js`.
 * To make `wmux` callable from any shell we drop a tiny `wmux.cmd` shim into
 * `<squirrelRoot>/bin` (a version-independent directory next to Update.exe)
 * and register that directory on the USER Path.
 *
 * Why regenerate on every install/update instead of locating `app-*` at
 * runtime: during `--squirrel-install` / `--squirrel-updated` the running
 * process IS the freshly installed version, so `process.execPath` is the
 * correct absolute target. A static absolute path keeps the shim trivial and
 * avoids fragile `dir /b /o-n` latest-version discovery in batch.
 *
 * PATH editing runs as ONE PowerShell invocation per operation (Squirrel
 * event handlers must not stall on serial spawns) and goes through the raw
 * registry, not [Environment]::Get/SetEnvironmentVariable:
 *   - read with GetValue(..., DoNotExpandEnvironmentNames) so existing
 *     `%VAR%` entries are NOT expanded-and-baked-in on rewrite,
 *   - write with Set-ItemProperty -Type ExpandString so REG_EXPAND_SZ is
 *     preserved (SetEnvironmentVariable demotes to REG_SZ),
 *   - broadcast WM_SETTINGCHANGE so newly opened shells see the change
 *     (a bare registry write never notifies Explorer).
 * `setx` is avoided entirely — it truncates values over 1024 chars.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/** Batch shim content. `setlocal` keeps ELECTRON_RUN_AS_NODE out of the calling shell. */
export function buildShimCmd(exePath: string, cliJsPath: string): string {
  return [
    '@echo off',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `call "${exePath}" "${cliJsPath}" %*`,
    'endlocal & exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/**
 * One-shot PowerShell script that adds/removes `binDir` on the user Path.
 *
 * The membership test is an exact, case-insensitive string match (PowerShell
 * `-eq` on strings is case-insensitive): install and uninstall always pass
 * the identical literal from deriveShimPaths, so no normalization beyond
 * trailing-separator trim is needed — and entries we did NOT add are passed
 * through byte-for-byte (quotes, `%VAR%` tokens and all).
 */
export function buildPathEditScript(binDir: string, op: 'add' | 'remove'): string {
  const escaped = binDir.replace(/'/g, "''");
  const mutate =
    op === 'add'
      ? `if (-not $hit) { $parts += $bin; $changed = $true }`
      : `if ($hit) { $parts = @($parts | Where-Object { $_.TrimEnd('\\','/') -ne $bin }); $changed = $true }`;
  return [
    `$bin = '${escaped}'.TrimEnd('\\','/')`,
    // Raw (unexpanded) read — keeps %VAR% entries intact across the rewrite.
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)`,
    `$cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
    `$parts = @($cur -split ';' | Where-Object { $_.Trim().Length -gt 0 })`,
    `$hit = [bool]($parts | Where-Object { $_.TrimEnd('\\','/') -eq $bin })`,
    `$changed = $false`,
    mutate,
    `if ($changed) {`,
    // ExpandString == REG_EXPAND_SZ — SetEnvironmentVariable would demote to REG_SZ.
    `  Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value ($parts -join ';') -Type ExpandString`,
    // WM_SETTINGCHANGE broadcast so new shells pick the change up without relogin.
    `  $sig = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'`,
    `  $w = Add-Type -MemberDefinition $sig -Name 'Win32SendMessageTimeout' -Namespace 'Wmux' -PassThru`,
    `  [System.UIntPtr]$res = [System.UIntPtr]::Zero`,
    `  $null = $w::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$res)`,
    `}`,
  ].join('\n');
}

function powershellExe(): string {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function runPathEdit(binDir: string, op: 'add' | 'remove'): void {
  execFileSync(
    powershellExe(),
    ['-NoProfile', '-NonInteractive', '-Command', buildPathEditScript(binDir, op)],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
}

export interface ShimPaths {
  /** Version-independent dir that receives wmux.cmd — `<squirrelRoot>/bin`. */
  binDir: string;
  /** Bundled CLI entry inside the current version's resources. */
  cliJsPath: string;
}

/**
 * Derive shim locations from the current executable (squirrel layout).
 * Uses path.win32 explicitly: the shim is Windows-only (Squirrel), and the
 * POSIX path module would treat a `C:\…` execPath as one relative segment —
 * which is also why the unit test must pass on the macOS/Linux CI baseline.
 */
export function deriveShimPaths(execPath: string): ShimPaths {
  const appDir = path.win32.dirname(execPath); // …\wmux\app-X.Y.Z
  const rootDir = path.win32.resolve(appDir, '..'); // …\wmux (Update.exe lives here)
  return {
    binDir: path.win32.join(rootDir, 'bin'),
    cliJsPath: path.win32.join(appDir, 'resources', 'cli-bundle', 'index.js'),
  };
}

/**
 * Install/refresh the CLI shim and register the bin dir on the user PATH.
 * Best-effort: callers run this inside Squirrel event handlers where a
 * failure must never block install/update — throws are caught and logged.
 */
export function installCliShim(execPath: string): void {
  try {
    const { binDir, cliJsPath } = deriveShimPaths(execPath);
    if (!fs.existsSync(cliJsPath)) {
      console.warn(`[cliShim] cli-bundle missing at ${cliJsPath} — skipping shim install`);
      return;
    }
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'wmux.cmd'), buildShimCmd(execPath, cliJsPath), 'utf8');
    runPathEdit(binDir, 'add');
  } catch (err) {
    console.warn('[cliShim] shim install failed (non-fatal):', err);
  }
}

/** Remove the shim and strip the bin dir from the user PATH. Best-effort. */
export function uninstallCliShim(execPath: string): void {
  try {
    const { binDir } = deriveShimPaths(execPath);
    try {
      fs.rmSync(binDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
    runPathEdit(binDir, 'remove');
  } catch (err) {
    console.warn('[cliShim] shim uninstall failed (non-fatal):', err);
  }
}
