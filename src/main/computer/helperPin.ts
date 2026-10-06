// What a packaged Windows build knows about the computer-use helper it ships,
// baked into the main bundle by vite.main.config.ts from the staged exe
// (dist/computer-use-windows) at build time. Dev builds and tests see the
// empty pin, and verifyHelper.ts checks it only in packaged builds.

import type { ComputerHelperStatus } from './settings';
import type { WindowsHelperPin } from './verifyHelper';

declare const __WMUX_WIN_HELPER_SHA256__: string | undefined;
declare const __WMUX_WIN_HELPER_RELEASE_SIGNED__: boolean | undefined;

export const WINDOWS_HELPER_PIN: WindowsHelperPin = {
  sha256: typeof __WMUX_WIN_HELPER_SHA256__ === 'string' ? __WMUX_WIN_HELPER_SHA256__ : '',
  releaseSigned: typeof __WMUX_WIN_HELPER_RELEASE_SIGNED__ === 'boolean' ? __WMUX_WIN_HELPER_RELEASE_SIGNED__ : false,
};

/**
 * The helper status Settings and every call see. On Windows, wmux running
 * as administrator reports `elevated`, and a packaged build that carries no
 * pin reports `missing`. A release signature is not required: the pin
 * (checked against the helper's bytes before every spawn, verifyHelper.ts) is
 * what a packaged build relies on. Dev builds are unaffected.
 */
export function effectiveHelperStatus(
  status: ComputerHelperStatus,
  opts: { platform: NodeJS.Platform; isPackaged: boolean; pin: WindowsHelperPin; selfElevated?: boolean | null },
): ComputerHelperStatus {
  if (status !== 'ready' || opts.platform !== 'win32') return status;
  // The helper refuses to run elevated (it would drive elevated apps).
  if (opts.selfElevated === true) return 'elevated';
  if (!opts.isPackaged) return status;
  return /^[0-9a-f]{64}$/.test(opts.pin.sha256) ? status : 'missing';
}

/**
 * A packaged Windows build whose helper carries no release signature. Not a
 * refusal: Settings shows one note, since Defender or SmartScreen may warn.
 */
export function helperUnsignedNotice(opts: { platform: NodeJS.Platform; isPackaged: boolean; pin: WindowsHelperPin }): boolean {
  return opts.platform === 'win32' && opts.isPackaged && !opts.pin.releaseSigned;
}
