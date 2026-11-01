// fs.list / fs.stat / fs.readText: read-only filesystem access for plugins.
//
// The first half of a file-manager plugin surface (the write half, with a job
// queue for copy/move/trash, follows separately). A plugin that declares
// `fs.read`, and that the user approved, can browse folders and read small
// text files. It cannot write, run anything or reach the network through
// these methods.
//
// Every path goes through `resolvePluginPath` (fsRefusals.ts): the check the
// app's own file tree uses (`resolveAccessiblePath`: local paths only, never
// ~/.ssh, ~/.aws and the like) plus a stricter list for plugins only (wmux's
// own data, .env files, private keys, CLI tokens, shell history), as given
// and once symlinks resolve. A refused path answers `unavailable`, the same as
// one that does not exist, so a caller cannot probe which blocked files are
// there.
//
// Paths must be absolute (or start with `~`, the home folder): main's working
// directory means nothing to a caller.
// Answers carry the canonical (realpath'd) path, which a caller hands back for
// the next call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RpcRouter } from '../RpcRouter';
import { resolvePluginPath } from './fsRefusals';

export type FsEntryKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FsEntry {
  name: string;
  kind: FsEntryKind;
  /** Bytes; 0 for folders. */
  size: number;
  mtimeMs: number;
  /** POSIX permission bits from lstat, when available. */
  mode?: number;
  /** What a symlink leads to; `null` when it is broken or unreadable. */
  target?: 'file' | 'dir' | 'other' | null;
}

export type FsFailure =
  | 'invalid'          // params malformed, or the path is not absolute
  | 'unavailable'      // missing, blocked, or not a local path
  | 'not-a-directory'
  | 'is-a-directory'
  | 'denied'           // the OS refused (EACCES / EPERM)
  | 'binary'           // fs.readText: the file is not text
  | 'failed';

const MAX_PATH_LEN = 4096;
/** fs.list answers at most this many entries and says it truncated. */
export const MAX_LIST_ENTRIES = 10_000;
/** Entries stat'ed at once; a big folder must not open thousands of handles. */
const STAT_BATCH = 64;
export const DEFAULT_READ_BYTES = 256 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;
/** fs.readText calls a file binary when a NUL byte appears this early. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * An absolute, bounded, NUL-free path string; null otherwise. A leading `~`
 * (alone, or followed by a separator) is the user's home folder, as a person
 * types it; `~user` is not expanded.
 */
export function validatePathParam(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LEN) return null;
  if (value.includes('\0')) return null;
  const expanded = value === '~' ? os.homedir()
    : /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) return null;
  return expanded;
}

function failureOf(err: unknown): FsFailure {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'unavailable';
  if (code === 'ENOTDIR') return 'not-a-directory';
  if (code === 'EISDIR') return 'is-a-directory';
  if (code === 'EACCES' || code === 'EPERM') return 'denied';
  return 'failed';
}

function kindOf(stat: fs.Stats): FsEntryKind {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

/** A refused target answers null, like a broken link, so a link cannot probe it. */
async function symlinkTarget(p: string): Promise<FsEntry['target']> {
  try {
    const target = await resolvePluginPath(p);
    if (!target) return null;
    const s = await fs.promises.stat(target);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

/** One entry from lstat; null when it vanished or cannot be read. */
async function entryFor(dir: string, name: string): Promise<FsEntry | null> {
  const full = path.join(dir, name);
  try {
    const s = await fs.promises.lstat(full);
    const kind = kindOf(s);
    const entry: FsEntry = { name, kind, size: kind === 'dir' ? 0 : s.size, mtimeMs: s.mtimeMs, mode: s.mode & 0o777 };
    if (kind === 'symlink') entry.target = await symlinkTarget(full);
    return entry;
  } catch {
    return null;
  }
}

export async function handleFsList(params: Record<string, unknown>) {
  const input = validatePathParam(params.path);
  if (!input) return { ok: false as const, reason: 'invalid' as FsFailure };
  const dir = await resolvePluginPath(input);
  if (!dir) return { ok: false as const, reason: 'unavailable' as FsFailure };
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    return { ok: false as const, reason: failureOf(err) };
  }
  const truncated = names.length > MAX_LIST_ENTRIES;
  if (truncated) names = names.slice(0, MAX_LIST_ENTRIES);
  const entries: FsEntry[] = [];
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const batch = await Promise.all(names.slice(i, i + STAT_BATCH).map((n) => entryFor(dir, n)));
    for (const e of batch) if (e) entries.push(e);
  }
  const parent = path.dirname(dir);
  return { ok: true as const, path: dir, parent: parent === dir ? null : parent, entries, truncated };
}

export async function handleFsStat(params: Record<string, unknown>) {
  const input = validatePathParam(params.path);
  if (!input) return { ok: false as const, reason: 'invalid' as FsFailure };
  const resolved = await resolvePluginPath(input);
  if (!resolved) return { ok: false as const, reason: 'unavailable' as FsFailure };
  const entry = await entryFor(path.dirname(resolved), path.basename(resolved));
  if (!entry) return { ok: false as const, reason: 'unavailable' as FsFailure };
  return { ok: true as const, path: resolved, entry };
}

export async function handleFsReadText(params: Record<string, unknown>) {
  const input = validatePathParam(params.path);
  if (!input) return { ok: false as const, reason: 'invalid' as FsFailure };
  const { maxBytes } = params;
  if (maxBytes !== undefined
      && (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes <= 0)) {
    return { ok: false as const, reason: 'invalid' as FsFailure };
  }
  const limit = Math.min(typeof maxBytes === 'number' ? maxBytes : DEFAULT_READ_BYTES, MAX_READ_BYTES);
  const resolved = await resolvePluginPath(input);
  if (!resolved) return { ok: false as const, reason: 'unavailable' as FsFailure };
  let handle: fs.promises.FileHandle | undefined;
  try {
    // Non-blocking, so a FIFO with no writer cannot hold the call open; only a
    // regular file is read.
    handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (stat.isDirectory()) return { ok: false as const, reason: 'is-a-directory' as FsFailure };
    if (!stat.isFile()) return { ok: false as const, reason: 'failed' as FsFailure };
    // The file opened is the one checked: a path swapped for a link between
    // the check and the open answers `unavailable`.
    const again = await resolvePluginPath(resolved);
    const checked = again ? await fs.promises.stat(again).catch(() => null) : null;
    if (!checked || checked.dev !== stat.dev || checked.ino !== stat.ino) {
      return { ok: false as const, reason: 'unavailable' as FsFailure };
    }
    // The first 8 KB decide binary whatever maxBytes asks for.
    const buf = Buffer.alloc(Math.min(Math.max(limit, BINARY_SNIFF_BYTES), stat.size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const read = buf.subarray(0, bytesRead);
    if (read.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { ok: false as const, reason: 'binary' as FsFailure };
    }
    const cut = read.length > limit || stat.size > read.length;
    const bytes = cut ? wholeUtf8(read.subarray(0, Math.min(limit, read.length))) : read;
    return {
      ok: true as const,
      path: resolved,
      size: stat.size,
      text: bytes.toString('utf-8'),
      truncated: stat.size > bytes.length,
    };
  } catch (err) {
    return { ok: false as const, reason: failureOf(err) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** `bytes` without a UTF-8 character the cut left incomplete at its end. */
export function wholeUtf8(bytes: Buffer): Buffer {
  // Walk back over at most three continuation bytes to the lead byte.
  let i = bytes.length - 1;
  while (i >= 0 && bytes.length - i <= 4 && (bytes[i] & 0xc0) === 0x80) i--;
  if (i < 0 || bytes.length - i > 4) return bytes;
  const lead = bytes[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - i < need ? bytes.subarray(0, i) : bytes;
}

export function registerFsRpc(router: RpcRouter): void {
  router.register('fs.list', handleFsList);
  router.register('fs.stat', handleFsStat);
  router.register('fs.readText', handleFsReadText);
}
