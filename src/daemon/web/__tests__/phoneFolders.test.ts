import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { homeIsBrowsable, listFolders, MAX_FOLDER_ENTRIES } from '../phoneFolders';

let root: string;
let home: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-folders-')));
  home = path.join(root, 'home');
  await fs.mkdir(home);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('phone folder browse', () => {
  it('lists directories only, name-sorted, flags repositories and hides dot folders', async () => {
    await fs.mkdir(path.join(home, 'zeta'));
    await fs.mkdir(path.join(home, 'alpha', '.git'), { recursive: true });
    await fs.mkdir(path.join(home, '.config'));
    await fs.writeFile(path.join(home, 'notes.txt'), '');
    const listing = await listFolders(undefined, { home });
    expect(listing).toEqual({
      path: home,
      parent: null,
      entries: [
        { name: 'alpha', path: path.join(home, 'alpha'), git: true },
        { name: 'zeta', path: path.join(home, 'zeta'), git: false },
      ],
      truncated: false,
    });
    expect((await listFolders('~', { home, hidden: true })).entries.map(e => e.name)).toEqual(['.config', 'alpha', 'zeta']);
    expect(await listFolders('~/alpha', { home })).toMatchObject({ path: path.join(home, 'alpha'), parent: home, entries: [] });
  });

  it('refuses paths outside home without saying whether they exist', async () => {
    await expect(listFolders(root, { home })).rejects.toMatchObject({ status: 403, tag: 'outside-home' });
    await expect(listFolders(path.join(root, 'missing-' + Date.now()), { home })).rejects.toMatchObject({ status: 403, tag: 'outside-home' });
    await expect(listFolders(path.join(home, '..'), { home })).rejects.toMatchObject({ status: 403, tag: 'outside-home' });
    await expect(listFolders('relative/dir', { home })).rejects.toMatchObject({ status: 400, tag: 'invalid-path' });
    await expect(listFolders(path.join(home, 'missing'), { home })).rejects.toMatchObject({ status: 404, tag: 'folder-not-found' });
    await fs.writeFile(path.join(home, 'file'), '');
    await expect(listFolders(path.join(home, 'file'), { home })).rejects.toMatchObject({ status: 404, tag: 'folder-not-found' });
  });

  it('does not follow or offer a symlink that leads out of home', async () => {
    await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(home, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.mkdir(path.join(home, 'real'));
    expect((await listFolders(undefined, { home })).entries.map(e => e.name)).toEqual(['real']);
    await expect(listFolders(path.join(home, 'escape'), { home })).rejects.toMatchObject({ status: 403, tag: 'outside-home' });
    // Through the escaping link, what exists outside and what does not answer alike.
    await fs.mkdir(path.join(root, 'outside', 'present'));
    for (const below of ['present', 'absent']) {
      await expect(listFolders(path.join(home, 'escape', below), { home })).rejects.toMatchObject({ status: 403, tag: 'outside-home' });
    }
    await fs.symlink(path.join(root, 'nowhere'), path.join(home, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(listFolders(path.join(home, 'dangling', 'x'), { home })).rejects.toMatchObject({ status: 403, tag: 'outside-home' });
  });

  it('follows a symlink that stays inside home', async () => {
    await fs.mkdir(path.join(home, 'projects', 'app'), { recursive: true });
    await fs.symlink(path.join(home, 'projects'), path.join(home, 'work'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await listFolders('~/work', { home })).toMatchObject({
      path: path.join(home, 'projects'), parent: home, entries: [{ name: 'app', path: path.join(home, 'projects', 'app'), git: false }],
    });
  });

  // Stands in for macOS privacy protection, which fails the same read with EPERM.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says permission-denied for a folder the OS will not open', async () => {
    const locked = path.join(home, 'locked');
    await fs.mkdir(path.join(locked, 'inner'), { recursive: true });
    await fs.chmod(locked, 0o000);
    try {
      // Listed from its parent without being opened.
      expect((await listFolders(undefined, { home })).entries.map(e => e.name)).toEqual(['locked']);
      await expect(listFolders(locked, { home })).rejects.toMatchObject({ status: 403, tag: 'permission-denied' });
      await expect(listFolders(path.join(locked, 'inner'), { home })).rejects.toMatchObject({ status: 403, tag: 'permission-denied' });
    } finally { await fs.chmod(locked, 0o755); }
  });

  it('refuses to browse when home is a filesystem root', async () => {
    const root = path.parse(home).root;
    expect(homeIsBrowsable(root)).toBe(false);
    expect(homeIsBrowsable(home)).toBe(true);
    await expect(listFolders(undefined, { home: root })).rejects.toMatchObject({ status: 403, tag: 'outside-home' });
  });

  // Windows drops trailing spaces from names on create.
  it.skipIf(process.platform === 'win32')('keeps a folder name with surrounding spaces as given', async () => {
    await fs.mkdir(path.join(home, 'padded '));
    const listing = await listFolders(undefined, { home });
    expect(listing.entries.map(e => e.name)).toEqual(['padded ']);
    expect((await listFolders(listing.entries[0].path, { home })).path).toBe(path.join(home, 'padded '));
  });

  it('caps a listing and says it was cut', { timeout: 30_000 }, async () => {
    await Promise.all(Array.from({ length: MAX_FOLDER_ENTRIES + 5 }, (_, i) => fs.mkdir(path.join(home, `d-${String(i).padStart(4, '0')}`))));
    const listing = await listFolders(undefined, { home });
    expect(listing.entries).toHaveLength(MAX_FOLDER_ENTRIES);
    expect(listing.entries[0].name).toBe('d-0000');
    expect(listing.truncated).toBe(true);
  });
});
