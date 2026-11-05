import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  shell: { trashItem: vi.fn() },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
}));
import { FsJobQueue } from '../fsWrite.rpc';
let root: string;
let src: string;
let dest: string;
let home: string;
let queue: FsJobQueue;
const trash = vi.fn(async (p: string) => { void p; });
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fswrite-')));
  src = path.join(root, 'src'); dest = path.join(root, 'dest'); home = path.join(root, 'home');
  for (const dir of [src, dest, path.join(home, '.ssh')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(src, 'a'), Buffer.alloc(1024 * 1024, 'a'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  trash.mockClear(); queue = new FsJobQueue(trash);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
async function finish(result: Awaited<ReturnType<FsJobQueue['start']>>) {
  if (!result.ok) throw new Error(result.reason);
  await vi.waitFor(() => expect(queue.status(result.jobId).job?.state).not.toBe('running'), { timeout: 10_000 });
  const job = queue.status(result.jobId).job;
  if (!job) throw new Error('Missing job');
  return job;
}
const copy = (conflict = 'fail') => queue.start('copy', { sources: [path.join(src, 'a')], destDir: dest, conflict });
/**
 * Holds every copy's bytes until the returned release is called, so a job is
 * still running when a test asks for an overlapping one. A fast runner would
 * otherwise finish the first copy before the second request's lock check.
 */
function holdCopies(): () => void {
  let release: () => void = () => { throw new Error('Gate not initialized'); };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const create = fs.createReadStream;
  vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
    const held = new PassThrough();
    void gate.then(() => create(...args).pipe(held));
    return held as unknown as fs.ReadStream;
  });
  return () => release();
}

describe('filesystem write jobs', () => {
  it('creates and renames with validated names and existing-target errors', async () => {
    expect(await queue.mkdir({ path: path.join(src, 'new') })).toEqual({ ok: true, path: path.join(src, 'new') });
    expect(await queue.mkdir({ path: path.join(src, 'new') })).toMatchObject({ reason: 'exists' });
    expect(await queue.mkdir({ path: 'relative' })).toMatchObject({ reason: 'invalid' });
    for (const newName of ['.', '..', 'a/b', 'a\\b', 'a\0b']) expect(await queue.rename({ path: src, newName })).toMatchObject({ reason: 'invalid' });
    expect(await queue.rename({ path: path.join(src, 'new'), newName: 'a' })).toMatchObject({ reason: 'exists' });
    expect(await queue.rename({ path: path.join(src, 'new'), newName: 'renamed' })).toMatchObject({ ok: true });
    expect(await queue.rename({ path: path.join(src, 'absent'), newName: 'x' })).toMatchObject({ reason: 'unavailable' });
  });
  it('copies a tree, preserves links and mtime, and reaches progress totals', async () => {
    fs.mkdirSync(path.join(src, 'tree')); fs.writeFileSync(path.join(src, 'tree', 'b'), 'hello');
    if (process.platform !== 'win32') fs.symlinkSync('b', path.join(src, 'tree', 'link'));
    const stamp = new Date('2020-01-01'); fs.utimesSync(path.join(src, 'a'), stamp, stamp);
    const job = await finish(await queue.start('copy', { sources: [src], destDir: dest, conflict: 'fail' }));
    expect(job.state).toBe('done'); expect(job.doneBytes).toBe(job.totalBytes); expect(job.doneItems).toBe(job.totalItems);
    expect(fs.readFileSync(path.join(dest, 'src', 'tree', 'b'), 'utf8')).toBe('hello');
    expect(fs.statSync(path.join(dest, 'src', 'a')).mtimeMs).toBe(stamp.getTime());
    if (process.platform !== 'win32') expect(fs.readlinkSync(path.join(dest, 'src', 'tree', 'link'))).toBe('b');
  });
  it.each(['skip', 'overwrite', 'fail'])('handles conflict %s', async (conflict) => {
    fs.writeFileSync(path.join(dest, 'a'), 'old'); const job = await finish(await copy(conflict));
    expect(job.state).toBe(conflict === 'fail' ? 'failed' : 'done');
    expect(fs.statSync(path.join(dest, 'a')).size).toBe(conflict === 'overwrite' ? 1024 * 1024 : 3);
  });
  it('rejects self/descendant destinations and too many sources', async () => {
    expect(await queue.start('copy', { sources: [src], destDir: src, conflict: 'fail' })).toMatchObject({ reason: 'invalid' });
    expect(await queue.start('move', { sources: [path.join(src, 'a')], destDir: src, conflict: 'fail' })).toMatchObject({ reason: 'invalid' });
    expect(await queue.start('trash', { paths: Array(33).fill(src) })).toMatchObject({ reason: 'invalid' });
  });
  it('moves on the same device', async () => {
    expect((await finish(await queue.start('move', { sources: [path.join(src, 'a')], destDir: dest, conflict: 'fail' }))).state).toBe('done');
    expect(fs.existsSync(path.join(src, 'a'))).toBe(false);
  });
  it('keeps the EXDEV source until all copy chunks have completed', async () => {
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('cross device'), { code: 'EXDEV' }));
    const create = fs.createReadStream;
    let observed = false;
    vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = create(...args); stream.on('data', () => { observed = true; expect(fs.existsSync(path.join(src, 'a'))).toBe(true); }); return stream;
    });
    const job = await finish(await queue.start('move', { sources: [path.join(src, 'a')], destDir: dest, conflict: 'fail' }));
    expect(job.state).toBe('done'); expect(observed).toBe(true); expect(fs.existsSync(path.join(src, 'a'))).toBe(false);
  });
  it('cancels during streaming and removes partial output', async () => {
    const create = fs.createReadStream; let id = '';
    vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = create(...args); stream.once('data', () => queue.cancel(id)); return stream;
    });
    const result = await copy(); if (!result.ok) throw new Error(result.reason); id = result.jobId;
    const job = await finish(result); expect(job.state).toBe('cancelled'); expect(fs.readdirSync(dest)).toEqual([]);
  });
  it('locks overlapping paths while running', async () => {
    const release = holdCopies();
    const result = await copy();
    expect(await copy()).toMatchObject({ reason: 'busy' });
    release();
    expect((await finish(result)).state).toBe('done');
  });
  it('refuses credential sources and destinations, including absent names', async () => {
    expect(await queue.start('trash', { paths: [path.join(home, '.ssh')] })).toMatchObject({ reason: 'unavailable' });
    expect(await queue.mkdir({ path: path.join(home, '.aws') })).toMatchObject({ reason: 'unavailable' });
    expect(await queue.rename({ path: src, newName: '..' })).toMatchObject({ reason: 'invalid' });
    expect(await queue.start('copy', { sources: [src], destDir: path.join(home, '.ssh'), conflict: 'fail' })).toMatchObject({ reason: 'unavailable' });
    const result = await queue.start('trash', { paths: [home] }); expect((await finish(result)).state).toBe('failed'); expect(trash).not.toHaveBeenCalled();
  });
  it('applies the plugin refusal list: .env files, keys, wmux data', async () => {
    fs.writeFileSync(path.join(src, '.env'), 'TOKEN=1');
    // Renaming a refused file away from its name would make it readable.
    expect(await queue.rename({ path: path.join(src, '.env'), newName: 'env.txt' })).toMatchObject({ reason: 'unavailable' });
    expect(await queue.rename({ path: path.join(src, 'a'), newName: 'server.pem' })).toMatchObject({ reason: 'unavailable' });
    expect(await queue.mkdir({ path: path.join(home, '.wmux-dev') })).toMatchObject({ reason: 'unavailable' });
    // A folder holding a refused file is refused whole, before anything changes.
    const job = await finish(await queue.start('copy', { sources: [src], destDir: dest, conflict: 'fail' }));
    expect(job.state).toBe('failed');
    expect(fs.existsSync(path.join(dest, 'src'))).toBe(false);
  });
  it('trashes canonical paths through the injected OS operation', async () => {
    const job = await finish(await queue.start('trash', { paths: [path.join(src, '..', 'src', 'a')] }));
    expect(job.state).toBe('done'); expect(trash).toHaveBeenCalledWith(path.join(src, 'a'));
  });
  it('caps concurrent jobs at four even when their paths do not overlap', async () => {
    let release: () => void = () => { throw new Error('Gate not initialized'); };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    queue = new FsJobQueue(async () => gate);
    const results = [];
    for (let i = 0; i < 5; i++) {
      const file = path.join(root, `source-${i}`); fs.writeFileSync(file, 'x');
      results.push(await queue.start('trash', { paths: [file] }));
    }
    expect(results[4]).toMatchObject({ reason: 'busy' });
    release();
    for (const result of results.slice(0, 4)) expect((await finish(result)).state).toBe('done');
  });
  it('retains an existing destination when overwrite is cancelled', async () => {
    fs.writeFileSync(path.join(dest, 'a'), 'original');
    const create = fs.createReadStream; let id = '';
    vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = create(...args); stream.once('data', () => queue.cancel(id)); return stream;
    });
    const result = await copy('overwrite'); if (!result.ok) throw new Error(result.reason); id = result.jobId;
    expect((await finish(result)).state).toBe('cancelled');
    expect(fs.readFileSync(path.join(dest, 'a'), 'utf8')).toBe('original');
    expect(fs.readdirSync(dest)).toEqual(['a']);
  });
  it('keeps a move source when the conflict policy skips it', async () => {
    fs.writeFileSync(path.join(dest, 'a'), 'old');
    const job = await finish(await queue.start('move', { sources: [path.join(src, 'a')], destDir: dest, conflict: 'skip' }));
    expect(job.state).toBe('done'); expect(fs.existsSync(path.join(src, 'a'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'a'), 'utf8')).toBe('old');
  });
  it('refuses a new credential destination name and aliases of locked destinations', async () => {
    const safe = path.join(home, 'safe'); fs.mkdirSync(safe);
    expect(await queue.rename({ path: safe, newName: '.aws' })).toMatchObject({ reason: 'unavailable' });
    if (process.platform === 'win32') return;
    const alias = path.join(root, 'alias'); fs.symlinkSync(dest, alias);
    const release = holdCopies();
    const result = await queue.start('copy', { sources: [path.join(src, 'a')], destDir: alias, conflict: 'fail' });
    // A different source into the real destination: only the aliased destination lock can refuse it.
    const other = path.join(root, 'other-source'); fs.writeFileSync(other, 'x');
    expect(await queue.start('copy', { sources: [other], destDir: dest, conflict: 'fail' })).toMatchObject({ reason: 'busy' });
    release();
    expect((await finish(result)).state).toBe('done');
  });
  it('rejects an alias resolving to the source and overwrites safe links without following them', async () => {
    if (process.platform === 'win32') return;
    fs.symlinkSync(path.join(src, 'a'), path.join(dest, 'a'));
    expect(await copy('overwrite')).toMatchObject({ reason: 'invalid' });
    fs.unlinkSync(path.join(dest, 'a'));
    const other = path.join(root, 'other'); fs.writeFileSync(other, 'keep');
    fs.symlinkSync(other, path.join(dest, 'a'));
    expect((await finish(await copy('overwrite'))).state).toBe('done');
    expect(fs.lstatSync(path.join(dest, 'a')).isFile()).toBe(true);
    expect(fs.readFileSync(other, 'utf8')).toBe('keep');
  });
  // #3030: a copy recreates a link and a trash removes only the link, so where it points is not checked for those.
  it.runIf(process.platform !== 'win32')('copies and trashes a folder or link that points at the home folder', async () => {
    fs.symlinkSync(home, path.join(src, 'home-link'));
    const copied = await finish(await queue.start('copy', { sources: [src], destDir: dest, conflict: 'fail' }));
    expect(copied.errors).toEqual([]);
    expect(fs.readlinkSync(path.join(dest, 'src', 'home-link'))).toBe(home);
    expect((await finish(await queue.start('trash', { paths: [src] }))).state).toBe('done');
    expect((await finish(await queue.start('trash', { paths: [path.join(src, 'home-link')] }))).state).toBe('done');
    expect(trash.mock.calls).toEqual([[src], [path.join(src, 'home-link')]]);
  });
  // #3095: a move or rename takes only the link too.
  it.runIf(process.platform !== 'win32')('moves and renames a folder or link that points at the home folder', async () => {
    fs.symlinkSync(home, path.join(src, 'home-link'));
    expect(await queue.rename({ path: path.join(src, 'home-link'), newName: 'renamed-link' })).toMatchObject({ ok: true });
    expect((await finish(await queue.start('move', { sources: [path.join(src, 'renamed-link')], destDir: dest, conflict: 'fail' }))).state).toBe('done');
    expect(fs.readlinkSync(path.join(dest, 'renamed-link'))).toBe(home);
    fs.symlinkSync(home, path.join(src, 'home-link'));
    expect(await queue.rename({ path: src, newName: 'src2' })).toMatchObject({ ok: true });
    expect(fs.readlinkSync(path.join(root, 'src2', 'home-link'))).toBe(home);
    expect(fs.existsSync(path.join(home, '.ssh'))).toBe(true);
  });
  it.runIf(process.platform !== 'win32')('refuses moving or renaming a link a refused folder is reached through', async () => {
    fs.mkdirSync(path.join(home, 'dotfiles', 'config', 'gh'), { recursive: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'config'), path.join(src, 'cfg-link'));
    fs.symlinkSync(path.join(src, 'cfg-link'), path.join(home, '.config'));
    expect(await queue.rename({ path: path.join(src, 'cfg-link'), newName: 'other' })).toMatchObject({ reason: 'unavailable' });
    expect((await finish(await queue.start('move', { sources: [path.join(src, 'cfg-link')], destDir: dest, conflict: 'fail' }))).state).toBe('failed');
    expect(await queue.rename({ path: src, newName: 'src2' })).toMatchObject({ reason: 'unavailable' });
    expect(fs.readlinkSync(path.join(src, 'cfg-link'))).toBe(path.join(home, 'dotfiles', 'config'));
  });
  it('trashes and renames a config folder whose refused files do not exist', async () => {
    for (const dir of ['.config', '.claude']) fs.mkdirSync(path.join(home, dir, 'notes'), { recursive: true });
    expect((await finish(await queue.start('trash', { paths: [path.join(home, '.config')] }))).state).toBe('done');
    expect(await queue.rename({ path: path.join(home, '.claude'), newName: 'claude-old' })).toMatchObject({ ok: true });
    fs.mkdirSync(path.join(home, '.config', 'gh'));
    fs.writeFileSync(path.join(home, 'claude-old', '.credentials.json'), '{}');
    fs.renameSync(path.join(home, 'claude-old'), path.join(home, '.claude'));
    expect((await finish(await queue.start('trash', { paths: [path.join(home, '.config')] }))).state).toBe('failed');
    expect(await queue.rename({ path: path.join(home, '.claude'), newName: 'claude-old' })).toMatchObject({ reason: 'unavailable' });
    expect(trash.mock.calls).toEqual([[path.join(home, '.config')]]);
  });
  it.runIf(process.platform !== 'win32')('refuses trashing a link a refused folder is reached through', async () => {
    // ~/.config -> src/cfg-link -> ~/dotfiles/config, which holds gh: trashing the
    // middle link would leave ~/.config/gh unresolved and its folder unrefused.
    fs.mkdirSync(path.join(home, 'dotfiles', 'config', 'gh'), { recursive: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'config'), path.join(src, 'cfg-link'));
    fs.symlinkSync(path.join(src, 'cfg-link'), path.join(home, '.config'));
    expect((await finish(await queue.start('trash', { paths: [path.join(src, 'cfg-link')] }))).state).toBe('failed');
    expect((await finish(await queue.start('trash', { paths: [src] }))).state).toBe('failed');
    expect(trash).not.toHaveBeenCalled();
    // A copy leaves the link in place.
    const copied = await finish(await queue.start('copy', { sources: [src], destDir: dest, conflict: 'fail' }));
    expect(copied.errors).toEqual([]);
  });
  it.runIf(process.platform !== 'win32')('follows a link before the .. after it, as the kernel does', async () => {
    // ~/.config -> dotfiles/lnk/../config, and lnk -> elsewhere/sub: ~/.config is
    // elsewhere/config, not dotfiles/config (which exists, as a decoy).
    for (const dir of ['elsewhere/sub', 'elsewhere/config/gh', 'dotfiles/config/gh']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.symlinkSync(path.join(home, 'elsewhere', 'sub'), path.join(home, 'dotfiles', 'lnk'));
    fs.symlinkSync('dotfiles/lnk/../config', path.join(home, '.config')); // path.join would fold the ..
    expect(fs.realpathSync.native(path.join(home, '.config'))).toBe(path.join(home, 'elsewhere', 'config'));
    expect((await finish(await queue.start('trash', { paths: [path.join(home, 'dotfiles', 'lnk')] }))).state).toBe('failed');
    expect(trash).not.toHaveBeenCalled();
  });
  it('checks again just before a trash: a refused folder can appear after the preflight', async () => {
    const config = path.join(home, '.config'); const later = path.join(root, 'later');
    fs.mkdirSync(config); fs.mkdirSync(later);
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike) => {
      if (dir === later) fs.mkdirSync(path.join(config, 'gh'), { recursive: true });
      return readdir(dir);
    }) as typeof fs.promises.readdir);
    const job = await finish(await queue.start('trash', { paths: [config, later] }));
    expect(job.errors).toEqual([{ path: config, reason: 'unavailable' }]);
    expect(trash.mock.calls).toEqual([[later]]);
  });
  it('counts a refused folder it cannot look up as there', async () => {
    fs.mkdirSync(path.join(home, '.config'));
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === path.join(home, '.config', 'gh')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return (lstat as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.lstat);
    expect(await queue.rename({ path: path.join(home, '.config'), newName: 'config-old' })).toMatchObject({ reason: 'unavailable' });
  });
  it.runIf(process.platform !== 'win32')('checks with fresh links just before a trash: a refused folder that appears makes a link part of its chain', async () => {
    // ~/.config -> dotfiles/cfg -> dotfiles/config, gh not there yet: the kept
    // copy of the roots' links has no cfg until it expires.
    fs.mkdirSync(path.join(home, 'dotfiles', 'config'), { recursive: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'config'), path.join(home, 'dotfiles', 'cfg'));
    fs.symlinkSync(path.join(home, 'dotfiles', 'cfg'), path.join(home, '.config'));
    const warm = path.join(root, 'warm'); fs.mkdirSync(warm);
    expect((await finish(await queue.start('trash', { paths: [warm] }))).state).toBe('done');
    fs.mkdirSync(path.join(home, 'dotfiles', 'config', 'gh'));
    expect((await finish(await queue.start('trash', { paths: [path.join(home, 'dotfiles', 'cfg')] }))).state).toBe('failed');
    expect(trash.mock.calls).toEqual([[warm]]);
  });
  it.runIf(process.platform !== 'win32')('copies the file it checked, not a link put in its place', async () => {
    const secret = path.join(home, '.ssh', 'id_test'); fs.writeFileSync(secret, 'SECRET');
    const file = path.join(src, 'a');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === file) { fs.unlinkSync(file); fs.symlinkSync(secret, file); }
      return (open as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.open);
    const job = await finish(await queue.start('copy', { sources: [file], destDir: dest, conflict: 'fail' }));
    expect(job.state).toBe('failed');
    expect(fs.existsSync(path.join(dest, 'a')) ? fs.readFileSync(path.join(dest, 'a'), 'utf8') : '').not.toContain('SECRET');
  });
  it('copies the file it checked, not another file renamed over it', async () => {
    const file = path.join(src, 'a'); const other = path.join(root, 'other'); fs.writeFileSync(other, 'OTHER');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === file) fs.renameSync(other, file);
      return (open as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.open);
    expect((await finish(await queue.start('copy', { sources: [file], destDir: dest, conflict: 'fail' }))).state).toBe('failed');
    expect(fs.existsSync(path.join(dest, 'a'))).toBe(false);
  });
  it.runIf(process.platform !== 'win32')('reads the file it opened, not a link put at its path after', async () => {
    const secret = path.join(home, '.ssh', 'id_test'); fs.writeFileSync(secret, 'SECRET');
    const file = path.join(src, 'a');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      const handle = await (open as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest);
      if (String(p) === file) { fs.unlinkSync(file); fs.symlinkSync(secret, file); }
      return handle;
    }) as typeof fs.promises.open);
    await finish(await queue.start('copy', { sources: [file], destDir: dest, conflict: 'fail' }));
    expect(fs.readFileSync(path.join(dest, 'a'), 'utf8')).not.toContain('SECRET');
  });
  it.runIf(process.platform !== 'win32')('refuses trashing a folder that holds a link a refused folder is reached through, with fresh links', async () => {
    fs.mkdirSync(path.join(home, 'dotfiles', 'config'), { recursive: true }); fs.mkdirSync(path.join(home, 'links'));
    fs.symlinkSync(path.join(home, 'dotfiles', 'config'), path.join(home, 'links', 'cfg'));
    fs.symlinkSync(path.join(home, 'links', 'cfg'), path.join(home, '.config'));
    const warm = path.join(root, 'warm'); fs.mkdirSync(warm);
    expect((await finish(await queue.start('trash', { paths: [warm] }))).state).toBe('done');
    fs.mkdirSync(path.join(home, 'dotfiles', 'config', 'gh'));
    expect((await finish(await queue.start('trash', { paths: [path.join(home, 'links')] }))).state).toBe('failed');
    expect(trash.mock.calls).toEqual([[warm]]);
  });
  it.runIf(process.platform === 'darwin')('matches a link spelled decomposed (NFD) against its composed name', async () => {
    const composed = 'cf\u00e9'; const decomposed = composed.normalize('NFD');
    fs.mkdirSync(path.join(home, 'dotfiles', 'config', 'gh'), { recursive: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'config'), path.join(src, composed));
    fs.symlinkSync(path.join(src, composed), path.join(home, '.config'));
    expect((await finish(await queue.start('trash', { paths: [path.join(src, decomposed)] }))).state).toBe('failed');
    expect(trash).not.toHaveBeenCalled();
  });
  it('expires completed jobs after ten minutes', async () => {
    let now = 0; queue = new FsJobQueue(trash, () => now);
    const job = await finish(await copy()); now = 600_000; expect(queue.status(job.id)).toMatchObject({ reason: 'unavailable' });
  });
});
