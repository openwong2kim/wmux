/**
 * T5: .bak rotation chain.
 *
 * Responsibility: after the main atomic rename has succeeded, shift
 * the numbered backup slots:
 *
 *     .bak.2 → .bak.3
 *     .bak.1 → .bak.2
 *     .bak   → .bak.1
 *
 * (The caller already moved the previous primary to `.bak` before
 * this function runs.) We keep four generations: `.bak`, `.bak.1`,
 * `.bak.2`, `.bak.3`.
 *
 * Design notes:
 *
 *   - Only `rename` is used. Never `copy`. The chain must be as
 *     cheap as a `fsp.rename` per slot; on the same volume that is a
 *     metadata-only operation.
 *   - Each slot move is best-effort: an ENOENT (source missing) is
 *     swallowed silently, everything else is logged and skipped.
 *     Losing a backup slot is preferable to failing the surrounding
 *     write — by the time rotation runs the primary is already
 *     durably on disk.
 *   - Windows compatibility: `fsp.rename` refuses to overwrite an
 *     existing destination on some Windows volumes. We unlink the
 *     destination first (also best-effort) and then rename. The
 *     unlink itself ignores ENOENT.
 *   - This module is deliberately scope-limited: no knowledge of
 *     serialization, validation, or the write pipeline. Those live
 *     in `core.ts`. That keeps T6 (quarantine) and T7 (migration)
 *     free to evolve without touching rotation.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { keptCopiesOf } from './quarantine';

/**
 * Canonical backup-slot suffixes, ordered from newest to oldest.
 * Index 0 (`.bak`) is the most recent backup; index 3 (`.bak.3`) is
 * the oldest retained generation.
 *
 * Exported so T6's quarantine logic can distinguish managed backups
 * from user-authored files and from the T7 pre-migration backup
 * (`.premigrate.bak`).
 */
export const BACKUP_SUFFIXES = ['.bak', '.bak.1', '.bak.2', '.bak.3'] as const;

export type BackupSuffix = (typeof BACKUP_SUFFIXES)[number];

/**
 * True when the primary or any backup slot is on disk, or quarantine kept a
 * copy of the primary. Callers check this before a sync read to tell "nothing
 * on disk" (first boot) from "on disk but unreadable" when the read returns
 * null (#3247). Kept copies count because an earlier read in the same boot can
 * quarantine an invalid primary, which would otherwise look missing to every
 * later read. A slot whose stat fails for any reason other than absence
 * (EACCES, EBUSY, ...) counts as present: its contents are unknown, not gone.
 */
export function stateSlotsOnDisk(primary: string): boolean {
  const present = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code !== 'ENOENT' && code !== 'ENOTDIR';
    }
  };
  return [primary, ...BACKUP_SUFFIXES.map((suffix) => `${primary}${suffix}`)].some(present)
    || keptCopiesOf(primary).length > 0;
}

// ── Internal helpers ────────────────────────────────────────────────

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Best-effort: a leftover destination that we cannot remove
      // will surface as a rename failure in the caller, which is
      // already wrapped in try/catch below.
    }
  }
}

function unlinkIfExistsSync(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // swallow — see async variant
    }
  }
}

/**
 * Rename `from` to `to`, overwriting `to` if it already exists.
 * Swallows ENOENT on `from` (nothing to rotate). Any other error is
 * logged and swallowed so a single bad slot does not abort the
 * chain.
 */
async function renameSlot(from: string, to: string): Promise<void> {
  try {
    // Remove destination first to normalise Windows behaviour.
    await unlinkIfExists(to);
    await fsp.rename(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    // eslint-disable-next-line no-console
    console.warn(`[rotation] Failed to rotate "${from}" → "${to}":`, err);
  }
}

function renameSlotSync(from: string, to: string): void {
  try {
    unlinkIfExistsSync(to);
    fs.renameSync(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    // eslint-disable-next-line no-console
    console.warn(`[rotation] Failed to rotate "${from}" → "${to}":`, err);
  }
}

// ── Public API: rotate ──────────────────────────────────────────────

/**
 * Perform the rename chain `.bak.2 → .bak.3`, `.bak.1 → .bak.2`,
 * `.bak → .bak.1`. Must be called AFTER the write path has already
 * moved the previous primary to `.bak`.
 *
 * Each individual rename is best-effort: failures are logged and
 * the chain continues. A partial rotation is acceptable because the
 * primary file plus any surviving slots still provide usable
 * fallback coverage.
 *
 * `copy` is never used — only `rename`. A filesystem that cannot
 * perform the rename (cross-volume, permissions) will simply leave
 * the older slot in place.
 */
export async function rotateBackups(targetPath: string): Promise<void> {
  // Walk oldest-first so we never clobber a slot that still has a
  // source to move. i.e. move .bak.2 → .bak.3 BEFORE .bak.1 → .bak.2.
  for (let i = BACKUP_SUFFIXES.length - 1; i > 0; i--) {
    const from = `${targetPath}${BACKUP_SUFFIXES[i - 1]}`;
    const to = `${targetPath}${BACKUP_SUFFIXES[i]}`;
    await renameSlot(from, to);
  }
}

/** Synchronous counterpart of {@link rotateBackups}. */
export function rotateBackupsSync(targetPath: string): void {
  for (let i = BACKUP_SUFFIXES.length - 1; i > 0; i--) {
    const from = `${targetPath}${BACKUP_SUFFIXES[i - 1]}`;
    const to = `${targetPath}${BACKUP_SUFFIXES[i]}`;
    renameSlotSync(from, to);
  }
}

// ── Public API: fallback read ───────────────────────────────────────

/**
 * Iterate the fallback chain `primary → .bak → .bak.1 → .bak.2 →
 * .bak.3` and return the first slot whose `reader` yields non-null.
 * The caller supplies the reader (parse + validation is its
 * responsibility); this helper only walks the chain.
 *
 * The return shape (`{path, data}`) lets the caller react — e.g.
 * rewrite the primary so the file "heals" on the next save.
 */
export async function readWithBackupFallback<T>(
  targetPath: string,
  reader: (p: string) => Promise<T | null>,
): Promise<{ path: string; data: T } | null> {
  const candidates: readonly string[] = [
    targetPath,
    ...BACKUP_SUFFIXES.map((s) => `${targetPath}${s}`),
  ];

  for (const p of candidates) {
    const data = await reader(p);
    if (data !== null) return { path: p, data };
  }
  return null;
}

/** Synchronous counterpart of {@link readWithBackupFallback}. */
export function readWithBackupFallbackSync<T>(
  targetPath: string,
  reader: (p: string) => T | null,
): { path: string; data: T } | null {
  const candidates: readonly string[] = [
    targetPath,
    ...BACKUP_SUFFIXES.map((s) => `${targetPath}${s}`),
  ];

  for (const p of candidates) {
    const data = reader(p);
    if (data !== null) return { path: p, data };
  }
  return null;
}

// ── Public API: allowlist for T6 quarantine ─────────────────────────

/**
 * Returns true when `fileName` is a managed backup slot belonging
 * to `basename`. Examples:
 *
 *   isManagedBackup('sessions.json', 'sessions.json.bak')    → true
 *   isManagedBackup('sessions.json', 'sessions.json.bak.2')  → true
 *   isManagedBackup('sessions.json', 'sessions.json.bak.4')  → false
 *   isManagedBackup('sessions.json', 'sessions.json.premigrate.bak') → false
 *   isManagedBackup('sessions.json', 'corrupted/sessions.json.…bak') → false
 *
 * Used by T6 cleanup/quarantine to avoid touching user files or the
 * T7 pre-migration sentinel. The comparison is performed on a bare
 * file name; any directory segment (including `corrupted/`) causes
 * the check to fail so quarantined copies are never rotated.
 */
export function isManagedBackup(basename: string, fileName: string): boolean {
  // Reject anything that carries a directory component. This keeps
  // the `corrupted/` subtree off-limits and prevents path-traversal
  // style inputs from matching.
  if (fileName !== path.basename(fileName)) return false;
  if (basename !== path.basename(basename)) return false;

  for (const suffix of BACKUP_SUFFIXES) {
    if (fileName === `${basename}${suffix}`) return true;
  }
  return false;
}
