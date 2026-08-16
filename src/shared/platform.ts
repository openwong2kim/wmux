// OS-aware constants and helpers used across main / renderer / daemon / mcp / cli.
//
// Background: prior to this module, ~45 inline `process.platform === 'win32'`
// branches were scattered through src/. New code should prefer `platformChoice`
// and the boolean constants below; existing inline branches migrate boy-scout
// style as files are touched.

export type Platform = 'win32' | 'darwin' | 'linux' | 'other';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isUnix = !isWindows;

export const currentPlatform: Platform = isWindows
  ? 'win32'
  : isMac
    ? 'darwin'
    : isLinux
      ? 'linux'
      : 'other';

// Pick a value per OS. `default` is required so the return type is non-nullable.
//
// Example:
//   const shellCandidates = platformChoice<string[]>({
//     win: ['pwsh.exe', 'powershell.exe', 'cmd.exe'],
//     mac: ['/bin/zsh', '/bin/bash'],
//     linux: ['/bin/bash', '/bin/zsh'],
//     default: ['/bin/sh'],
//   });
export interface PlatformChoice<T> {
  win?: T;
  mac?: T;
  linux?: T;
  default: T;
}

export function platformChoice<T>(choices: PlatformChoice<T>): T {
  if (isWindows && choices.win !== undefined) return choices.win;
  if (isMac && choices.mac !== undefined) return choices.mac;
  if (isLinux && choices.linux !== undefined) return choices.linux;
  return choices.default;
}

/**
 * Windows build number out of an OS version string — `10.0.19045` -> `19045`.
 *
 * Accepts what `os.release()` and Electron's `process.getSystemVersion()` both
 * return on Windows (measured: identical, `10.0.26200` on Win11 26200). The
 * build is the THIRD field; the first two are the marketing-frozen `10.0` that
 * Windows 11 still reports, so neither one distinguishes 10 from 11.
 *
 * Returns null for anything that is not a version string with a numeric third
 * field, so a caller can keep whatever its no-information default is instead of
 * acting on a number that was never really read.
 */
export function parseWindowsBuildNumber(systemVersion: string | null | undefined): number | null {
  if (typeof systemVersion !== 'string') return null;
  const build = systemVersion.trim().split('.')[2];
  if (build === undefined || !/^\d+$/.test(build)) return null;
  const parsed = Number(build);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
