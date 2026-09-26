import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class FolderBrowseError extends Error {
  constructor(public readonly status: number, public readonly tag: string) { super(tag); }
}

/** Entries a response carries; `truncated` says more existed. */
export const MAX_FOLDER_ENTRIES = 500;
/** Directory entries of any kind one listing reads before it stops, so a
 * folder holding millions of files costs a bounded walk, not the whole one. */
export const MAX_SCANNED_ENTRIES = 20000;
/** `.git` probes in flight at once; the fs thread pool is shared with the rest of the daemon. */
const GIT_PROBE_CONCURRENCY = 16;

export interface FolderEntry { name: string; path: string; git: boolean }
export interface FolderListing { path: string; parent: string | null; entries: FolderEntry[]; truncated: boolean }

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
/** `loose` folds case for a path as the phone spelled it; two realpaths are
 * compared exactly, since the OS already gave both their canonical case. */
const inside = (base: string, p: string, loose = false) => {
  const b = loose ? fold(base) : base; const q = loose ? fold(p) : p;
  return q === b || q.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

/** A home that is a filesystem root would make "under home" mean the whole disk. */
export function homeIsBrowsable(home: string = os.homedir()): boolean {
  const resolved = path.resolve(home);
  return path.parse(resolved).root !== resolved;
}

/** Missing and not-a-directory read the same; a refusal from the OS (macOS
 * privacy protection, file modes) is told apart so the phone can say how to
 * grant it. Anything else is not a statement about the folder. */
function fsFailure(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FolderBrowseError(404, 'folder-not-found');
  if (code === 'EACCES' || code === 'EPERM') return new FolderBrowseError(403, 'permission-denied');
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Directory names under the user's home, for picking a new workspace or pane
 * folder from a phone. Names only: no files, no contents. A path spelled
 * outside home is refused before any lookup. Everything else is resolved by
 * realpath, so a symlink that leads out of home is refused rather than
 * followed, and a symlinked entry inside the listing is not offered at all.
 * Dot folders are left out unless `hidden`. Subfolders are listed without
 * opening them: whether one is readable is learned when it is asked for.
 */
export async function listFolders(requested: string | undefined, opts: { hidden?: boolean; home?: string } = {}): Promise<FolderListing> {
  const raw = requested ?? '';
  if (raw.includes('\0')) throw new FolderBrowseError(400, 'invalid-path');
  const home = opts.home ?? os.homedir();
  if (!homeIsBrowsable(home)) throw new FolderBrowseError(403, 'outside-home');
  // `~` is this API's own spelling of home on every platform, not a shell's.
  const expanded = raw === '' || raw === '~' ? home
    : raw.startsWith('~/') || (process.platform === 'win32' && raw.startsWith('~\\')) ? path.join(home, raw.slice(2))
      : raw;
  if (!path.isAbsolute(expanded)) throw new FolderBrowseError(400, 'invalid-path');

  const base = await fs.realpath(home);
  // Refused by spelling first, so a path outside home never gets as far as a
  // lookup: 403 against 404 there would say what exists on the rest of the disk.
  const spelled = path.resolve(expanded);
  const from = inside(base, spelled, true) ? base : inside(home, spelled, true) ? path.resolve(home) : null;
  if (from === null) throw new FolderBrowseError(403, 'outside-home');
  // Walked one segment at a time from home rather than handed to realpath
  // whole, for the same reason: through a symlink that leads out, a later
  // segment would be looked up outside home and answer 403 or 404 by whether
  // it exists there. A symlink segment is resolved on its own and, if it
  // leaves home or dangles, the walk stops with one answer for both.
  let target = base;
  for (const segment of path.relative(from, spelled).split(path.sep).filter(Boolean)) {
    const next = path.join(target, segment);
    let link: boolean;
    try { link = (await fs.lstat(next)).isSymbolicLink(); }
    catch (error) { throw fsFailure(error); }
    if (!link) { target = next; continue; }
    const resolved = await fs.realpath(next).catch(() => null);
    if (resolved === null || !inside(base, resolved)) throw new FolderBrowseError(403, 'outside-home');
    target = resolved;
  }

  let dir;
  try {
    if (!(await fs.stat(target)).isDirectory()) throw new FolderBrowseError(404, 'folder-not-found');
    dir = await fs.opendir(target);
  } catch (error) {
    throw error instanceof FolderBrowseError ? error : fsFailure(error);
  }

  const names: string[] = [];
  let complete = true;
  let scanned = 0;
  try {
    for await (const entry of dir) {
      if (++scanned > MAX_SCANNED_ENTRIES) { complete = false; break; }
      if (!opts.hidden && entry.name.startsWith('.')) continue;
      let directory = entry.isDirectory();
      // Some filesystems report no type at all; only then is an lstat worth it.
      // lstat, not stat: a symlink is never offered.
      if (!directory && !entry.isFile() && !entry.isSymbolicLink() && !entry.isSocket()
        && !entry.isFIFO() && !entry.isBlockDevice() && !entry.isCharacterDevice()) {
        directory = await fs.lstat(path.join(target, entry.name)).then(s => s.isDirectory(), () => false);
      }
      if (directory) names.push(entry.name);
    }
  } catch {
    complete = false; // a read that failed partway answers with what it gave, marked incomplete
  } finally {
    await dir.close().catch(() => { /* already closed by the iterator */ });
  }
  names.sort((a, b) => a.localeCompare(b));
  const kept = names.slice(0, MAX_FOLDER_ENTRIES);
  const entries: FolderEntry[] = [];
  for (let i = 0; i < kept.length; i += GIT_PROBE_CONCURRENCY) {
    entries.push(...await Promise.all(kept.slice(i, i + GIT_PROBE_CONCURRENCY).map(async (name): Promise<FolderEntry> => {
      const full = path.join(target, name);
      const git = await fs.lstat(path.join(full, '.git')).then(() => true, () => false);
      return { name, path: full, git };
    })));
  }
  return {
    path: target,
    parent: target === base ? null : path.dirname(target),
    entries,
    truncated: !complete || names.length > MAX_FOLDER_ENTRIES,
  };
}
