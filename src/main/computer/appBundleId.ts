// The bundle id of a .app on disk, read before openApp launches it: a path's
// file name says nothing about what the bundle is, so the blocklist has to
// see its CFBundleIdentifier. Electron-free; execFile is injectable for tests.
// macOS only, so the plist path is built with POSIX separators on any host.

import { execFile as nodeExecFile } from 'node:child_process';
import { posix as path } from 'node:path';

/** Absolute path, no shell: the argument is a path an agent chose. */
export const PLUTIL_PATH = '/usr/bin/plutil';
const PLUTIL_TIMEOUT_MS = 5_000;

export type ExecFileText = (
  file: string,
  args: readonly string[],
  callback: (err: Error | null, stdout: string) => void,
) => void;

const defaultExecFile: ExecFileText = (file, args, callback) => {
  nodeExecFile(file, [...args], { timeout: PLUTIL_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => callback(err, stdout));
};

/** An absolute path to a .app bundle (trailing slashes allowed), else null. */
export function appBundleSelector(selector: string): string | null {
  const trimmed = selector.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') && /\.app$/i.test(trimmed) ? trimmed : null;
}

/** CFBundleIdentifier of the bundle at `appPath`, or null when it cannot be read. */
export function readAppBundleId(
  appPath: string,
  execFile: ExecFileText = defaultExecFile,
  platform: string = process.platform,
): Promise<string | null> {
  // Off macOS there is no plutil, and on Windows `/usr/bin/plutil` is
  // drive-relative: it would run whatever sits at <cwd drive>:\usr\bin\plutil.exe.
  if (platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        PLUTIL_PATH,
        ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
        (err, stdout) => {
          const id = err ? '' : String(stdout).trim();
          resolve(id || null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}
