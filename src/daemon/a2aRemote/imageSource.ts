// ─── Reading an image an agent names, before it leaves this PC ─────────────
//
// An agent attaches an image by its path (send_message `images`). The file is
// taken only from an allowed folder, with the checks the Bots room file store
// makes (main/factory/roomFiles.ts `copyIn`), asynchronously because the
// daemon serves every pane on one event loop:
//   - before any file system call, the path as written is inside a root (as
//     given or as resolved), and it is not a device path (`\\?\`, `\\.\`)
//     or a share no root is on (`\\server\share`);
//   - a root counts only by what it resolves to: not the home folder or a
//     folder holding it (compared by device and inode, so a link, a junction,
//     an 8.3 name or a macOS firmlink spelling of home is caught), and not
//     the top of a file system (a drive, a volume, a mount point);
//   - its real path (every link in its folders resolved) is strictly inside
//     the real path of an allowed root (exact case on Windows);
//   - below that root, no segment is hidden (starts with `.`: `.git`, `.ssh`,
//     `.env`, caches) or a protected file (botRepoRead.ts patterns: keys,
//     credentials), and on Windows none names a stream, a device or a name
//     Windows rewrites;
//   - it is a regular file with one name (a hard link may hold a file from
//     outside every root), not a link;
//   - it opens without following a link, and the descriptor is the file
//     lstat saw (device and inode); after the read its real path is checked
//     again;
//   - it is at most one image's size.
// The roots are the caller's (`imageRoots`): the sender pane's spawn folder
// and the wmux uploads folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { A2A_REMOTE_IMAGE_LIMITS } from '../../shared/a2aRemote';
import { sameFileId } from '../../shared/sameFileId';
import { dataSuffix } from '../../shared/constants';
import { protectedPatternOf } from '../../main/factory/botRepoRead';
import { isWin32UnsafeName, namesWin32Stream, strictlyInside } from '../../main/factory/roomFiles';

export type ImageSourceRefusal = 'relative' | 'missing' | 'outside' | 'hidden' | 'protected' | 'not-file' | 'links' | 'size' | 'empty' | 'changed';

export type ImageSourceRead = { ok: true; bytes: Buffer } | { ok: false; reason: ImageSourceRefusal };

/** No link followed, and a FIFO swapped in never blocks the open. */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * The folders an agent may attach from. The sender pane's spawn folder counts
 * unless the home folder is inside it or is it (home itself, `/Users`, a
 * filesystem root: that would open every picture the user has); with no
 * verified pane (`spawnCwd` undefined) only the uploads folder does. A spawn folder this daemon cannot open as a folder of
 * its own (a WSL pane's Linux path on Windows) is not a root either.
 */
export function imageRoots(spawnCwd: string | undefined, uploadsRoot: string, home: string = os.homedir()): string[] {
  const roots = [uploadsRoot];
  if (!spawnCwd || !path.isAbsolute(spawnCwd)) return roots;
  const resolved = path.resolve(spawnCwd);
  if (resolved === path.parse(resolved).root || containsOrIs(resolved, path.resolve(home))) return roots;
  if (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(spawnCwd)) return roots;
  roots.push(resolved);
  return roots;
}

/** Read one image file an agent named, or say why not. */
export async function readImageSource(source: string, roots: readonly string[], home: string = os.homedir()): Promise<ImageSourceRead> {
  if (!path.isAbsolute(source)) return { ok: false, reason: 'relative' };
  if (process.platform === 'win32' && namesWin32Stream(source)) return { ok: false, reason: 'not-file' };
  const realRoots = await safeRealRoots(roots, home);
  // Nothing outside the roots, and no device or foreign share, ever reaches the file system.
  if (process.platform === 'win32' && shareOrDevice(source, realRoots)) return { ok: false, reason: 'outside' };
  if (!lexicallyInside(source, [...roots, ...realRoots])) return { ok: false, reason: 'outside' };
  let lst: fs.BigIntStats;
  try {
    lst = await fs.promises.lstat(source, { bigint: true });
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const real = await realpathOrNull(source);
  if (!real) return { ok: false, reason: 'missing' };
  const rel = containingRel(realRoots, real);
  if (rel === null) return { ok: false, reason: 'outside' };
  const segments = rel.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s.startsWith('.'))) return { ok: false, reason: 'hidden' };
  if (protectedPatternOf(rel)) return { ok: false, reason: 'protected' };
  if (process.platform === 'win32' && segments.some((s) => isWin32UnsafeName(s))) return { ok: false, reason: 'not-file' };
  if (!lst.isFile() || lst.isSymbolicLink()) return { ok: false, reason: 'not-file' };
  if (lst.nlink > 1) return { ok: false, reason: 'links' };
  if (lst.size > A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES) return { ok: false, reason: 'size' };
  if (lst.size === 0n) return { ok: false, reason: 'empty' };
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(real, OPEN_FLAGS);
  } catch {
    return { ok: false, reason: 'changed' };
  }
  let bytes: Buffer | null;
  let fst: fs.BigIntStats;
  try {
    fst = await handle.stat({ bigint: true });
    if (!fst.isFile() || !sameFileId(fst, lst)) return { ok: false, reason: 'changed' };
    if (fst.nlink > 1) return { ok: false, reason: 'links' };
    if (fst.size > A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES) return { ok: false, reason: 'size' };
    // Linux names the opened file itself: that path must be inside a root.
    if (process.platform === 'linux') {
      const opened = await fs.promises.readlink(`/proc/self/fd/${handle.fd}`);
      if (containingRel(realRoots, opened) === null) return { ok: false, reason: 'changed' };
    }
    bytes = await readBounded(handle, A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES);
  } catch {
    return { ok: false, reason: 'changed' };
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!bytes) return { ok: false, reason: 'size' };
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  // A folder above the file swapped for a link around the open is caught here.
  const after = await realpathOrNull(source);
  if (after !== real || containingRel(realRoots, after) === null) return { ok: false, reason: 'changed' };
  try {
    const now = await fs.promises.lstat(after, { bigint: true });
    if (!sameFileId(now, fst)) return { ok: false, reason: 'changed' };
  } catch {
    return { ok: false, reason: 'changed' };
  }
  return { ok: true, bytes };
}

/** What a refusal tells the agent: words it can act on. */
export function imageSourceMessage(reason: ImageSourceRefusal): string {
  switch (reason) {
    case 'relative':
      return 'give an absolute path';
    case 'missing':
      return 'no such file';
    case 'outside':
      // The uploads folder of this instance (getWmuxDir() carries the suffix).
      return `only files in your pane's project folder or in ~/.wmux${dataSuffix()}/uploads/ can be attached; copy it there first`;
    case 'hidden':
      return 'a file in a hidden folder (or a hidden file) is never attached';
    case 'protected':
      return 'a protected file (keys, credentials, .env) is never attached';
    case 'not-file':
      return 'not a regular file';
    case 'links':
      return 'a file with more than one name (a hard link) is not attached';
    case 'size':
      return `larger than ${A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES / (1024 * 1024)} MB`;
    case 'empty':
      return 'the file is empty';
    case 'changed':
      return 'the file changed while it was read; try again';
  }
}

/**
 * The real paths of the roots that may be read from: not home or a folder
 * holding it, and not the top of a file system. Compared by device and inode,
 * so no spelling of home (a link or junction to it, an 8.3 name, a firmlink
 * path) passes.
 */
async function safeRealRoots(roots: readonly string[], home: string): Promise<string[]> {
  const homeChain = await ancestorIds(home);
  const out: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root)) continue;
    // eslint-disable-next-line no-await-in-loop -- two roots at most
    const real = await realpathOrNull(root);
    // eslint-disable-next-line no-await-in-loop
    const st = real ? await statOrNull(real) : null;
    if (!real || !st?.isDirectory()) continue;
    if (homeChain.has(idOf(st))) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isFileSystemTop(real, st)) continue;
    out.push(real);
  }
  return out;
}

/** Device and inode of home's real path and of every folder above it. */
async function ancestorIds(home: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let at = (await realpathOrNull(home)) ?? path.resolve(home);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a handful of levels
    const st = await statOrNull(at);
    if (st) ids.add(idOf(st));
    const up = path.dirname(at);
    if (up === at) return ids;
    at = up;
  }
}

/** A drive or file system root, or a mount point (its parent is on another device). */
async function isFileSystemTop(real: string, st: fs.BigIntStats): Promise<boolean> {
  const up = path.dirname(real);
  if (up === real) return true;
  const parent = await statOrNull(up);
  return !parent || parent.dev !== st.dev;
}

function idOf(st: fs.BigIntStats): string {
  return `${st.dev}:${st.ino}`;
}

async function statOrNull(p: string): Promise<fs.BigIntStats | null> {
  try {
    return await fs.promises.stat(p, { bigint: true });
  } catch {
    return null;
  }
}

/** A Windows device path, or a UNC path on a share no root is on. */
function shareOrDevice(source: string, realRoots: readonly string[]): boolean {
  if (!/^[\\/]{2}/.test(source)) return false;
  if (/^[\\/]{2}[?.][\\/]/.test(source)) return true;
  const share = (p: string): string | null => {
    const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(p);
    return m ? `${m[1]}\\${m[2]}`.toLowerCase() : null;
  };
  const mine = share(source);
  return mine === null || !realRoots.some((r) => share(r) === mine);
}

/** `source`, as written, is strictly inside one of `roots` (case-folded where the file system usually is). */
function lexicallyInside(source: string, roots: readonly string[]): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const norm = (p: string): string => (fold ? path.resolve(p).toLowerCase() : path.resolve(p));
  const target = norm(source);
  return roots.some((r) => {
    const rel = path.relative(norm(r), target);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

function containingRel(realRoots: readonly string[], real: string): string | null {
  for (const root of realRoots) {
    const rel = strictlyInside(root, real);
    if (rel !== null) return rel;
  }
  return null;
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

/** `inner` is `outer` or below it (case-insensitively where the file system usually is). */
function containsOrIs(outer: string, inner: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const o = fold ? outer.toLowerCase() : outer;
  const i = fold ? inner.toLowerCase() : inner;
  if (o === i) return true;
  const rel = path.relative(o, i);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Read to the end, or null past `max` (a file that grows after its stat is never read whole). */
async function readBounded(handle: fs.promises.FileHandle, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > max) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}
