/**
 * Atomic text read/write — sibling of `core.ts`'s JSON primitives.
 *
 * The JSON variant assumes the on-disk payload parses with `JSON.parse`
 * and runs prototype-pollution scrubbing in a reviver. Scrollback dumps
 * are raw UTF-8 terminal output and have neither of those needs, so we
 * keep a separate codepath here rather than retrofit a "skip parsing"
 * mode into the JSON variant and dilute its contract.
 *
 * Hardening shared with the JSON path:
 *   - tmp file + `rename` instead of in-place `writeFile` (no torn write
 *     visible to readers).
 *   - rotation chain (`.bak`, `.bak.1`, `.bak.2`, `.bak.3`) so a single
 *     bad write does not destroy the only good copy.
 *   - read-side fallback walks the same chain.
 *   - quarantine of a primary file rejected by the caller's `validate`
 *     hook so the next successful write does not silently overwrite
 *     the evidence of corruption (`{dir}/corrupted/`).
 *
 * Stdlib-only — importable from daemon AND main process. Do not reach
 * for Electron or daemon-specific state.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  BACKUP_SUFFIXES,
  isManagedBackup,
  rotateBackups,
  rotateBackupsSync,
} from './rotation';
import { quarantineFile, quarantineFileSync } from './quarantine';
import {
  chainAsyncWrite,
  commitRename,
  commitRenameSync,
  noteFallback,
  notePrimaryRead,
  noteReadFailure,
  readFileRetrying,
  readFileRetryingSync,
  rememberWrittenAsync,
  rememberWrittenSync,
  rollbackBak,
  rollbackBakSync,
  settlePrimary,
  settlePrimarySync,
  verdictRotates,
  type PrimaryProblem,
  type PrimaryVerdict,
  type RenameRetryPolicy,
} from './core';

// ── Public types ─────────────────────────────────────────────────────

export interface AtomicWriteTextOptions {
  /**
   * When true, shift the existing numbered backup slots before the
   * primary is rotated to `.bak`. Mirrors `AtomicWriteOptions.rotationEnabled`.
   */
  rotationEnabled?: boolean;

  /**
   * Pre-write validator on the raw string. Returning false (or
   * throwing) aborts the write with an error — the on-disk file is
   * left untouched. Defense in depth so a misbehaving caller cannot
   * overwrite a good file with content that is obviously bad.
   */
  validate?: (content: string) => boolean;

  /** Injectable clock for tests. Default: Date.now. */
  clock?: () => number;

  /** Test seam for the win32 commit-rename retry. Mirrors `AtomicWriteOptions.renameRetry`. */
  renameRetry?: RenameRetryPolicy;
}

export interface AtomicReadTextOptions {
  /**
   * Post-read validator. Returning false discards the candidate file
   * and continues to the next slot in the `.bak` fallback chain. The
   * primary file (or any rotation-managed slot) that fails validation
   * is moved into `corrupted/` so the next write does not silently
   * overwrite it.
   */
  validate?: (content: string) => boolean;

  /** Injectable clock for tests. Default: Date.now. */
  clock?: () => number;

  /** Test seam for the win32 read retry. Mirrors `renameRetry` on writes. */
  readRetry?: RenameRetryPolicy;
}

export interface AtomicReadTextResult {
  /** Path of the slot that satisfied the read (primary or a `.bak` slot). */
  path: string;
  /** The validated content. */
  content: string;
}

// ── Internal helpers ────────────────────────────────────────────────

let tmpCounter = 0;
function makeTmpPath(targetPath: string): string {
  tmpCounter = (tmpCounter + 1) >>> 0;
  return `${targetPath}.tmp.${process.pid}.${tmpCounter}`;
}

function bakPathFor(targetPath: string): string {
  return `${targetPath}.bak`;
}

function ensureDirSync(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
}

function unlinkIfExistsSync(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // best-effort
    }
  }
}

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // best-effort
    }
  }
}

/** Text has no parse to fail, so a file of nothing but zero bytes, what a crash
 *  mid-write can leave, is the one that reads as bad. */
function judgePrimaryText(raw: string, validate?: (content: string) => boolean): PrimaryVerdict {
  if (raw === '') return 'empty';
  if (/^\0*$/.test(raw)) return 'bad';
  try {
    return !validate || validate(raw) ? 'good' : 'rejected';
  } catch {
    return 'rejected';
  }
}

function isQuarantineEligible(
  targetPath: string,
  candidatePath: string,
): boolean {
  if (candidatePath === targetPath) return true;
  const targetBase = path.basename(targetPath);
  const candidateBase = path.basename(candidatePath);
  return isManagedBackup(targetBase, candidateBase);
}

// ── Async write ──────────────────────────────────────────────────────

export async function atomicWriteText(
  targetPath: string,
  content: string,
  opts: AtomicWriteTextOptions = {},
): Promise<void> {
  if (opts.validate) {
    let ok = false;
    try {
      ok = opts.validate(content);
    } catch (err) {
      throw new Error(
        `atomicWriteText: validate() threw for "${targetPath}": ${String(err)}`,
      );
    }
    if (!ok) {
      throw new Error(
        `atomicWriteText: validate() rejected content for "${targetPath}"`,
      );
    }
  }

  // Serialised per target, as in core.ts: the retry sleep must not let two
  // async writers interleave while the primary is rotated away.
  return chainAsyncWrite(targetPath, async () => {
    const tmp = makeTmpPath(targetPath);
    const bak = bakPathFor(targetPath);

    await ensureDir(targetPath);

    let movedToBak = false;
    try {
      await fsp.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });

      // Only a primary that passes becomes `.bak` (see core.ts).
      const verdict = await settlePrimary(targetPath, opts, (raw) => judgePrimaryText(raw, opts.validate));

      if (opts.rotationEnabled && verdictRotates(verdict)) {
        await rotateBackups(targetPath);
      }

      // Rotate current → .bak with the same retry as the commit (see core.ts).
      if (verdict === 'good') {
        try {
          await commitRename(targetPath, bak, opts.renameRetry, 'backup');
          movedToBak = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            // eslint-disable-next-line no-console
            console.warn('[atomicWriteText] Failed to create backup:', err);
          }
        }
      }

      try {
        await commitRename(tmp, targetPath, opts.renameRetry);
      } catch (err) {
        // The primary is at `.bak` and the new content never landed: put the
        // previous generation back so a failed write leaves the previous state.
        if (movedToBak) await rollbackBak(bak, targetPath);
        throw err;
      }
      await rememberWrittenAsync(targetPath);
    } catch (err) {
      await unlinkIfExists(tmp);
      throw err;
    }
  });
}

// ── Async read ───────────────────────────────────────────────────────

export async function atomicReadText(
  targetPath: string,
  opts: AtomicReadTextOptions = {},
): Promise<AtomicReadTextResult | null> {
  let primaryProblem: PrimaryProblem = 'missing';
  const attempt = async (
    p: string,
  ): Promise<AtomicReadTextResult | null> => {
    let content: string | null;
    try {
      content = await readFileRetrying(p, opts.readRetry);
    } catch (err) {
      noteReadFailure(targetPath, p, err);
      if (p === targetPath) primaryProblem = 'unreadable';
      return null;
    }
    if (content === null) return null;
    if (p === targetPath) primaryProblem = 'corrupt';

    if (opts.validate && !opts.validate(content)) {
      if (isQuarantineEligible(targetPath, p)) {
        try {
          await quarantineFile(p, 'validate rejected text content', {
            clock: opts.clock,
          });
        } catch {
          // best-effort
        }
      }
      return null;
    }

    return { path: p, content };
  };

  const primary = await attempt(targetPath);
  if (primary !== null) {
    notePrimaryRead(targetPath);
    return primary;
  }

  for (const suffix of BACKUP_SUFFIXES) {
    const candidate = `${targetPath}${suffix}`;
    const backup = await attempt(candidate);
    if (backup !== null) {
      noteFallback(targetPath, candidate, primaryProblem);
      return backup;
    }
  }

  return null;
}

// ── Sync write ───────────────────────────────────────────────────────

export function atomicWriteTextSync(
  targetPath: string,
  content: string,
  opts: AtomicWriteTextOptions = {},
): void {
  if (opts.validate) {
    let ok = false;
    try {
      ok = opts.validate(content);
    } catch (err) {
      throw new Error(
        `atomicWriteTextSync: validate() threw for "${targetPath}": ${String(err)}`,
      );
    }
    if (!ok) {
      throw new Error(
        `atomicWriteTextSync: validate() rejected content for "${targetPath}"`,
      );
    }
  }

  const tmp = makeTmpPath(targetPath);
  const bak = bakPathFor(targetPath);

  ensureDirSync(targetPath);

  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });

    // Only a primary that passes becomes `.bak` (see core.ts).
    const verdict = settlePrimarySync(targetPath, opts, (raw) => judgePrimaryText(raw, opts.validate));

    if (opts.rotationEnabled && verdictRotates(verdict)) {
      rotateBackupsSync(targetPath);
    }

    // Rotate current → .bak with the same retry as the commit (see core.ts).
    let movedToBak = false;
    if (verdict === 'good') {
      try {
        commitRenameSync(targetPath, bak, opts.renameRetry, 'backup');
        movedToBak = true;
      } catch (bakErr) {
        // eslint-disable-next-line no-console
        console.warn('[atomicWriteText] Failed to create backup:', bakErr);
      }
    }

    try {
      commitRenameSync(tmp, targetPath, opts.renameRetry);
    } catch (err) {
      // Restore the previous generation so a retry-exhausted write does not
      // leave the caller with no primary file at all.
      if (movedToBak) rollbackBakSync(bak, targetPath);
      throw err;
    }
    rememberWrittenSync(targetPath);
  } catch (err) {
    unlinkIfExistsSync(tmp);
    throw err;
  }
}

// ── Sync read ────────────────────────────────────────────────────────

export function atomicReadTextSync(
  targetPath: string,
  opts: AtomicReadTextOptions = {},
): AtomicReadTextResult | null {
  let primaryProblem: PrimaryProblem = 'missing';
  const attempt = (p: string): AtomicReadTextResult | null => {
    let content: string | null;
    try {
      content = readFileRetryingSync(p, opts.readRetry);
    } catch (err) {
      noteReadFailure(targetPath, p, err);
      if (p === targetPath) primaryProblem = 'unreadable';
      return null;
    }
    if (content === null) return null;
    if (p === targetPath) primaryProblem = 'corrupt';

    if (opts.validate && !opts.validate(content)) {
      if (isQuarantineEligible(targetPath, p)) {
        try {
          quarantineFileSync(p, 'validate rejected text content', {
            clock: opts.clock,
          });
        } catch {
          // best-effort
        }
      }
      return null;
    }

    return { path: p, content };
  };

  const primary = attempt(targetPath);
  if (primary !== null) {
    notePrimaryRead(targetPath);
    return primary;
  }

  for (const suffix of BACKUP_SUFFIXES) {
    const candidate = `${targetPath}${suffix}`;
    const backup = attempt(candidate);
    if (backup !== null) {
      noteFallback(targetPath, candidate, primaryProblem);
      return backup;
    }
  }

  return null;
}
