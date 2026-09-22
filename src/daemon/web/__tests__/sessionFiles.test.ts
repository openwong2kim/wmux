import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sessionFiles, searchSessionFiles } from '../sessionFiles';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-files-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
/** Narrows the listing branch of the union so pages can be compared directly. */
async function list(base: string, relative: string, offset: number): Promise<{
  entries: Array<{name: string; path: string; directory: boolean}>;
  nextOffset: number | null;
}> {
  const page = await sessionFiles(base, relative, offset, false) as {
    entries?: Array<{name: string; path: string; directory: boolean}>;
    nextOffset?: number | null;
  };
  if (!page.entries) throw new Error('expected a directory listing');
  return { entries: page.entries, nextOffset: page.nextOffset ?? null };
}
describe('workspace file reads', () => {
  it('lists nested files and preserves Unicode text', async () => {
    await fs.mkdir(path.join(root, '소스'));
    await fs.writeFile(path.join(root, '소스', '한글.swift'), 'let greeting = "안녕하세요"');
    expect(await sessionFiles(root, '소스', 0, false)).toMatchObject({entries:[{name:'한글.swift',path:'소스/한글.swift',directory:false}],nextOffset:null});
    expect(await sessionFiles(root, '소스/한글.swift', 0, true)).toMatchObject({text:'let greeting = "안녕하세요"'});
  });
  it('refuses traversal and symlinks', async () => {
    await expect(sessionFiles(root, '../secret', 0, true)).rejects.toMatchObject({status:400});
    await expect(sessionFiles(root, '/etc/passwd', 0, true)).rejects.toMatchObject({status:400});
    await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
    await expect(sessionFiles(root, 'escape', 0, false)).rejects.toMatchObject({status:403});
    expect(await sessionFiles(root, '', 0, false)).toMatchObject({entries:[]});
  });
  it('caps reads and rejects binary files', async () => {
    await fs.writeFile(path.join(root, 'large'), Buffer.alloc(1024 * 1024 + 1));
    await expect(sessionFiles(root, 'large', 0, true)).rejects.toMatchObject({status:413});
    await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
    await expect(sessionFiles(root, 'binary', 0, true)).rejects.toMatchObject({status:415});
  });
  // 205 creates plus a per-entry lstat is slow on the Windows runner under load.
  it('paginates directories without dropping entries', { timeout: 30_000 }, async () => {
    await Promise.all(Array.from({length:205}, (_, i) => fs.writeFile(path.join(root, `file-${i}`), '')));
    const first = await sessionFiles(root, '', 0, false);
    const second = await sessionFiles(root, '', 200, false);
    expect(first).toHaveProperty('nextOffset',200);
    expect(second).toHaveProperty('nextOffset',null);
    if ('entries' in first && 'entries' in second) expect(new Set([...first.entries!, ...second.entries!].map(e => e.path)).size).toBe(205);
  });
  it('orders pages against the whole directory, not against each page', async () => {
    // Directories and files interleaved, created in an order opendir has no
    // reason to preserve: paging previously sorted each slice on its own, so an
    // entry could land on two pages or on none.
    await Promise.all(Array.from({length:260}, (_, i) =>
      i % 3 === 0 ? fs.mkdir(path.join(root, `entry-${String((i * 97) % 260).padStart(3,'0')}`))
                  : fs.writeFile(path.join(root, `entry-${String((i * 97) % 260).padStart(3,'0')}`), '')));
    const first = await list(root, '', 0);
    const second = await list(root, '', 200);
    const paged = [...first.entries, ...second.entries];
    expect(second.nextOffset).toBeNull();
    expect(paged).toHaveLength(260);
    const expected = [...paged].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    expect(paged.map(e => e.name)).toEqual(expected.map(e => e.name));
  });
  it('hides dot-entries at any depth and answers as if they were absent', async () => {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'config'), '[remote]');
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=private');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', '.secret'), 'private');
    await fs.writeFile(path.join(root, 'src', 'App.swift'), '');
    expect((await list(root, '', 0)).entries.map(e => e.name)).toEqual(['src']);
    expect((await list(root, 'src', 0)).entries.map(e => e.name)).toEqual(['App.swift']);
    for (const hidden of ['.env', '.git', '.git/config', 'src/.secret']) {
      await expect(sessionFiles(root, hidden, 0, true)).rejects.toMatchObject({status:404,tag:'file-unavailable'});
    }
  });
});

describe('workspace filename search', () => {
  it('finds nested paths without following links or searching git internals', async () => {
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, 'src', 'Needle.swift'), '');
    await fs.writeFile(path.join(root, '.git', 'Needle'), '');
    await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
    expect(await searchSessionFiles(root, '', 'needle')).toMatchObject({
      entries: [{ path: 'src/Needle.swift' }], truncated: false,
    });
    await expect(searchSessionFiles(root, '../', 'needle')).rejects.toMatchObject({status:400});
    await expect(searchSessionFiles(root, '', ' ')).rejects.toMatchObject({status:400});
  });
  it('reports truncation when matches exceed the result cap', async () => {
    await Promise.all(Array.from({length:205}, (_, i) => fs.writeFile(path.join(root, `needle-${i}`), '')));
    const result = await searchSessionFiles(root, '', 'needle');
    expect(result.entries).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });
});
