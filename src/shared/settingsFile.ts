// ─── Writing someone else's JSON config, safely ──────────────────────────────
//
// `wmux setup-hooks` and `wmux setup-statusline` both edit the SAME file —
// ~/.claude/settings.json — and each shipped its own copy of "atomic" write.
// Both copies had the same four defects, and the file they damage is the one
// holding the operator's permission grants, env, and model choice.
//
//   shared temp name  Each wrote `<file>.tmp`. Two processes (the app and the
//                     CLI, or the two setup commands) could interleave into
//                     that one buffer and rename the mess over the real file.
//   symlink replaced  `rename` swaps the LINK, not its target. A settings.json
//                     symlinked into a dotfiles repo was silently detached and
//                     the real file left behind at its old contents.
//   mode not kept     A fresh temp file takes the umask, so a 0600 settings.json
//                     came back 0644 — readable by every other account on the
//                     machine, and this file can carry API keys in `env`.
//   no durability     rename was atomic but the data was not flushed, so a
//                     power loss could land the rename with an empty file.
//
// Not a general-purpose utility: it exists because two callers edit one
// sensitive file that neither of them owns.

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** Sharing violations and antivirus scans surface as these. They say "someone
 *  is holding the file right now", not "you may not do this", so a bounded
 *  wait is the correct response to all three. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;

/** Block the thread. These call sites are synchronous by contract — the whole
 *  installer is — and the total wait is capped at 150ms. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RenameDeps {
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
  attempts?: number;
}

/**
 * `fs.renameSync` with a bounded backoff over the transient codes.
 *
 * Retried by error code rather than by platform: the same codes mean the same
 * thing wherever they appear, and a genuine permission failure still surfaces
 * — 150ms later, on a path a human just clicked.
 */
export function renameWithRetry(from: string, to: string, deps: RenameDeps = {}): void {
  const rename = deps.rename ?? ((a: string, b: string) => fs.renameSync(a, b));
  const sleep = deps.sleep ?? sleepSync;
  const attempts = deps.attempts ?? RENAME_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !RENAME_RETRY_CODES.has(code)) throw err;
      sleep(10 * 2 ** (attempt - 1));
    }
  }
}

/** Mode for a config file we are creating from scratch. Claude's settings.json
 *  can hold credentials in `env`; owner-only is the safe thing to author.
 *
 *  POSIX only, and worth being plain about: on Windows `chmod` moves the
 *  read-only bit and nothing else, so neither this nor the mode carried over
 *  from an existing file changes who can read it. There the file inherits the
 *  profile directory's ACL, which is already user-scoped. */
const NEW_FILE_MODE = 0o600;

/** Follow a symlinked config to the file it points at, so the write lands on
 *  the real file and the link survives. Falls back to the given path when the
 *  file does not exist yet (the common install case) or cannot be resolved. */
export function resolveWriteTarget(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function existingMode(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Write `data` as pretty JSON to `filePath`, atomically and durably.
 *
 * The temp file is unique per process and lives beside the destination (rename
 * cannot cross filesystems). It inherits the destination's mode when there is
 * one, and is fsynced before the rename so the rename can never publish an
 * empty file. A failure leaves the original untouched and no temp behind.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const target = resolveWriteTarget(filePath);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const mode = existingMode(target) ?? NEW_FILE_MODE;
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // openSync's mode argument is masked by umask; set it outright so a
    // 0600 config does not come back 0644.
    fs.chmodSync(tmp, mode);
    renameWithRetry(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created, or already gone */
    }
    throw err;
  }
  fsyncDir(dir);
}

/** Make the rename itself durable. Not possible on Windows, and not worth
 *  failing a completed write over anywhere else. */
export function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* directory fsync is unsupported here */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Copy a file into place through the same temp+rename path.
 *
 * A plain copy truncates the destination and writes in place, and these
 * destinations are scripts that run at input-box frequency — a tick landing
 * mid-copy reads a half-written file. `refreshStatuslineScript` already knew
 * this; the install path that puts the same script there did not.
 */
export function copyFileAtomic(source: string, dest: string): void {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.copyFileSync(source, tmp);
    renameWithRetry(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created, or already gone */
    }
    throw err;
  }
}
