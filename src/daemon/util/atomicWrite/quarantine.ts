/**
 * T6 — Corrupt-file quarantine.
 *
 * When `atomicReadJSON`'s `validate` hook rejects a parsed payload we
 * used to warn-and-null, which meant the next successful write silently
 * overwrote the broken file and the original evidence was lost. This
 * module replaces that path with an explicit isolation step:
 *
 *   1. Rename the offender into `{dir}/corrupted/{basename}.{ts}.bak`.
 *   2. Emit a `CORRUPT_FILE` structured log to stderr, which the main and
 *      daemon log sinks tee to disk, so operators can grep for the event
 *      and correlate it with surrounding writes. A plain line beside it
 *      carries the level token `wmux doctor` counts.
 *   3. Enforce retention on `corrupted/` (default: 30 days / 10 files)
 *      so the subtree does not grow unbounded.
 *
 * Scope guards, mirroring `core.ts` / `rotation.ts`:
 *
 *   - Node stdlib only. No Electron, no daemon-specific state. The
 *     quarantine subtree is addressed purely by path, so both the
 *     daemon and the main process can call in once wiring lands.
 *   - `rename` only — never `copy`. Staying on a single volume keeps
 *     the move as a metadata-only op.
 *   - Every I/O path is best-effort. A failing quarantine must not
 *     take the caller down; it returns `null` (or swallows) and lets
 *     the read fallback chain carry on.
 *   - Logs go to `process.stderr.write` as a JSON line per event. We
 *     deliberately do NOT reach for a logger dep — this module stays
 *     importable from any layer.
 *
 * Intentionally kept out of `index.ts`: the quarantine primitives are
 * internal plumbing for `core.ts`. Exposing them publicly would invite
 * call sites to reimplement the validate-then-quarantine contract that
 * `atomicReadJSON` already owns.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// ── Public types ─────────────────────────────────────────────────────

export interface QuarantineOptions {
  /** Max age in ms. Default: 30 days. */
  maxAgeMs?: number;
  /** Max file count. Default: 10. */
  maxCount?: number;
  /** Clock for tests. Default: Date.now. */
  clock?: () => number;
}

export interface CorruptFileLog {
  event: 'CORRUPT_FILE';
  ts: number;
  level: 'warn' | 'error';
  code: 'CORRUPT_FILE';
  path: string;
  quarantined_to: string;
  reason: string;
  /** First 16 chars of sha256(hex) of first 256 bytes. */
  sha256_prefix: string;
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_MAX_COUNT = 10;
const QUARANTINE_SUBDIR = 'corrupted';
const SAMPLE_BYTES = 256;
const SHA_PREFIX_LEN = 16;

// ── Internal helpers ────────────────────────────────────────────────

function resolveClock(opts?: QuarantineOptions): () => number {
  return opts?.clock ?? Date.now;
}

function resolveMaxAge(opts?: QuarantineOptions): number {
  return opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
}

function resolveMaxCount(opts?: QuarantineOptions): number {
  return opts?.maxCount ?? DEFAULT_MAX_COUNT;
}

function quarantineDirFor(sourcePath: string): string {
  return path.join(path.dirname(sourcePath), QUARANTINE_SUBDIR);
}

function quarantineTargetFor(sourcePath: string, ts: number): string {
  const base = path.basename(sourcePath);
  return path.join(quarantineDirFor(sourcePath), `${base}.${ts}.bak`);
}

function shaPrefixFromBuffer(buf: Buffer): string {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return hash.slice(0, SHA_PREFIX_LEN);
}

/** Read up to `SAMPLE_BYTES` from the source; returns "unknown" on error. */
async function computeShaPrefix(sourcePath: string): Promise<string> {
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(sourcePath, 'r');
    const buf = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SAMPLE_BYTES, 0);
    return shaPrefixFromBuffer(buf.subarray(0, bytesRead));
  } catch {
    return 'unknown';
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        // best-effort
      }
    }
  }
}

function computeShaPrefixSync(sourcePath: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(sourcePath, 'r');
    const buf = Buffer.alloc(SAMPLE_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, SAMPLE_BYTES, 0);
    return shaPrefixFromBuffer(buf.subarray(0, bytesRead));
  } catch {
    return 'unknown';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/** Swallow ENOENT; other errors are ignored too (best-effort). */
async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    // best-effort
  }
}

function unlinkIfExistsSync(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // best-effort
  }
}

function emitLog(entry: CorruptFileLog): void {
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
    // The line above is for grep. This one carries the level token `wmux doctor`
    // counts in the main and daemon logs, which stderr is teed into.
    process.stderr.write(
      `[${new Date(entry.ts).toISOString()}] [${entry.level}] [quarantine] ${entry.path} moved to ${entry.quarantined_to}: ${entry.reason}\n`,
    );
  } catch {
    // Logging must never throw — a failed write on stderr is
    // preferable to crashing the caller.
  }
}

// ── Public API: quarantineFile ──────────────────────────────────────

/**
 * Quarantine the file at `sourcePath` into
 * `{dir}/corrupted/{basename}.{ts}.bak`.
 *
 * Contract:
 *   - Returns `{quarantined_to}` on success, `null` if the source is
 *     missing. Any other error returns `null` too (best-effort).
 *   - Uses `fs.rename` — if the target already exists (e.g. clock
 *     collision in tests) we unlink it first so Windows does not
 *     refuse the rename.
 *   - Fires `cleanupQuarantine` after the move. Cleanup runs in the
 *     background (no await) so the caller resumes immediately; the
 *     log line is the authoritative record.
 */
export async function quarantineFile(
  sourcePath: string,
  reason: string,
  opts?: QuarantineOptions,
): Promise<{ quarantined_to: string } | null> {
  try {
    await fsp.access(sourcePath, fs.constants.F_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return null;
  }

  const clock = resolveClock(opts);
  const ts = clock();
  const dir = quarantineDirFor(sourcePath);
  const target = quarantineTargetFor(sourcePath, ts);

  // Compute the sha prefix BEFORE moving so we hash the actual
  // offending bytes (the move is metadata-only, so this is equivalent,
  // but ordering keeps the log meaningful if the move somehow fails).
  const shaPrefix = await computeShaPrefix(sourcePath);

  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
    return null;
  }

  try {
    // Windows: rename refuses to overwrite — remove first.
    await unlinkIfExists(target);
    await fsp.rename(sourcePath, target);
  } catch {
    return null;
  }

  const entry: CorruptFileLog = {
    event: 'CORRUPT_FILE',
    ts,
    level: 'warn',
    code: 'CORRUPT_FILE',
    path: sourcePath,
    quarantined_to: target,
    reason,
    sha256_prefix: shaPrefix,
  };
  emitLog(entry);

  // Fire-and-forget cleanup so the caller resumes. Swallow any error
  // so the unhandled rejection handler stays quiet — but emit a
  // structured log line first so the failure is observable rather
  // than silently dropped (otherwise an accumulating quarantine dir
  // would never surface on dashboards).
  void cleanupQuarantine(dir, opts).catch((err) => {
    try {
      process.stderr.write(
        `${JSON.stringify({
          event: 'CORRUPT_CLEANUP_FAILED',
          ts: clock(),
          level: 'warn',
          code: 'CORRUPT_CLEANUP_FAILED',
          dir,
          reason: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    } catch {
      // logging must never throw
    }
  });

  return { quarantined_to: target };
}

/** Sync counterpart of {@link quarantineFile}. */
export function quarantineFileSync(
  sourcePath: string,
  reason: string,
  opts?: QuarantineOptions,
): { quarantined_to: string } | null {
  if (!fs.existsSync(sourcePath)) return null;

  const clock = resolveClock(opts);
  const ts = clock();
  const dir = quarantineDirFor(sourcePath);
  const target = quarantineTargetFor(sourcePath, ts);

  const shaPrefix = computeShaPrefixSync(sourcePath);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }

  try {
    unlinkIfExistsSync(target);
    fs.renameSync(sourcePath, target);
  } catch {
    return null;
  }

  const entry: CorruptFileLog = {
    event: 'CORRUPT_FILE',
    ts,
    level: 'warn',
    code: 'CORRUPT_FILE',
    path: sourcePath,
    quarantined_to: target,
    reason,
    sha256_prefix: shaPrefix,
  };
  emitLog(entry);

  try {
    cleanupQuarantineSync(dir, opts);
  } catch {
    // best-effort retention
  }

  return { quarantined_to: target };
}

// ── Public API: cleanupQuarantine ───────────────────────────────────

interface FileStampEntry {
  fullPath: string;
  mtimeMs: number;
}

async function listQuarantineEntries(dir: string): Promise<FileStampEntry[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    return [];
  }

  const entries: FileStampEntry[] = [];
  for (const name of names) {
    const fullPath = path.join(dir, name);
    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) continue;
      entries.push({ fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // skip — stat could fail on transient files / permissions
    }
  }
  return entries;
}

function listQuarantineEntriesSync(dir: string): FileStampEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    return [];
  }

  const entries: FileStampEntry[] = [];
  for (const name of names) {
    const fullPath = path.join(dir, name);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      entries.push({ fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // skip
    }
  }
  return entries;
}

/**
 * Scan `dir` and drop anything older than `maxAgeMs` or beyond
 * `maxCount` (oldest-first). Returns the number of files removed.
 * Best-effort: per-file errors are swallowed.
 *
 * `dir` is expected to be a `corrupted/` directory created by
 * `quarantineFile`. We never recurse; only direct children are
 * considered. Missing directories return `{removed: 0}`.
 */
export async function cleanupQuarantine(
  dir: string,
  opts?: QuarantineOptions,
): Promise<{ removed: number }> {
  const clock = resolveClock(opts);
  const maxAgeMs = resolveMaxAge(opts);
  const maxCount = resolveMaxCount(opts);
  const now = clock();

  const entries = await listQuarantineEntries(dir);
  if (entries.length === 0) return { removed: 0 };

  // Oldest first so maxCount eviction naturally targets the oldest.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const toRemove = new Set<string>();

  // 1. Age-based eviction.
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) {
      toRemove.add(entry.fullPath);
    }
  }

  // 2. Count-based eviction on whatever remains. We iterate the
  //    already-oldest-first list; once the remaining count fits the
  //    cap we stop. This keeps the NEWEST `maxCount` files.
  const survivors = entries.filter((e) => !toRemove.has(e.fullPath));
  if (survivors.length > maxCount) {
    const overflow = survivors.length - maxCount;
    for (let i = 0; i < overflow; i++) {
      toRemove.add(survivors[i].fullPath);
    }
  }

  let removed = 0;
  for (const p of toRemove) {
    try {
      await fsp.unlink(p);
      removed++;
    } catch {
      // best-effort
    }
  }
  return { removed };
}

/** Sync counterpart of {@link cleanupQuarantine}. */
export function cleanupQuarantineSync(
  dir: string,
  opts?: QuarantineOptions,
): { removed: number } {
  const clock = resolveClock(opts);
  const maxAgeMs = resolveMaxAge(opts);
  const maxCount = resolveMaxCount(opts);
  const now = clock();

  const entries = listQuarantineEntriesSync(dir);
  if (entries.length === 0) return { removed: 0 };

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const toRemove = new Set<string>();

  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) {
      toRemove.add(entry.fullPath);
    }
  }

  const survivors = entries.filter((e) => !toRemove.has(e.fullPath));
  if (survivors.length > maxCount) {
    const overflow = survivors.length - maxCount;
    for (let i = 0; i < overflow; i++) {
      toRemove.add(survivors[i].fullPath);
    }
  }

  let removed = 0;
  for (const p of toRemove) {
    try {
      fs.unlinkSync(p);
      removed++;
    } catch {
      // best-effort
    }
  }
  return { removed };
}
