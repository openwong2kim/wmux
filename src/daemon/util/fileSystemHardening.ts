import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const NO_SYNC_NOTICE_FILENAME = '.no-cloud-sync.txt';
const NO_SYNC_NOTICE_BODY =
  'wmux substrate state directory.\r\n' +
  '\r\n' +
  'This folder contains terminal scrollback buffers and session metadata.\r\n' +
  'Exclude it from cloud sync, backup, or indexing tools that mirror your\r\n' +
  'user profile (OneDrive, Dropbox, Google Drive, Windows Backup, etc.).\r\n' +
  '\r\n' +
  'See docs/SECURITY.md in the wmux repository for the full security model.\r\n';

const EXEC_TIMEOUT_MS = 5000;

type WarnLogger = (message: string, ...rest: unknown[]) => void;

function systemBinary(name: string): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', name);
}

/**
 * Best-effort filesystem hardening for the wmux substrate state directory.
 *
 * Windows (NTFS):
 *   1. icacls disables ACL inheritance on the directory and grants the
 *      current user only (full control, propagated to children). Defense-
 *      in-depth on top of the default user profile ACL.
 *   2. attrib sets Hidden + System + NotIndexed on the directory and the
 *      buffers/ subdirectory so Windows Search ignores them and
 *      conservative backup tools skip them.
 *   3. Writes a plain-text .no-cloud-sync.txt notice at the directory
 *      root so users browsing in Explorer or a sync-tool UI see the
 *      exclusion guidance.
 *
 * POSIX (macOS, Linux):
 *   - Early return. The directory was created mode 0o700 in acquireLock()
 *     and per-file modes are 0o600. No additional hardening needed.
 *
 * All operations are best-effort: every step is independently wrapped so
 * one failure (missing system binary, AV interference) does not block
 * the daemon from booting. Idempotent — safe to call on every startup.
 */
export async function hardenWmuxDir(
  dir: string,
  warn: WarnLogger = console.warn,
): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  // (1) icacls — disable inheritance, grant current user only.
  const username = process.env.USERNAME || os.userInfo().username;
  if (username) {
    const icacls = systemBinary('icacls.exe');
    try {
      await execFileAsync(icacls, [dir, '/inheritance:r'], {
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (err) {
      warn('[hardenWmuxDir] icacls /inheritance:r failed:', (err as Error).message);
    }
    try {
      await execFileAsync(
        icacls,
        [dir, '/grant:r', `${username}:(OI)(CI)F`],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
    } catch (err) {
      warn('[hardenWmuxDir] icacls /grant:r failed:', (err as Error).message);
    }
  }

  // (2) attrib — Hidden + System + NotIndexed on dir and buffers/.
  const buffersDir = path.join(dir, 'buffers');
  try {
    fs.mkdirSync(buffersDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    warn('[hardenWmuxDir] mkdir buffers failed:', (err as Error).message);
  }

  const attrib = systemBinary('attrib.exe');
  for (const target of [dir, buffersDir]) {
    try {
      await execFileAsync(attrib, ['+H', '+S', '+I', target, '/D'], {
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (err) {
      warn('[hardenWmuxDir] attrib failed for', target, ':', (err as Error).message);
    }
  }

  // (3) Plain-text no-cloud-sync notice file. Idempotent overwrite.
  try {
    const noticePath = path.join(dir, NO_SYNC_NOTICE_FILENAME);
    fs.writeFileSync(noticePath, NO_SYNC_NOTICE_BODY, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (err) {
    warn('[hardenWmuxDir] notice write failed:', (err as Error).message);
  }
}

export const __testing__ = {
  NO_SYNC_NOTICE_FILENAME,
  NO_SYNC_NOTICE_BODY,
};
