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
 *   - read the raw value so existing `%VAR%` entries are NOT
 *     expanded-and-baked-in on rewrite,
 *   - write with Set-ItemProperty -Type ExpandString so REG_EXPAND_SZ is
 *     preserved (SetEnvironmentVariable demotes to REG_SZ),
 *   - broadcast WM_SETTINGCHANGE so newly opened shells see the change
 *     (a bare registry write never notifies Explorer).
 * `setx` is avoided entirely — it truncates values over 1024 chars.
 *
 * The PATH edit is a read-modify-write against a value whose loss is
 * unrecoverable, so it is built to FAIL CLOSED. Every rule below exists
 * because the original version violated it and wiped user PATHs outright:
 *
 *   1. The write only ever runs on a *trusted* read. `[Microsoft.Win32.Registry]`
 *      method calls throw under ConstrainedLanguage (AppLocker/WDAC lock down
 *      enterprise machines this way), but `Set-ItemProperty` keeps working —
 *      so a script that reads with .NET and writes with a cmdlet silently
 *      resolves the current PATH to empty and then persists `<binDir>` as the
 *      user's ENTIRE PATH. `reg.exe` is an external process, so it is immune
 *      to language mode AND returns the raw (unexpanded) value, which
 *      `Get-ItemProperty` does not. It is the fallback reader; when both
 *      readers fail we exit without touching the registry.
 *   2. A structural invariant is asserted between the read and the write: no
 *      pre-existing entry other than `binDir` may disappear. Any future bug
 *      that resolves the current PATH to the wrong thing aborts here instead
 *      of persisting.
 *   3. The pre-edit raw value is copied to HKCU:\Software\wmux\UserPathBackup
 *      first (NOT into HKCU:\Environment, where a stray value would become a
 *      bogus environment variable).
 *   4. The WM_SETTINGCHANGE broadcast is best-effort and isolated: `Add-Type`
 *      is blocked under ConstrainedLanguage, and a cosmetic notification
 *      failure must not be reported as an edit failure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Batch shim content. Uses `%~dp0` (the shim's own directory, `<squirrelRoot>/bin`)
 * to dynamically discover the latest `app-*` directory at runtime, instead of
 * hardcoding a version-specific path. This survives Squirrel updates even if
 * the `--squirrel-updated` handler fails to regenerate the shim.
 *
 * `dir /b /ad /o-d` lists directories matching `app-*` sorted newest-first
 * (by modification time). The first match is the current version.
 */
export function buildShimCmd(): string {
  return [
    '@echo off',
    // DisableDelayedExpansion explicitly: a parent `cmd /v:on` shell would
    // otherwise be inherited and eat literal `!` in forwarded arguments.
    'setlocal DisableDelayedExpansion',
    'set "ELECTRON_RUN_AS_NODE=1"',
    'for /f "delims=" %%i in (\'dir /b /ad /o-d "%~dp0..\\app-*" 2^>nul\') do (',
    // No `call` — it is only needed for batch files and would re-expand
    // %-sequences and carets in the forwarded arguments.
    '  "%~dp0..\\%%i\\wmux.exe" "%~dp0..\\%%i\\resources\\cli-bundle\\index.js" %*',
    '  goto :wmux_done',
    ')',
    'echo wmux: no app directory found in "%~dp0.." >&2',
    'exit /b 1',
    ':wmux_done',
    'endlocal & exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/**
 * Exit codes from the PATH edit script. Anything non-zero other than these is
 * an unexpected PowerShell failure. All of them mean "registry NOT modified".
 */
export const PATH_EDIT_EXIT = {
  /** Registry unreadable by both strategies — refused to write. */
  READ_FAILED: 10,
  /** Computed result would have dropped unrelated entries — refused to write. */
  INVARIANT_VIOLATED: 11,
} as const;

/**
 * One-shot PowerShell script that adds/removes `binDir` on the user Path.
 *
 * The membership test is an exact, case-insensitive string match (PowerShell
 * `-eq` on strings is case-insensitive): install and uninstall always pass
 * the identical literal from deriveShimPaths, so no normalization beyond
 * trailing-separator trim is needed — and entries we did NOT add are passed
 * through byte-for-byte (quotes, `%VAR%` tokens and all).
 *
 * See the module header for why the read/write asymmetry below is load-bearing.
 *
 * `subKey`/`backupSubKey` exist so the regression test can execute the real
 * script against throwaway HKCU subkeys instead of the user's actual
 * Environment. Production callers must never pass them.
 */
export function buildPathEditScript(
  binDir: string,
  op: 'add' | 'remove',
  subKey = 'Environment',
  backupSubKey = 'Software\\wmux',
): string {
  const escaped = binDir.replace(/'/g, "''");
  // PowerShell single-quoted literals treat `\` literally, so only `'` needs escaping.
  const key = subKey.replace(/'/g, "''");
  const bakKey = backupSubKey.replace(/'/g, "''");
  const mutate =
    op === 'add'
      ? `if (-not $hit) { $parts += $bin; $changed = $true }`
      : `if ($hit) { $parts = @($parts | Where-Object { $_.TrimEnd('\\','/') -ne $bin }); $changed = $true }`;
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$bin = '${escaped}'.TrimEnd('\\','/')`,
    ``,
    // ── Read the CURRENT raw user Path ──────────────────────────────────────
    // Strategy 1 (fast path): .NET raw read. Throws under ConstrainedLanguage.
    `$cur = $null`,
    `try {`,
    `  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}', $false)`,
    `  if ($null -ne $key) {`,
    `    $cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
    `  }`,
    `} catch { $cur = $null }`,
    ``,
    // Strategy 2: reg.exe — immune to language mode, and unlike Get-ItemProperty
    // it returns the value UNEXPANDED, so %VAR% entries survive the rewrite.
    // Queries the whole key (not /v Path) so "value absent" is distinguishable
    // from "key unreadable": a fresh profile legitimately has no user Path.
    `if ($null -eq $cur) {`,
    `  try {`,
    `    $prevEap = $ErrorActionPreference`,
    `    $ErrorActionPreference = 'Continue'`,
    `    $out = & "$env:SystemRoot\\System32\\reg.exe" query 'HKCU\\${key}' 2>$null`,
    `    $rc = $LASTEXITCODE`,
    `    $ErrorActionPreference = $prevEap`,
    `    if ($rc -eq 0) {`,
    `      $cur = ''`,
    `      foreach ($line in $out) {`,
    `        if ($line -match '^\\s+Path\\s+(REG_\\S+)\\s{4}(.*)$') {`,
    // An unexpected value type means we do not understand the current state.
    `          if ($matches[1] -ne 'REG_EXPAND_SZ' -and $matches[1] -ne 'REG_SZ') { exit ${PATH_EDIT_EXIT.READ_FAILED} }`,
    `          $cur = $matches[2]`,
    `          break`,
    `        }`,
    `      }`,
    `    }`,
    `  } catch { $cur = $null }`,
    `}`,
    // Fail closed: never derive a write from a read that did not happen.
    `if ($null -eq $cur) { exit ${PATH_EDIT_EXIT.READ_FAILED} }`,
    ``,
    // ── Compute the edit ────────────────────────────────────────────────────
    `$parts = @($cur -split ';' | Where-Object { $_.Trim().Length -gt 0 })`,
    `$orig = @($parts)`,
    `$hit = [bool]($parts | Where-Object { $_.TrimEnd('\\','/') -eq $bin })`,
    `$changed = $false`,
    mutate,
    `if (-not $changed) { exit 0 }`,
    ``,
    // ── Invariant: this edit may only ever touch $bin ────────────────────────
    `$lost = @($orig | Where-Object { $_.TrimEnd('\\','/') -ne $bin } | Where-Object { $parts -notcontains $_ })`,
    `if ($lost.Count -gt 0) { exit ${PATH_EDIT_EXIT.INVARIANT_VIOLATED} }`,
    op === 'add'
      ? `if ($parts -notcontains $bin) { exit ${PATH_EDIT_EXIT.INVARIANT_VIOLATED} }`
      : `if ($parts | Where-Object { $_.TrimEnd('\\','/') -eq $bin }) { exit ${PATH_EDIT_EXIT.INVARIANT_VIOLATED} }`,
    ``,
    // ── Back up, then write ─────────────────────────────────────────────────
    // Backup lives under Software\wmux, NOT Environment: any value written
    // there becomes a real environment variable for the user.
    `try {`,
    `  if (-not (Test-Path 'HKCU:\\${bakKey}')) { New-Item -Path 'HKCU:\\${bakKey}' -Force | Out-Null }`,
    `  Set-ItemProperty -Path 'HKCU:\\${bakKey}' -Name 'UserPathBackup' -Value $cur -Type String`,
    `} catch { }`,
    // ExpandString == REG_EXPAND_SZ — SetEnvironmentVariable would demote to REG_SZ.
    `Set-ItemProperty -Path 'HKCU:\\${key}' -Name 'Path' -Value ($parts -join ';') -Type ExpandString`,
    ``,
    // WM_SETTINGCHANGE broadcast so new shells pick the change up without
    // relogin. Cosmetic and Add-Type is blocked under ConstrainedLanguage, so
    // its failure must never mask a successful write.
    `try {`,
    `  $sig = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'`,
    `  $w = Add-Type -MemberDefinition $sig -Name 'Win32SendMessageTimeout' -Namespace 'Wmux' -PassThru`,
    `  [System.UIntPtr]$res = [System.UIntPtr]::Zero`,
    `  $null = $w::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$res)`,
    `} catch { }`,
    `exit 0`,
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

/**
 * Human-readable explanation for a PATH edit that refused to run, or null when
 * the exit code is not one of our deliberate fail-closed bail-outs.
 */
export function explainPathEditExit(code: number, binDir: string): string | null {
  switch (code) {
    case PATH_EDIT_EXIT.READ_FAILED:
      return (
        `could not read the current user PATH from the registry, so it was left ` +
        `untouched. This usually means PowerShell is locked to ConstrainedLanguage ` +
        `by AppLocker/WDAC policy. Add "${binDir}" to your PATH manually to use the ` +
        `wmux CLI.`
      );
    case PATH_EDIT_EXIT.INVARIANT_VIOLATED:
      return (
        `the computed PATH would have dropped unrelated entries, so the edit was ` +
        `aborted and the registry left untouched. Add "${binDir}" to your PATH manually.`
      );
    default:
      return null;
  }
}

function runPathEdit(binDir: string, op: 'add' | 'remove'): void {
  try {
    execFileSync(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-Command', buildPathEditScript(binDir, op)],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
  } catch (err) {
    const code = (err as { status?: number }).status;
    const explained = typeof code === 'number' ? explainPathEditExit(code, binDir) : null;
    // A deliberate bail-out is a warning, not a failure: the registry is intact
    // and the only cost is that the CLI is not on PATH yet.
    if (explained) {
      console.warn(`[cliShim] PATH ${op} skipped — ${explained}`);
      return;
    }
    throw err;
  }
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
    fs.writeFileSync(path.join(binDir, 'wmux.cmd'), buildShimCmd(), 'utf8');
    runPathEdit(binDir, 'add');
  } catch (err) {
    console.warn('[cliShim] shim install failed (non-fatal):', err);
  }
}

// ─── macOS (darwin) CLI shim ─────────────────────────────────────────────────
//
// DMG/ZIP 설치에는 Squirrel 같은 설치 훅이 없으므로 첫 실행 시 1회,
// `/usr/local/bin/wmux` → <앱 번들>/Contents/Resources/cli-bundle/index.js
// 심링크를 시도한다(권한 실패 시 `~/.local/bin/wmux` 폴백). cli-bundle 진입점은
// `#!/usr/bin/env node` shebang을 가진 esbuild 번들이라 심링크 + exec bit만으로
// 셸에서 직접 실행된다(chmod는 내용 해시를 바꾸지 않아 codesign seal에 안전).
//
// 소유권 규칙: 기존 파일이 "우리 것"(wmux 앱 번들 내 cli-bundle 진입점을 가리키는
// 심링크)이 아니면 절대 건드리지 않는다 — Homebrew cask 등 다른 설치 경로와의
// 충돌 방지. 우리 것이지만 타깃이 옛 번들 경로면 현재 타깃으로 갱신한다.

/** installCliShimDarwin의 결과. guidance는 사용자에게 보여줄 안내(없으면 null). */
export interface DarwinShimInstallResult {
  status: 'installed' | 'already' | 'foreign' | 'failed';
  linkPath: string | null;
  guidance: string | null;
}

/** darwin 실행 파일 경로에서 번들 내 CLI 진입점을 유도한다. */
export function deriveDarwinCliTarget(execPath: string): string {
  // <bundle>/Contents/MacOS/wmux → <bundle>/Contents/Resources/cli-bundle/index.js
  const contentsDir = path.posix.resolve(path.posix.dirname(execPath), '..');
  return path.posix.join(contentsDir, 'Resources', 'cli-bundle', 'index.js');
}

/** 심링크 타깃이 wmux 앱 번들 내 cli-bundle 진입점인지("우리 것") 판정. */
export function isOwnedWmuxTarget(linkTarget: string): boolean {
  return linkTarget.endsWith('/Contents/Resources/cli-bundle/index.js');
}

/**
 * darwin CLI 심링크 설치. 후보 경로를 순서대로 시도하고, 권한류 실패
 * (EACCES/EPERM/EROFS/ENOENT)는 다음 후보로 폴백한다. 순수 fs 조작만 하며
 * throw하지 않는다 — 결과는 DarwinShimInstallResult로 보고.
 */
export function installCliShimDarwin(
  execPath: string = process.execPath,
  opts: { homeDir?: string; envPath?: string; candidates?: string[] } = {},
): DarwinShimInstallResult {
  const homeDir = opts.homeDir ?? (process.env.HOME || '');
  const envPath = opts.envPath ?? (process.env.PATH || '');
  const target = deriveDarwinCliTarget(execPath);

  if (!fs.existsSync(target)) {
    console.warn(`[cliShim] cli-bundle missing at ${target} — skipping darwin shim install`);
    return { status: 'failed', linkPath: null, guidance: null };
  }
  // shebang 실행에 필요한 exec bit 보장(패키징이 bit를 떨굴 수 있음). best-effort.
  try {
    fs.chmodSync(target, 0o755);
  } catch { /* best-effort */ }

  const fallbackDir = path.posix.join(homeDir, '.local', 'bin');
  const candidates = opts.candidates ?? ['/usr/local/bin/wmux', path.posix.join(fallbackDir, 'wmux')];

  for (const linkPath of candidates) {
    // 기존 항목 검사 — 우리 것이 아니면 어떤 후보든 즉시 손을 뗀다
    // (Homebrew cask 등 기존 설치가 이미 `wmux`를 제공 중).
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(linkPath);
    } catch { /* 없음 — 새로 생성 */ }

    if (existing) {
      if (!existing.isSymbolicLink()) {
        return { status: 'foreign', linkPath, guidance: null };
      }
      let linkTarget = '';
      try {
        linkTarget = fs.readlinkSync(linkPath);
      } catch { /* 읽기 실패 → foreign 취급 */ }
      if (linkTarget === target) {
        return { status: 'already', linkPath, guidance: null };
      }
      if (!isOwnedWmuxTarget(linkTarget)) {
        return { status: 'foreign', linkPath, guidance: null };
      }
      // 우리 것이지만 옛 번들을 가리킴 — 현재 타깃으로 갱신 시도.
      try {
        fs.unlinkSync(linkPath);
      } catch {
        continue; // 권한 없음 → 다음 후보로 폴백
      }
    }

    try {
      fs.mkdirSync(path.posix.dirname(linkPath), { recursive: true });
      fs.symlinkSync(target, linkPath);
    } catch {
      continue; // EACCES/EPERM/EROFS 등 → 다음 후보로 폴백
    }

    // 폴백 디렉토리가 PATH에 없으면 안내 문자열을 돌려준다.
    const linkDir = path.posix.dirname(linkPath);
    const onPath = envPath
      .split(':')
      .some((p) => p.replace(/\/+$/, '') === linkDir);
    const guidance = onPath
      ? null
      : `wmux CLI installed at ${linkPath}, but ${linkDir} is not on your PATH. ` +
        `Add it with: echo 'export PATH="${linkDir}:$PATH"' >> ~/.zshrc`;
    return { status: 'installed', linkPath, guidance };
  }

  return { status: 'failed', linkPath: null, guidance: null };
}

/**
 * Whether a wmux-OWNED darwin shim exists but no longer targets the current
 * bundle — a stale target (app moved) or a target that no longer exists on disk
 * (DMG ejected). Used so the one-time install marker does not gate out repair:
 * the first packaged launch can happen from a DMG/ZIP temp path, and once that
 * volume is gone the owned symlink points at a dead file forever otherwise.
 *
 * Returns false for a correct link (no repair), for foreign links/files (never
 * touch a Homebrew cask etc.), and when no candidate link exists (respect the
 * one-time-attempt intent for failed/absent installs). Pure fs, no throw.
 */
export function darwinShimNeedsRepair(
  execPath: string = process.execPath,
  opts: { homeDir?: string; candidates?: string[] } = {},
): boolean {
  const homeDir = opts.homeDir ?? (process.env.HOME || '');
  const target = deriveDarwinCliTarget(execPath);
  const fallbackDir = path.posix.join(homeDir, '.local', 'bin');
  const candidates = opts.candidates ?? ['/usr/local/bin/wmux', path.posix.join(fallbackDir, 'wmux')];

  for (const linkPath of candidates) {
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(linkPath);
    } catch {
      continue; // absent — respect one-time-attempt intent, no repair
    }
    if (!st.isSymbolicLink()) continue; // foreign real file — leave it
    let linkTarget = '';
    try {
      linkTarget = fs.readlinkSync(linkPath);
    } catch {
      continue;
    }
    if (!isOwnedWmuxTarget(linkTarget)) continue; // foreign symlink — leave it
    // Owned link: repair if it points somewhere other than the current bundle,
    // or if its target no longer exists on disk.
    if (linkTarget !== target || !fs.existsSync(linkTarget)) return true;
  }
  return false;
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
