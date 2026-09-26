import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class FolderBrowseError extends Error {
  constructor(public readonly status: number, public readonly tag: string) { super(tag); }
}

/** Entries a response carries; `truncated` says more existed. */
export const MAX_FOLDER_ENTRIES = 500;
/** How many entries one directory read collects before sorting. A directory
 * past this is cut before the sort, so the first 500 stay stable per call. */
const MAX_SCANNED_ENTRIES = 20000;

export interface FolderEntry { name: string; path: string; git: boolean }
export interface FolderListing { path: string; parent: string | null; entries: FolderEntry[]; truncated: boolean }

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (base: string, p: string) => {
  const b = fold(base); const q = fold(p);
  return q === b || q.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

/**
 * Directory names under the user's home, for picking a new workspace or pane
 * folder from a phone. Names only: no files, no contents. Resolved by realpath,
 * so a symlink that leads out of home is refused rather than followed; a
 * symlinked entry inside the listing is not offered at all. Dot folders are
 * left out unless `hidden`.
 */
export async function listFolders(requested: string | undefined, opts: { hidden?: boolean; home?: string } = {}): Promise<FolderListing> {
  const raw = (requested ?? '').trim();
  if (raw.includes('\0')) throw new FolderBrowseError(400, 'invalid-path');
  const home = opts.home ?? os.homedir();
  // `~` is this API's own spelling of home on every platform, not a shell's.
  const expanded = raw === '' || raw === '~' ? home
    : raw.startsWith('~/') || (process.platform === 'win32' && raw.startsWith('~\\')) ? path.join(home, raw.slice(2))
      : raw;
  if (!path.isAbsolute(expanded)) throw new FolderBrowseError(400, 'invalid-path');

  const base = await fs.realpath(home);
  // Refused by spelling first, so a path outside home never gets as far as a
  // lookup: 403 against 404 there would say what exists on the rest of the disk.
  const spelled = path.resolve(expanded);
  if (!inside(home, spelled) && !inside(base, spelled)) throw new FolderBrowseError(403, 'outside-home');
  let target: string;
  try { target = await fs.realpath(expanded); }
  catch { throw new FolderBrowseError(404, 'folder-not-found'); }
  if (!inside(base, target)) throw new FolderBrowseError(403, 'outside-home'); // a symlink that leads out

  let dir;
  try {
    if (!(await fs.stat(target)).isDirectory()) throw new FolderBrowseError(404, 'folder-not-found');
    dir = await fs.opendir(target);
  } catch (error) {
    if (error instanceof FolderBrowseError) throw error;
    // Unreadable reads like missing: asking must not tell the two apart.
    throw new FolderBrowseError(404, 'folder-not-found');
  }

  const names: string[] = [];
  let scannedAll = true;
  try {
    for await (const entry of dir) {
      if (!entry.isDirectory()) continue; // files, sockets and symlinks are not offered
      if (!opts.hidden && entry.name.startsWith('.')) continue;
      if (names.length === MAX_SCANNED_ENTRIES) { scannedAll = false; break; }
      names.push(entry.name);
    }
  } catch { /* a directory that fails mid-read answers with what it gave */ }
  names.sort((a, b) => a.localeCompare(b));
  const kept = names.slice(0, MAX_FOLDER_ENTRIES);
  const entries = await Promise.all(kept.map(async (name): Promise<FolderEntry> => {
    const full = path.join(target, name);
    let git = false;
    try { await fs.lstat(path.join(full, '.git')); git = true; } catch { /* not a repository */ }
    return { name, path: full, git };
  }));
  return {
    path: target,
    parent: fold(target) === fold(base) ? null : path.dirname(target),
    entries,
    truncated: !scannedAll || names.length > MAX_FOLDER_ENTRIES,
  };
}
