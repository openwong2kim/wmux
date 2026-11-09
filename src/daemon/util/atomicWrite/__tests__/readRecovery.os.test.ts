/**
 * A busy file is waited for. Past the retries a read falls back to `.bak`, and
 * the next write keeps the primary it could not read, so that rollback can be
 * undone. A backup is replaced only by a primary that passed validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { countErrorWarn } from '../../../../cli/commands/doctor';
import { reHardenTokenFileAcl, verifyOwnerOnlyDaclSync } from '../../../../shared/security';
import {
  atomicReadJSON,
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
  commitRenameSync,
} from '../core';
import { atomicReadText, atomicReadTextSync, atomicWriteText, atomicWriteTextSync } from '../text';

vi.mock('../../../../shared/security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/security')>();
  return { ...actual, reHardenTokenFileAcl: vi.fn(actual.reHardenTokenFileAcl) };
});

let tmpDir: string;
let targetPath: string;
let logged: string[];

const noSleep = { delaysMs: [1, 1, 1], sleepSync: () => undefined, sleep: () => Promise.resolve() };

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Fail reads of `file`; `times` of them, or every one. Sync and async both. */
function failReads(file: string, code: string, times = Infinity) {
  const realSync = fs.readFileSync.bind(fs) as (...a: unknown[]) => unknown;
  const realAsync = fsp.readFile.bind(fsp) as (...a: unknown[]) => Promise<unknown>;
  let left = times;
  const hit = (p: unknown) => p === file && left-- > 0;
  const sync = vi.spyOn(fs, 'readFileSync').mockImplementation(((...a: unknown[]) => {
    if (hit(a[0])) throw errno(code);
    return realSync(...a);
  }) as typeof fs.readFileSync);
  const async_ = vi.spyOn(fsp, 'readFile').mockImplementation((async (...a: unknown[]) => {
    if (hit(a[0])) throw errno(code);
    return realAsync(...a);
  }) as typeof fsp.readFile);
  return {
    calls: () => [...sync.mock.calls, ...async_.mock.calls].filter((c) => c[0] === file).length,
    restore: () => { sync.mockRestore(); async_.mockRestore(); },
  };
}

/** Fail renames that start at `from`. Sync and async both. */
function failRenames(from: string, code: string) {
  const realSync = fs.renameSync.bind(fs);
  const realAsync = fsp.rename.bind(fsp);
  const sync = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
    if (a === from) throw errno(code);
    realSync(a, b);
  });
  const async_ = vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
    if (a === from) throw errno(code);
    await realAsync(a, b);
  });
  return { restore: () => { sync.mockRestore(); async_.mockRestore(); } };
}

function asPlatform(value: string): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', { value: original, configurable: true });
}

const json = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf-8'));
const text = (file: string): string => fs.readFileSync(file, 'utf-8');
const corruptedDir = () => path.join(tmpDir, 'corrupted');
const kept = (): string[] => (fs.existsSync(corruptedDir()) ? fs.readdirSync(corruptedDir()) : []);
const keptText = (): string => text(path.join(corruptedDir(), kept()[0]));
const beside = (): string[] => fs.readdirSync(tmpDir).filter((n) => n.includes('.kept-'));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-read-recovery-'));
  targetPath = path.join(tmpDir, 'state.json');
  logged = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.each([
  ['async', (o?: object) => atomicReadJSON(targetPath, o), (d: unknown, o?: object) => atomicWriteJSON(targetPath, d, o)],
  ['sync', async (o?: object) => atomicReadJSONSync(targetPath, o), async (d: unknown, o?: object) => atomicWriteJSONSync(targetPath, d, o)],
] as const)('a busy primary (%s)', (_name, read, write) => {
  beforeEach(async () => {
    await write({ gen: 'old' });
    await write({ gen: 'new' });
  });

  it('is retried on win32, and the wait costs no state', async () => {
    const restore = asPlatform('win32');
    const reads = failReads(targetPath, 'EBUSY', 2);
    await expect(read({ readRetry: noSleep })).resolves.toEqual({ gen: 'new' });
    expect(reads.calls()).toBe(3);
    reads.restore();
    restore();
    expect(logged).toEqual([]);
  });

  it('past the retries falls back to the backup, logged where wmux doctor counts it', async () => {
    const restore = asPlatform('win32');
    const reads = failReads(targetPath, 'EPERM');
    await expect(read({ readRetry: noSleep })).resolves.toEqual({ gen: 'old' });
    expect(reads.calls()).toBe(4);
    await expect(read({ readRetry: noSleep })).resolves.toEqual({ gen: 'old' });
    reads.restore();
    restore();
    const logText = logged.join('');
    expect(logText).toContain(`could not read "${targetPath}" (EPERM)`);
    expect(logText).toContain(`"${targetPath}" is unreadable; using the older state in state.json.bak`);
    // Once for each, however many times it is read.
    expect(countErrorWarn(logText)).toEqual({ errors: 2, warns: 0 });
  });

  it('a second episode after a successful write is logged too', async () => {
    const first = failReads(targetPath, 'EBUSY');
    await expect(read({ readRetry: noSleep })).resolves.toEqual({ gen: 'old' });
    first.restore();
    await write({ gen: 'written' });
    const errorsAfterFirst = countErrorWarn(logged.join('')).errors;
    expect(errorsAfterFirst).toBe(2);

    const second = failReads(targetPath, 'EBUSY');
    await read({ readRetry: noSleep });
    second.restore();
    expect(countErrorWarn(logged.join('')).errors).toBe(errorsAfterFirst + 2);
  });

  it('is not retried off win32', async () => {
    const restore = asPlatform('linux');
    const reads = failReads(targetPath, 'EACCES');
    await expect(read({ readRetry: noSleep })).resolves.toEqual({ gen: 'old' });
    expect(reads.calls()).toBe(1);
    reads.restore();
    restore();
  });

  it('with no backup reads as null, and the next write still keeps it', async () => {
    fs.rmSync(`${targetPath}.bak`);
    const reads = failReads(targetPath, 'EBUSY');
    await expect(read({ readRetry: noSleep })).resolves.toBeNull();
    reads.restore();
    await write({ gen: 'empty' });
    expect(JSON.parse(keptText())).toEqual({ gen: 'new' });
  });

  it('the next write keeps it aside and never over the backup', async () => {
    const reads = failReads(targetPath, 'EBUSY');
    await read({ readRetry: noSleep });
    reads.restore();

    await write({ gen: 'from-older' }, { rotationEnabled: true });

    expect(json(targetPath)).toEqual({ gen: 'from-older' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(fs.existsSync(`${targetPath}.bak.1`)).toBe(false);
    expect(kept()).toHaveLength(1);
    expect(JSON.parse(keptText())).toEqual({ gen: 'new' });
  });

  it('only that write keeps it: the one after rotates as usual', async () => {
    const reads = failReads(targetPath, 'EBUSY');
    await read({ readRetry: noSleep });
    reads.restore();
    await write({ gen: 'second' });
    await write({ gen: 'third' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'second' });
    expect(kept()).toHaveLength(1);
  });

  it('a later good read works, and does not excuse the next write', async () => {
    const reads = failReads(targetPath, 'EBUSY');
    await expect(read({ readRetry: noSleep })).resolves.toEqual({ gen: 'old' });
    reads.restore();

    await expect(read()).resolves.toEqual({ gen: 'new' });

    await write({ gen: 'next' });
    expect(JSON.parse(keptText())).toEqual({ gen: 'new' });
  });

  it('still unreadable at that write: renamed aside, and the write lands', async () => {
    const reads = failReads(targetPath, 'EACCES');
    await read({ readRetry: noSleep });
    await write({ gen: 'next' }, { renameRetry: noSleep });
    reads.restore();
    expect(json(targetPath)).toEqual({ gen: 'next' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(JSON.parse(keptText())).toEqual({ gen: 'new' });
  });

  it('neither readable nor movable at that write: the write stops, and the next one gets through', async () => {
    const reads = failReads(targetPath, 'EBUSY');
    await read({ readRetry: noSleep });
    const renames = failRenames(targetPath, 'EBUSY');
    await expect(write({ gen: 'next' }, { renameRetry: noSleep })).rejects.toMatchObject({ code: 'EBUSY' });
    renames.restore();
    reads.restore();
    expect(json(targetPath)).toEqual({ gen: 'new' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(fs.readdirSync(tmpDir).filter((n) => n.includes('.tmp.'))).toEqual([]);

    await write({ gen: 'next' });
    expect(json(targetPath)).toEqual({ gen: 'next' });
    expect(JSON.parse(keptText())).toEqual({ gen: 'new' });
  });

  it('a busy backup is stepped past to an older one, as before', async () => {
    fs.writeFileSync(`${targetPath}.bak.1`, JSON.stringify({ gen: 'oldest' }));
    fs.writeFileSync(targetPath, '{torn');
    const reads = failReads(`${targetPath}.bak`, 'EBUSY');
    await expect(read({ readRetry: noSleep })).resolves.toEqual({ gen: 'oldest' });
    reads.restore();
  });
});

describe('a file that is not there', () => {
  it('is waited on by no slot, even on win32', async () => {
    const restore = asPlatform('win32');
    const sleepSync = vi.fn();
    const sleep = vi.fn(() => Promise.resolve());
    expect(atomicReadJSONSync(targetPath, { readRetry: { ...noSleep, sleepSync } })).toBeNull();
    await expect(atomicReadJSON(targetPath, { readRetry: { ...noSleep, sleep } })).resolves.toBeNull();
    restore();
    expect(sleepSync).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it('is not what a real read failure reads as: a directory at the path falls back and logs', () => {
    const dirTarget = path.join(tmpDir, 'dir.json');
    fs.mkdirSync(dirTarget);
    fs.writeFileSync(`${dirTarget}.bak`, JSON.stringify({ gen: 'old' }));
    expect(atomicReadJSONSync(dirTarget)).toEqual({ gen: 'old' });
    expect(countErrorWarn(logged.join('')).errors).toBe(2);
  });
});

describe('a fallback for another reason', () => {
  beforeEach(() => {
    atomicWriteJSONSync(targetPath, { gen: 'old' });
    atomicWriteJSONSync(targetPath, { gen: 'new' });
  });

  it('a corrupt primary reads the backup, logged once as an error', () => {
    fs.writeFileSync(targetPath, '{torn');
    expect(atomicReadJSONSync(targetPath)).toEqual({ gen: 'old' });
    expect(atomicReadJSONSync(targetPath)).toEqual({ gen: 'old' });
    const logText = logged.join('');
    expect(countErrorWarn(logText)).toEqual({ errors: 1, warns: 0 });
    expect(logText).toContain(`"${targetPath}" is corrupt; using the older state in state.json.bak`);
  });

  it('a missing primary reads the backup, logged as a warning', () => {
    fs.unlinkSync(targetPath);
    expect(atomicReadJSONSync(targetPath)).toEqual({ gen: 'old' });
    expect(countErrorWarn(logged.join(''))).toEqual({ errors: 0, warns: 1 });
  });

  it('is reported again after the file has read in between', () => {
    fs.writeFileSync(targetPath, '{torn');
    atomicReadJSONSync(targetPath);
    atomicWriteJSONSync(targetPath, { gen: 'fixed' });
    expect(atomicReadJSONSync(targetPath)).toEqual({ gen: 'fixed' });
    fs.writeFileSync(targetPath, '{torn');
    atomicReadJSONSync(targetPath);
    expect(countErrorWarn(logged.join('')).errors).toBe(2);
  });
});

describe.each([
  ['async', (d: unknown, o?: object) => atomicWriteJSON(targetPath, d, o)],
  ['sync', async (d: unknown, o?: object) => atomicWriteJSONSync(targetPath, d, o)],
] as const)('the backup is replaced only by a valid primary (%s)', (_name, write) => {
  beforeEach(async () => {
    await write({ gen: 'old' });
    await write({ gen: 'good' });
  });

  it('a good primary becomes the backup', async () => {
    await write({ gen: 'next' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'good' });
    expect(kept()).toEqual([]);
  });

  it.each([
    ['unparseable', '{torn'],
    ['all zero bytes', '\0'.repeat(64)],
  ])('an %s primary is copied aside and the backup stays', async (_kind, bytes) => {
    fs.writeFileSync(targetPath, bytes);
    await write({ gen: 'next' });
    expect(json(targetPath)).toEqual({ gen: 'next' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(keptText()).toBe(bytes);
  });

  it('it is copied, not moved: a write that then fails leaves it in place', async () => {
    fs.writeFileSync(targetPath, '{torn');
    const realSync = fs.renameSync.bind(fs);
    const realAsync = fsp.rename.bind(fsp);
    const intoTarget = (b: fs.PathLike) => b === targetPath;
    const sync = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (intoTarget(b)) throw errno('ENOSPC');
      realSync(a, b);
    });
    const async_ = vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (intoTarget(b)) throw errno('ENOSPC');
      await realAsync(a, b);
    });
    await expect(write({ gen: 'next' })).rejects.toMatchObject({ code: 'ENOSPC' });
    sync.mockRestore();
    async_.mockRestore();
    expect(text(targetPath)).toBe('{torn');
    expect(keptText()).toBe('{torn');
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
  });

  it('a copy that cannot be made moves the primary beside itself, and the save goes through', async () => {
    fs.writeFileSync(targetPath, '{torn');
    fs.writeFileSync(corruptedDir(), 'not a folder');
    await write({ gen: 'next' });
    expect(json(targetPath)).toEqual({ gen: 'next' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(beside()).toHaveLength(1);
    expect(text(path.join(tmpDir, beside()[0]))).toBe('{torn');
  });

  it('only the newest two stay beside it', async () => {
    fs.writeFileSync(corruptedDir(), 'not a folder');
    let now = 1_000;
    const clock = () => now++;
    for (const n of [1, 2, 3, 4]) {
      fs.writeFileSync(targetPath, `{torn ${n}`);
      await write({ gen: n }, { clock });
    }
    expect(beside().map((n) => text(path.join(tmpDir, n))).sort()).toEqual(['{torn 3', '{torn 4']);
  });

  it('neither copied nor movable: the write stops and nothing is lost', async () => {
    fs.writeFileSync(targetPath, '{torn');
    fs.writeFileSync(corruptedDir(), 'not a folder');
    const renames = failRenames(targetPath, 'EBUSY');
    await expect(write({ gen: 'next' })).rejects.toMatchObject({ code: 'EBUSY' });
    renames.restore();
    expect(text(targetPath)).toBe('{torn');
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
  });

  it('a primary moved beside itself comes back when the commit fails', async () => {
    fs.writeFileSync(targetPath, '{torn');
    fs.writeFileSync(corruptedDir(), 'not a folder');
    const realSync = fs.renameSync.bind(fs);
    const realAsync = fsp.rename.bind(fsp);
    const isCommit = (a: fs.PathLike, b: fs.PathLike) => b === targetPath && String(a).includes('.tmp.');
    const sync = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (isCommit(a, b)) throw errno('ENOSPC');
      realSync(a, b);
    });
    const async_ = vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (isCommit(a, b)) throw errno('ENOSPC');
      await realAsync(a, b);
    });
    await expect(write({ gen: 'next' })).rejects.toMatchObject({ code: 'ENOSPC' });
    sync.mockRestore();
    async_.mockRestore();
    expect(text(targetPath)).toBe('{torn');
    expect(beside()).toEqual([]);
  });

  it('a commit that keeps failing does not copy the same primary again', async () => {
    fs.writeFileSync(targetPath, '{torn');
    const realSync = fs.renameSync.bind(fs);
    const realAsync = fsp.rename.bind(fsp);
    const sync = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (b === targetPath) throw errno('ENOSPC');
      realSync(a, b);
    });
    const async_ = vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (b === targetPath) throw errno('ENOSPC');
      await realAsync(a, b);
    });
    let now = 1_700_000_000_000;
    const clock = () => now++;
    for (let i = 0; i < 3; i++) await expect(write({ gen: 'next' }, { clock })).rejects.toMatchObject({ code: 'ENOSPC' });
    sync.mockRestore();
    async_.mockRestore();
    expect(kept()).toHaveLength(1);
  });

  it('a primary unwritten for longer than the retention is not deleted as soon as it is kept', async () => {
    fs.writeFileSync(targetPath, '{torn');
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(targetPath, longAgo, longAgo);
    await write({ gen: 'next' });
    expect(keptText()).toBe('{torn');
    expect(fs.statSync(path.join(corruptedDir(), kept()[0])).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it('the same for one moved aside because it could not be read', async () => {
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(targetPath, longAgo, longAgo);
    const reads = failReads(targetPath, 'EACCES');
    await write({ gen: 'next' }, { renameRetry: noSleep });
    reads.restore();
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.parse(keptText())).toEqual({ gen: 'good' });
  });

  it('with rotation on, the chain does not shift for it either', async () => {
    fs.writeFileSync(targetPath, '{torn');
    await write({ gen: 'next' }, { rotationEnabled: true });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(fs.existsSync(`${targetPath}.bak.1`)).toBe(false);
  });

  it('a primary that parses but fails validate, with no prior read, is copied aside and the backup stays', async () => {
    const bytes = JSON.stringify({ version: 3, from: 'a newer build' });
    fs.writeFileSync(targetPath, bytes);

    await write({ version: 2 }, { validate: (d: unknown) => (d as { version?: unknown }).version === 2 });

    expect(json(targetPath)).toEqual({ version: 2 });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(keptText()).toBe(bytes);
    expect(fs.existsSync(`${targetPath}.bak.1`)).toBe(false);
  });

  it('an older-schema primary costs one copy after a read migrates it, and nothing is lost', async () => {
    const bytes = JSON.stringify({ version: 1, name: 'older' });
    fs.writeFileSync(targetPath, bytes);
    const migrated = atomicReadJSONSync<{ version: number }>(targetPath, {
      migrator: (d) => ({ data: { ...(d as object), version: 2 } as { version: number }, version: 2 }),
      validate: (d): d is { version: number } => (d as { version?: unknown }).version === 2,
    });
    expect(migrated).toEqual({ version: 2, name: 'older' });

    await write(migrated, { validate: (d: unknown) => (d as { version?: unknown }).version === 2 });

    expect(json(targetPath)).toEqual({ version: 2, name: 'older' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(keptText()).toBe(bytes);
  });

  it('a refused primary that cannot be copied moves beside itself too', async () => {
    const bytes = JSON.stringify({ version: 3 });
    fs.writeFileSync(targetPath, bytes);
    const sync = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw errno('EIO'); });
    await write({ version: 2 }, { validate: (d: unknown) => (d as { version?: unknown }).version === 2 });
    sync.mockRestore();
    expect(json(targetPath)).toEqual({ version: 2 });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(text(path.join(tmpDir, beside()[0]))).toBe(bytes);
  });

  it('an empty primary is replaced with nothing kept and the backup stays', async () => {
    fs.writeFileSync(targetPath, '');
    await write({ gen: 'next' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(kept()).toEqual([]);
  });
});

describe('the primary this process last wrote', () => {
  it('is not read again by the next write', async () => {
    atomicWriteJSONSync(targetPath, { gen: 1 });
    await atomicWriteJSON(targetPath, { gen: 2 });
    const reads = failReads(targetPath, 'EBUSY');
    atomicWriteJSONSync(targetPath, { gen: 3 });
    await atomicWriteJSON(targetPath, { gen: 4 });
    expect(reads.calls()).toBe(0);
    reads.restore();
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 3 });
  });

  it('is judged after all once something else has changed it', () => {
    atomicWriteJSONSync(targetPath, { gen: 1 });
    atomicWriteJSONSync(targetPath, { gen: 2 });
    fs.writeFileSync(targetPath, '{torn');
    atomicWriteJSONSync(targetPath, { gen: 3 });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 1 });
    expect(keptText()).toBe('{torn');
  });

  it('is still kept aside after a failed read', () => {
    atomicWriteJSONSync(targetPath, { gen: 1 });
    atomicWriteJSONSync(targetPath, { gen: 2 });
    const reads = failReads(targetPath, 'EBUSY');
    atomicReadJSONSync(targetPath, { readRetry: noSleep });
    reads.restore();
    atomicWriteJSONSync(targetPath, { gen: 3 });
    expect(JSON.parse(keptText())).toEqual({ gen: 2 });
  });
});

describe.each([
  ['async', (o?: object) => atomicReadText(targetPath, o), (t: string, o?: object) => atomicWriteText(targetPath, t, o)],
  ['sync', async (o?: object) => atomicReadTextSync(targetPath, o), async (t: string, o?: object) => atomicWriteTextSync(targetPath, t, o)],
] as const)('text files (%s)', (_name, read, write) => {
  beforeEach(async () => {
    await write('old');
    await write('good');
  });

  it('a read failing past the retries falls back, and the next write keeps the primary', async () => {
    const restore = asPlatform('win32');
    const reads = failReads(targetPath, 'EPERM');
    await expect(read({ readRetry: noSleep })).resolves.toMatchObject({ content: 'old' });
    expect(reads.calls()).toBe(4);
    reads.restore();
    restore();
    expect(countErrorWarn(logged.join('')).errors).toBe(2);

    await write('next', { rotationEnabled: true });
    expect(text(targetPath)).toBe('next');
    expect(text(`${targetPath}.bak`)).toBe('old');
    expect(keptText()).toBe('good');
  });

  it('a primary of zero bytes is copied aside and does not replace the backup', async () => {
    fs.writeFileSync(targetPath, '\0'.repeat(32));
    await write('next');
    expect(text(`${targetPath}.bak`)).toBe('old');
    expect(keptText()).toBe('\0'.repeat(32));
  });

  it('a primary the write validator refuses is copied aside and the backup stays', async () => {
    fs.writeFileSync(targetPath, 'written elsewhere');
    await write('next', { validate: (t: string) => t !== 'written elsewhere' });
    expect(text(targetPath)).toBe('next');
    expect(text(`${targetPath}.bak`)).toBe('old');
    expect(keptText()).toBe('written elsewhere');
  });

  it('logs a fallback where wmux doctor counts it', async () => {
    fs.unlinkSync(targetPath);
    await expect(read()).resolves.toMatchObject({ content: 'old' });
    expect(countErrorWarn(logged.join('')).warns).toBe(1);
  });
});

describe('access to a kept copy', () => {
  beforeEach(() => {
    atomicWriteJSONSync(targetPath, { gen: 'old' });
    atomicWriteJSONSync(targetPath, { gen: 'good' });
    fs.writeFileSync(targetPath, '{torn');
  });

  it.skipIf(process.platform === 'win32')('a copy and a file moved beside itself keep the owner-only mode', () => {
    fs.chmodSync(targetPath, 0o600);
    atomicWriteJSONSync(targetPath, { gen: 'next' });
    expect(fs.statSync(path.join(corruptedDir(), kept()[0])).mode & 0o777).toBe(0o600);

    fs.rmSync(corruptedDir(), { recursive: true });
    fs.writeFileSync(corruptedDir(), 'not a folder');
    fs.writeFileSync(targetPath, '{torn again');
    fs.chmodSync(targetPath, 0o600);
    atomicWriteJSONSync(targetPath, { gen: 'after' });
    expect(fs.statSync(path.join(tmpDir, beside()[0])).mode & 0o777).toBe(0o600);
  });

  it('on win32 a copy is restricted to its owner', () => {
    const restore = asPlatform('win32');
    const harden = vi.mocked(reHardenTokenFileAcl);
    harden.mockClear();
    harden.mockImplementationOnce(() => 'hardened');
    atomicWriteJSONSync(targetPath, { gen: 'next' });
    restore();
    expect(harden).toHaveBeenCalledTimes(1);
    expect(harden).toHaveBeenCalledWith(path.join(corruptedDir(), kept()[0]));
  });

  it('on win32 a copy that cannot be restricted is removed, and the primary moves beside itself', () => {
    const restore = asPlatform('win32');
    vi.mocked(reHardenTokenFileAcl).mockImplementationOnce(() => 'failed');
    atomicWriteJSONSync(targetPath, { gen: 'next' });
    restore();
    expect(kept()).toEqual([]);
    expect(text(path.join(tmpDir, beside()[0]))).toBe('{torn');
    expect(json(targetPath)).toEqual({ gen: 'next' });
  });

  it.runIf(process.platform === 'win32')('on a real win32 file system the copy reads back as owner-only', () => {
    const harden = vi.mocked(reHardenTokenFileAcl);
    harden.mockClear();
    atomicWriteJSONSync(targetPath, { gen: 'next' });
    const copy = path.join(corruptedDir(), kept()[0]);
    const run = (file: string, args: string[], cwd?: string): string => {
      try {
        return execFileSync(file, args, { cwd, windowsHide: true }).toString('utf8');
      } catch (err) {
        return `failed: ${String(err)}`;
      }
    };
    const system32 = `${process.env.SystemRoot || 'C:\\Windows'}\\System32`;
    const saved = path.join(tmpDir, 'sddl.txt');
    run(`${system32}\\icacls.exe`, [path.basename(copy), '/save', saved], path.dirname(copy));
    const diagnostics = [
      `hardening returned: ${JSON.stringify(harden.mock.results)}`,
      `whoami /user: ${run(`${system32}\\whoami.exe`, ['/user', '/fo', 'list'])}`,
      `icacls /save: ${fs.existsSync(saved) ? fs.readFileSync(saved, 'utf16le') : 'none'}`,
    ].join('\n');
    expect(verifyOwnerOnlyDaclSync(copy, null), diagnostics).toBe(true);
  });
});

// Last in the file: these spend the module's sliding budgets.
describe('the sync retry allowances', () => {
  const heldRead = (delaysMs: number[]) => ({ delaysMs, sleepSync: () => undefined, sleep: () => Promise.resolve() });

  beforeEach(() => {
    atomicWriteJSONSync(targetPath, { gen: 'old' });
    atomicWriteJSONSync(targetPath, { gen: 'new' });
  });

  it('a read still gets its retries when writes have spent theirs', () => {
    const restore = asPlatform('win32');
    const renames = failRenames('/no/such/tmp', 'EBUSY');
    for (let i = 0; i < 3; i++) {
      expect(() => commitRenameSync('/no/such/tmp', '/no/such/target', heldRead([400, 100]))).toThrow();
    }
    renames.restore();

    const reads = failReads(targetPath, 'EBUSY', 2);
    expect(atomicReadJSONSync(targetPath, { readRetry: noSleep })).toEqual({ gen: 'new' });
    expect(reads.calls()).toBe(3);
    reads.restore();
    restore();
  });

  it('once the read allowance is spent a read falls back without waiting', () => {
    const restore = asPlatform('win32');
    const reads = failReads(targetPath, 'EBUSY');
    for (let i = 0; i < 4; i++) atomicReadJSONSync(targetPath, { readRetry: heldRead([500]) });
    const before = reads.calls();
    expect(atomicReadJSONSync(targetPath, { readRetry: heldRead([500]) })).toEqual({ gen: 'old' });
    expect(reads.calls()).toBe(before + 1);
    reads.restore();
    restore();
  });
});
