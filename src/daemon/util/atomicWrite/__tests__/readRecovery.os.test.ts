/**
 * A failed read is not data. Reads tell "could not read" apart from "missing"
 * and "corrupt", never answer it with an older slot, and a later save cannot
 * write what a caller took for empty over the good file. A backup is replaced
 * only by a primary that passed validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { countErrorWarn } from '../../../../cli/commands/doctor';
import {
  atomicReadJSON,
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
  CouldNotReadError,
} from '../core';
import { atomicReadText, atomicReadTextSync, atomicWriteText, atomicWriteTextSync } from '../text';

let tmpDir: string;
let targetPath: string;
let logged: string[];

const noSleep = { delaysMs: [1, 1, 1], sleepSync: () => undefined, sleep: () => Promise.resolve() };

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: read failed`) as NodeJS.ErrnoException;
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

function asPlatform(value: string): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', { value: original, configurable: true });
}

function json(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

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
  ['async', (o?: object) => atomicReadJSON(targetPath, o), (d: unknown) => atomicWriteJSON(targetPath, d)],
  ['sync', async (o?: object) => atomicReadJSONSync(targetPath, o), async (d: unknown) => atomicWriteJSONSync(targetPath, d)],
] as const)('reading a held file (%s)', (_name, read, write) => {
  beforeEach(async () => {
    await write({ gen: 'old' });
    await write({ gen: 'new' });
  });

  it('retries a win32 sharing failure, then gets the file', async () => {
    const restore = asPlatform('win32');
    const reads = failReads(targetPath, 'EBUSY', 2);
    await expect(read({ readRetry: noSleep })).resolves.toEqual({ gen: 'new' });
    expect(reads.calls()).toBe(3);
    reads.restore();
    restore();
  });

  it('reports "could not read" instead of the older backup, and nothing is lost', async () => {
    const restore = asPlatform('win32');
    const reads = failReads(targetPath, 'EPERM');
    const err = await read({ readRetry: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CouldNotReadError);
    expect(err).toMatchObject({ path: targetPath, fileCode: 'EPERM', code: 'ECOULDNOTREAD' });
    expect(reads.calls()).toBe(4);
    reads.restore();
    restore();
    expect(json(targetPath)).toEqual({ gen: 'new' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
  });

  it('refuses the next save until a read gets through, as a store that caught the error would save', async () => {
    const reads = failReads(targetPath, 'EBUSY');
    await expect(read({ readRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    reads.restore();

    await expect(write({ gen: 'empty' })).rejects.toBeInstanceOf(CouldNotReadError);
    expect(json(targetPath)).toEqual({ gen: 'new' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });

    await expect(read()).resolves.toEqual({ gen: 'new' });
    await write({ gen: 'newer' });
    expect(json(targetPath)).toEqual({ gen: 'newer' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'new' });
  });

  it('logs the failure where wmux doctor counts it, once', async () => {
    const reads = failReads(targetPath, 'EBUSY');
    await expect(read({ readRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    await expect(read({ readRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    reads.restore();
    expect(countErrorWarn(logged.join('')).errors).toBe(1);
    await read();
  });

  it('a read-only read neither holds writes nor releases them', async () => {
    const first = failReads(targetPath, 'EBUSY');
    await expect(read({ readOnly: true, readRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    first.restore();
    await write({ gen: 'saved' });
    expect(json(targetPath)).toEqual({ gen: 'saved' });

    const second = failReads(targetPath, 'EBUSY');
    await expect(read({ readRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    second.restore();
    await read({ readOnly: true });
    await expect(write({ gen: 'empty' })).rejects.toBeInstanceOf(CouldNotReadError);
    await read();
  });

  it('does not retry off win32: EACCES is the answer there', async () => {
    const restore = asPlatform('linux');
    const reads = failReads(targetPath, 'EACCES');
    await expect(read({ readRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    expect(reads.calls()).toBe(1);
    reads.restore();
    restore();
    await read();
  });

  it('does not step past a backup it could not read when the primary is corrupt', async () => {
    fs.writeFileSync(`${targetPath}.bak.1`, JSON.stringify({ gen: 'oldest' }));
    fs.writeFileSync(targetPath, '{torn');
    const reads = failReads(`${targetPath}.bak`, 'EBUSY');
    await expect(read({ readRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    reads.restore();
    await read();
  });
});

describe('reading a file that is not there', () => {
  it('waits on no missing slot, even on win32', async () => {
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

  it('reads a real failure as "could not read": a directory at the path', () => {
    const dirTarget = path.join(tmpDir, 'dir.json');
    fs.mkdirSync(dirTarget);
    expect(() => atomicReadJSONSync(dirTarget)).toThrow(CouldNotReadError);
  });
});

describe('a real fallback to a backup', () => {
  beforeEach(() => {
    atomicWriteJSONSync(targetPath, { gen: 'old' });
    atomicWriteJSONSync(targetPath, { gen: 'new' });
  });

  it('a corrupt primary still reads the backup, logged once as an error', () => {
    fs.writeFileSync(targetPath, '{torn');
    expect(atomicReadJSONSync(targetPath)).toEqual({ gen: 'old' });
    expect(atomicReadJSONSync(targetPath)).toEqual({ gen: 'old' });
    const text = logged.join('');
    expect(countErrorWarn(text)).toEqual({ errors: 1, warns: 0 });
    expect(text).toContain(`"${targetPath}" is corrupt; using the older state in state.json.bak`);
  });

  it('a missing primary still reads the backup, logged as a warning', () => {
    fs.unlinkSync(targetPath);
    expect(atomicReadJSONSync(targetPath)).toEqual({ gen: 'old' });
    expect(countErrorWarn(logged.join(''))).toEqual({ errors: 0, warns: 1 });
  });

  it('reports again after the file has read in between', () => {
    fs.writeFileSync(targetPath, '{torn');
    atomicReadJSONSync(targetPath);
    atomicWriteJSONSync(targetPath, { gen: 'fixed' });
    expect(atomicReadJSONSync(targetPath)).toEqual({ gen: 'fixed' });
    fs.writeFileSync(targetPath, '{torn');
    atomicReadJSONSync(targetPath);
    expect(countErrorWarn(logged.join('')).errors).toBeGreaterThanOrEqual(2);
  });
});

describe.each([
  ['async', (d: unknown, o?: object) => atomicWriteJSON(targetPath, d, o)],
  ['sync', async (d: unknown, o?: object) => atomicWriteJSONSync(targetPath, d, o)],
] as const)('the backup is replaced only by a valid primary (%s)', (_name, write) => {
  const corruptedDir = () => path.join(tmpDir, 'corrupted');

  beforeEach(async () => {
    await write({ gen: 'old' });
    await write({ gen: 'good' });
  });

  it('a good primary becomes the backup', async () => {
    await write({ gen: 'next' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'good' });
  });

  it.each([
    ['unparseable', '{torn'],
    ['all zero bytes', '\0'.repeat(64)],
  ])('an %s primary is set aside and the backup stays', async (_kind, bytes) => {
    fs.writeFileSync(targetPath, bytes);
    await write({ gen: 'next' });
    expect(json(targetPath)).toEqual({ gen: 'next' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(fs.readdirSync(corruptedDir())).toHaveLength(1);
  });

  it('with rotation on, the chain does not shift for it either', async () => {
    fs.writeFileSync(targetPath, '{torn');
    await write({ gen: 'next' }, { rotationEnabled: true });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(fs.existsSync(`${targetPath}.bak.1`)).toBe(false);
  });

  it('a primary the write validator rejects is not valid either', async () => {
    const validate = (d: unknown) => (d as { gen?: unknown }).gen !== 'good';
    await write({ gen: 'next' }, { validate });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(fs.readdirSync(corruptedDir())).toHaveLength(1);
  });

  it('an empty primary is replaced with nothing kept and the backup stays', async () => {
    fs.writeFileSync(targetPath, '');
    await write({ gen: 'next' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(fs.existsSync(corruptedDir())).toBe(false);
  });

  it('a primary it could not read stops the write, and everything stays', async () => {
    const reads = failReads(targetPath, 'EBUSY');
    await expect(write({ gen: 'next' }, { renameRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    reads.restore();
    expect(json(targetPath)).toEqual({ gen: 'good' });
    expect(json(`${targetPath}.bak`)).toEqual({ gen: 'old' });
    expect(fs.readdirSync(tmpDir).filter((n) => n.includes('.tmp.'))).toEqual([]);
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

  it('reports "could not read" instead of the older backup, then refuses the save', async () => {
    const reads = failReads(targetPath, 'EPERM');
    await expect(read({ readRetry: noSleep })).rejects.toBeInstanceOf(CouldNotReadError);
    reads.restore();
    await expect(write('empty')).rejects.toBeInstanceOf(CouldNotReadError);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('good');
    await expect(read()).resolves.toMatchObject({ content: 'good' });
    await write('next');
    expect(fs.readFileSync(`${targetPath}.bak`, 'utf-8')).toBe('good');
  });

  it('does not let a primary of zero bytes replace the backup', async () => {
    fs.writeFileSync(targetPath, '\0'.repeat(32));
    await write('next');
    expect(fs.readFileSync(`${targetPath}.bak`, 'utf-8')).toBe('old');
    expect(fs.readdirSync(path.join(tmpDir, 'corrupted'))).toHaveLength(1);
  });

  it('applies the write validator to the primary it replaces', async () => {
    await write('next', { validate: (t: string) => t !== 'good' });
    expect(fs.readFileSync(`${targetPath}.bak`, 'utf-8')).toBe('old');
  });

  it('logs a fallback where wmux doctor counts it', async () => {
    fs.unlinkSync(targetPath);
    await expect(read()).resolves.toMatchObject({ content: 'old' });
    expect(countErrorWarn(logged.join('')).warns).toBe(1);
  });
});
