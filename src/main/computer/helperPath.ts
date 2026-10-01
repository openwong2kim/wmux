// Where the native computer-use helper lives. Electron-free so the rule is
// unit-testable; index.ts supplies app.isPackaged and the paths.

import * as path from 'path';

export interface HelperSpec {
  /** Directory under resources/ (packaged) or native/ (dev build output). */
  dir: string;
  /** Executable path relative to `dir`. */
  exe: string;
}

export const HELPER_PATH_ENV = 'WMUX_COMPUTER_HELPER';

/**
 * Packaged builds run only the helper they ship (an extraResource). Dev builds
 * look in the helper project's publish output, and only they honour
 * WMUX_COMPUTER_HELPER for testing a locally built helper: in a packaged build
 * an environment variable (a persistent per-user one, say) must not be able to
 * swap the process that injects input into other apps for another binary. The
 * override must be an absolute path, because it is spawned as given and a
 * bare name would be looked up on PATH.
 */
export function resolveHelperPathFor(opts: {
  spec: HelperSpec | null;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  env: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (!opts.isPackaged) {
    const override = opts.env[HELPER_PATH_ENV]?.trim();
    if (override && path.isAbsolute(override)) return override;
  }
  if (!opts.spec) return null;
  const base = opts.isPackaged
    ? path.join(opts.resourcesPath, opts.spec.dir)
    : path.join(opts.appPath, 'native', opts.spec.dir, 'dist');
  return path.join(base, opts.spec.exe);
}
