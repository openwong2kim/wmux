import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export class SessionFileError extends Error {
  constructor(public readonly status: number, public readonly tag: string) { super(tag); }
}
const MAX_BYTES = 1024 * 1024;
const PAGE_SIZE = 200;

/** Workspace-relative, bounded reads. Never trust the terminal's OSC cwd. */
export async function sessionFiles(root: string, relative: string, offset: number, preview: boolean) {
  if (relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new SessionFileError(400, 'invalid-path');
  }
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative || '.');
  const inside = (p: string) => p === base || p.startsWith(base + path.sep);
  if (!inside(target)) throw new SessionFileError(403, 'outside-workspace');
  // Symlinks are not traversed, including links to another location inside the workspace.
  let cursor = base;
  for (const component of path.relative(base, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new SessionFileError(403, 'symlink');
  }
  if (!inside(await fs.realpath(target))) throw new SessionFileError(403, 'outside-workspace');
  if (!preview) {
    const directory = await fs.opendir(target);
    const entries: Array<{name: string; path: string; directory: boolean}> = [];
    let seen = 0;
    let hasMore = false;
    for await (const entry of directory) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      if (seen++ < offset) continue;
      if (entries.length === PAGE_SIZE) { hasMore = true; break; }
      entries.push({ name: entry.name, path: path.relative(base, path.join(target, entry.name)), directory: entry.isDirectory() });
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { path: relative, entries, nextOffset: hasMore ? offset + entries.length : null };
  }
  const before = await fs.stat(target);
  if (!before.isFile()) throw new SessionFileError(415, 'not-a-file');
  if (before.size > MAX_BYTES) throw new SessionFileError(413, 'file-too-large');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || !inside(await fs.realpath(target))) {
      throw new SessionFileError(409, 'file-changed');
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new SessionFileError(413, 'file-too-large');
    const bytes = buffer.subarray(0, bytesRead);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (png || jpeg) return { path: relative, mime: png ? 'image/png' : 'image/jpeg', base64: bytes.toString('base64') };
    if (bytes.includes(0)) throw new SessionFileError(415, 'binary-file');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new SessionFileError(415, 'binary-file'); }
    return { path: relative, mime: 'text/plain', text };
  } finally { await handle.close(); }
}

/** Bounded filename search; reuse the same path and symlink checks as browsing. */
export async function searchSessionFiles(root: string, relative: string, query: string) {
  if (!query.trim() || query.length > 200 || query.includes('\0')) {
    throw new SessionFileError(400, 'invalid-query');
  }
  const needle = query.toLocaleLowerCase();
  const pending = [{ path: relative, depth: 0 }];
  const entries: Array<{name: string; path: string; directory: boolean}> = [];
  const deadline = Date.now() + 3000;
  let scanned = 0;
  let truncated = false;
  while (pending.length) {
    const directory = pending.shift()!;
    let offset = 0;
    for (;;) {
      if (scanned >= 10000 || Date.now() >= deadline || entries.length >= PAGE_SIZE) {
        return { path: relative, entries, nextOffset: null, truncated: true };
      }
      let page;
      try { page = await sessionFiles(root, directory.path, offset, false); }
      catch (error) {
        if (directory.path === relative) throw error;
        truncated = true; // A folder disappeared or became inaccessible during traversal.
        break;
      }
      if (!page.entries) throw new SessionFileError(500, 'invalid-directory');
      for (const entry of page.entries) {
        if (++scanned > 10000 || entries.length >= PAGE_SIZE) {
          return { path: relative, entries, nextOffset: null, truncated: true };
        }
        if (entry.name === '.git') continue;
        if (entry.path.toLocaleLowerCase().includes(needle)) entries.push(entry);
        if (entry.directory) {
          if (directory.depth < 32) pending.push({ path: entry.path, depth: directory.depth + 1 });
          else truncated = true;
        }
      }
      if (page.nextOffset == null) break;
      offset = page.nextOffset;
    }
  }
  return { path: relative, entries, nextOffset: null, truncated };
}
