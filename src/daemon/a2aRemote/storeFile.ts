import fs from 'node:fs';

/**
 * Shared load helpers for the cross-host A2A stores (links, exposure, peers,
 * remote hosts). Writes go through each store's own writer; this module only
 * covers the READ side, which deliberately does NOT use `atomicReadJSONSync`:
 * that helper falls back to the `.bak` generation when the primary is
 * unreadable, and a stale generation is exactly what these stores must never
 * resurrect (a revoked peer, a cleared exposure, a revoked link would come
 * back to life).
 */

export type StoreLog = (level: 'info' | 'warn' | 'error', msg: string) => void;

export type StoreFileRead =
  | { kind: 'missing' }
  | { kind: 'parsed'; value: unknown }
  /** The bytes were read and are not valid JSON. */
  | { kind: 'corrupt'; detail: string }
  /**
   * The file exists but could not be READ (EBUSY / EPERM / EACCES / EIO —
   * typically an antivirus scanner holding it on Windows). This is not
   * corruption: the store must go unavailable and never move, rotate or
   * overwrite the original, or a pairing credential could be lost for good.
   */
  | { kind: 'unavailable'; detail: string };

/** Delays between read attempts on a non-ENOENT error (total ~150ms, sync). */
export const READ_RETRY_DELAYS_MS: readonly number[] = [25, 50, 75];

/** Read and parse a store file. Never throws. */
export function readStoreFile(
  filePath: string,
  delaysMs: readonly number[] = READ_RETRY_DELAYS_MS,
): StoreFileRead {
  let raw: string | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      lastErr = err;
      if (attempt < delaysMs.length) sleepSync(delaysMs[attempt]);
    }
  }
  if (raw === null) return { kind: 'unavailable', detail: errMsg(lastErr) };
  if (!raw.trim()) return { kind: 'corrupt', detail: 'empty file' };
  try {
    const value: unknown = JSON.parse(raw, (key, v: unknown) => {
      // Prototype pollution guard (mirrors config.ts / DeviceStore).
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return v;
    });
    return { kind: 'parsed', value };
  } catch (err) {
    return { kind: 'corrupt', detail: `malformed JSON: ${errMsg(err)}` };
  }
}

/**
 * Move a corrupt store file aside as `<file>.corrupt-<ts>` (with a `-<n>`
 * counter when that name is taken) so the next write neither overwrites the
 * evidence nor rotates it into `.bak`. Rename (not copy) keeps the original
 * inode and its owner-only permissions. Returns the new path, or null when
 * the move failed — the caller must then go unavailable rather than write
 * over the original.
 */
export function preserveCorrupt(filePath: string, now: () => number, log: StoreLog): string | null {
  const base = `${filePath}.corrupt-${now()}`;
  let target = base;
  for (let n = 1; fs.existsSync(target); n++) target = `${base}-${n}`;
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch (err) {
    log('error', `[a2a-remote] could not preserve corrupt ${filePath}: ${errMsg(err)}`);
    return null;
  }
}

/**
 * Load-time outcome for a store: the parsed value when usable, or the store
 * starts empty. `writable` is false when the original must not be touched —
 * the file could not be read, or a corrupt file could not be moved aside —
 * and every mutation must then be refused.
 */
export function loadStore<T>(opts: {
  filePath: string;
  fileName: string;
  coerce: (raw: unknown) => T | null;
  now: () => number;
  log: StoreLog;
  /** 'warn' for link/exposure; 'error' for the fail-closed auth stores. */
  level: 'warn' | 'error';
  /** What an empty start means, for the log line. */
  emptyMeans: string;
}): { value: T | null; writable: boolean } {
  const read = readStoreFile(opts.filePath);
  if (read.kind === 'missing') return { value: null, writable: true };
  if (read.kind === 'unavailable') {
    opts.log('error', `[a2a-remote] ${opts.fileName} could not be read (${read.detail}); store is unavailable and the file is left untouched`);
    return { value: null, writable: false };
  }
  const value = read.kind === 'parsed' ? opts.coerce(read.value) : null;
  if (value !== null) return { value, writable: true };
  const detail = read.kind === 'corrupt' ? read.detail : 'invalid shape';
  const kept = preserveCorrupt(opts.filePath, opts.now, opts.log);
  opts.log(
    opts.level,
    `[a2a-remote] ${opts.fileName} is corrupt (${detail}); ${opts.emptyMeans}. ${kept ? `Original kept at ${kept}` : 'Original left in place; store is unavailable'}`,
  );
  return { value: null, writable: kept !== null };
}

export function storeUnavailable(fileName: string): Error {
  return new Error(`${fileName}: store is unavailable (unreadable or unmovable file on disk); refusing to write`);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** Max length of a workspace / pane id taken from a remote host. */
export const ID_MAX = 128;

/** A bounded identifier with no control characters (remote input). */
export function isSafeId(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX && !/[\u0000-\u001f\u007f]/.test(v);
}

export const NAME_MAX = 64;

/**
 * Display labels (DeviceStore's rule): control characters become spaces,
 * whitespace collapses, trimmed, bounded. Empty → `fallback`.
 */
export function sanitizeName(name: unknown, fallback: string): string {
  const cleaned = (typeof name === 'string' ? name : '')
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > NAME_MAX ? cleaned.slice(0, NAME_MAX) : cleaned;
}

/** Max length of a repo key (`host/owner/repo`) taken from a remote host. */
export const REPO_KEY_MAX = 256;

/**
 * A display-only repo key from remote input: trimmed, no control characters
 * or whitespace, bounded. Anything else is dropped ('').
 */
export function sanitizeRepoKey(v: unknown): string {
  if (typeof v !== 'string') return '';
  const key = v.trim();
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (!key || key.length > REPO_KEY_MAX || /[\u0000-\u001f\u007f\s]/.test(key)) return '';
  return key;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
