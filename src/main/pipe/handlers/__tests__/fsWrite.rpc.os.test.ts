import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fswrite-')));
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
    const result = await copy(); expect(await copy()).toMatchObject({ reason: 'busy' }); await finish(result);
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
    const result = await queue.start('copy', { sources: [path.join(src, 'a')], destDir: alias, conflict: 'fail' });
    expect(await copy()).toMatchObject({ reason: 'busy' }); await finish(result);
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
  it('expires completed jobs after ten minutes', async () => {
    let now = 0; queue = new FsJobQueue(trash, () => now);
    const job = await finish(await copy()); now = 600_000; expect(queue.status(job.id)).toMatchObject({ reason: 'unavailable' });
  });
});
