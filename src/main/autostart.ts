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
 * macOS (darwin): system login items (app.set/getLoginItemSettings) serve as the
 * same single source of truth. refreshAutostartEntry is a no-op on darwin —
 * login items track the app bundle path via the OS, so no rewrite on each update.
 * Other platforms (linux, etc.) remain inert no-ops (`false`), so the renderer
 * may call unconditionally safely.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

import { app } from 'electron';

// electron app accessor for the darwin branch. Replaced by vi.mock('electron') in tests;
// if app is unavailable for any reason → null → darwin branch converges to the same
// best-effort no-op as the win path.
function electronApp(): Electron.App | null {
  return app ?? null;
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'fmux';
/** Pre-identity-boundary Run value — remove on write so login doesn't start twice. */
const LEGACY_VALUE_NAME = 'wmux';

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
 * True only when the per-user Run key currently holds a `fmux` (or legacy
 * `wmux`) value. On any platform other than win32, or if reg.exe errors for
 * any reason, returns false.
 */
export function isAutostartEnabled(): boolean {
  if (process.platform === 'darwin') {
    // macOS: system login items are the single source of truth — same role as the
    // registry Run key. getLoginItemSettings failure is best-effort false.
    try {
      return electronApp()?.getLoginItemSettings().openAtLogin ?? false;
    } catch {
      return false;
    }
  }
  if (process.platform !== 'win32') return false;
  return hasRunValue(VALUE_NAME) || hasRunValue(LEGACY_VALUE_NAME);
}

function hasRunValue(name: string): boolean {
  try {
    // `reg query ... /v <name>` exits 0 when the value exists, non-zero (throws
    // via execFileSync) when it is absent. stdio ignored — we only need the code.
    execFileSync(regExe(), ['query', RUN_KEY, '/v', name], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: REG_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function deleteRunValue(name: string): void {
  try {
    execFileSync(regExe(), ['delete', RUN_KEY, '/v', name, '/f'], {
      windowsHide: true,
      timeout: REG_TIMEOUT_MS,
    });
  } catch {
    /* best-effort — absent is fine */
  }
}

/** Write the Run value pointing at `exePath` (defaults to this process). */
export function enableAutostart(exePath: string = process.execPath): void {
  if (process.platform === 'darwin') {
    // macOS: exePath arg is ignored — login item is bound to the current app bundle automatically.
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
    // Drop the legacy value so a prior identity doesn't double-launch at login.
    deleteRunValue(LEGACY_VALUE_NAME);
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
  deleteRunValue(VALUE_NAME);
  deleteRunValue(LEGACY_VALUE_NAME);
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
