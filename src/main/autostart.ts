/**
 * Windows "start on login" control.
 *
 * wmux registers itself in the per-user Run key so a reboot brings the app
 * (and its daemon) back automatically:
 *
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\Run  →  value "wmux" = "<exe>"
 *
 * The registry value is the single source of truth for "is autostart on?" —
 * there is no separate config file to drift out of sync with it. Settings reads
 * it back with `isAutostartEnabled()` and flips it with `setAutostartEnabled()`.
 *
 * The Squirrel install/update handlers in index.ts also write this key. Install
 * registers it (autostart defaults ON, preserving historical behavior); update
 * must NOT resurrect it if the user turned it off — see `refreshAutostartEntry`.
 *
 * All operations are best-effort: reg.exe failures never throw to callers (the
 * IPC layer reports the post-op state instead).
 *
 * macOS(darwin): 시스템 로그인 항목(app.set/getLoginItemSettings)이 동일한
 * 단일 진실 소스 역할을 한다. refreshAutostartEntry는 darwin에서 no-op —
 * 로그인 항목은 앱 번들 경로를 OS가 추적하므로 업데이트마다 재작성할 필요가 없다.
 * 그 외 플랫폼(linux 등)에서는 여전히 inert no-op(`false`)이라 renderer는
 * 무조건 호출해도 안전하다.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

import { app } from 'electron';

// darwin 분기용 electron app 접근자. 테스트에서 vi.mock('electron')으로 대체되며,
// 어떤 이유로든 app이 없으면 null → darwin 분기는 win 경로와 동일하게
// best-effort no-op으로 수렴한다.
function electronApp(): Electron.App | null {
  return app ?? null;
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'wmux';

// Hard cap on every reg.exe spawn. A wedged reg.exe (AV interception, a
// corrupt hive, a GPO hook) would otherwise hang the synchronous call — which
// stalls the IPC handler (renderer toggle freezes) and, worse, can stall the
// `--squirrel-updated` handler mid-install. On timeout execFileSync throws,
// which every caller already treats as best-effort / "absent".
const REG_TIMEOUT_MS = 5000;

function regExe(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'reg.exe');
}

/**
 * NOTE — known limitation: this reads/writes only the Run *value*. When a user
 * disables wmux via Task Manager → Startup or Settings → Startup Apps, Windows
 * keeps the Run value but records the disabled bit in a separate
 * `...\StartupApproved\Run` binary blob. We don't parse that blob, so
 * `isAutostartEnabled()` can report `true` while Windows will not actually
 * launch wmux. Toggling from inside wmux (which most users do) is unaffected.
 */

/**
 * True only when the per-user Run key currently holds a `wmux` value. On any
 * platform other than win32, or if reg.exe errors for any reason, returns false.
 */
export function isAutostartEnabled(): boolean {
  if (process.platform === 'darwin') {
    // macOS: 시스템 로그인 항목이 단일 진실 소스 — 레지스트리의 Run 키와 동일한
    // 역할. getLoginItemSettings 실패는 best-effort로 false 처리.
    try {
      return electronApp()?.getLoginItemSettings().openAtLogin ?? false;
    } catch {
      return false;
    }
  }
  if (process.platform !== 'win32') return false;
  try {
    // `reg query ... /v wmux` exits 0 when the value exists, non-zero (throws
    // via execFileSync) when it is absent. stdio ignored — we only need the code.
    execFileSync(regExe(), ['query', RUN_KEY, '/v', VALUE_NAME], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: REG_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `reg query <RunKey> /v wmux` output into the exe path it names, or
 * null when no wmux value line is present. The value is written quoted
 * (`"<exe>"`); the quotes are stripped. Pure, exported for tests.
 */
export function parseRunValue(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+wmux\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    const quoted = /^"([^"]*)"/.exec(raw);
    const value = quoted ? quoted[1] : raw;
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * The exe path the Run value points at, or null when there is no value (or
 * on any non-win32 platform, or when reg.exe fails).
 */
export function readAutostartTarget(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(regExe(), ['query', RUN_KEY, '/v', VALUE_NAME], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: REG_TIMEOUT_MS,
    });
    return parseRunValue(out);
  } catch {
    return null;
  }
}

/** Write the Run value pointing at `exePath` (defaults to this process). */
export function enableAutostart(exePath: string = process.execPath): void {
  if (process.platform === 'darwin') {
    // macOS: exePath 인자는 무시 — 로그인 항목은 현재 앱 번들에 자동으로 묶인다.
    try {
      electronApp()?.setLoginItemSettings({ openAtLogin: true });
    } catch {
      /* best-effort */
    }
    return;
  }
  if (process.platform !== 'win32') return;
  try {
    execFileSync(
      regExe(),
      ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', `"${exePath}"`, '/f'],
      { windowsHide: true, timeout: REG_TIMEOUT_MS },
    );
  } catch {
    /* best-effort */
  }
}

/** Remove the Run value so the app no longer launches at login. */
export function disableAutostart(): void {
  if (process.platform === 'darwin') {
    try {
      electronApp()?.setLoginItemSettings({ openAtLogin: false });
    } catch {
      /* best-effort */
    }
    return;
  }
  if (process.platform !== 'win32') return;
  try {
    execFileSync(regExe(), ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'], {
      windowsHide: true,
      timeout: REG_TIMEOUT_MS,
    });
  } catch {
    /* best-effort */
  }
}

/** Convenience wrapper used by the IPC handler: set to the requested state. */
export function setAutostartEnabled(enabled: boolean): boolean {
  if (enabled) enableAutostart();
  else disableAutostart();
  return isAutostartEnabled();
}

/**
 * Squirrel `--squirrel-updated` hook: refresh the Run value's exe path to the
 * newly-installed version, but ONLY if autostart is currently on. Re-adding
 * unconditionally would silently re-enable autostart for a user who turned it
 * off, on every update. No-op when the key is absent.
 */
export function refreshAutostartEntry(exePath: string = process.execPath): void {
  if (process.platform !== 'win32') return;
  if (isAutostartEnabled()) enableAutostart(exePath);
}
