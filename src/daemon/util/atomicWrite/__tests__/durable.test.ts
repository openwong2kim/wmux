import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  atomicWriteJSON,
  atomicWriteJSONSync,
  atomicReadJSONSync,
} from '../core';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-durable-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('durable atomic write (§2.3)', () => {
  it('sync: durable path calls tmp fsync and round-trips content', () => {
    const target = path.join(dir, 'manifest.json');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    atomicWriteJSONSync(target, { a: 1 }, { durable: true });
    // §2.3-2 tmp fd fsync at least once (+ §2.3-4 dir fsync when not win32).
    expect(fsyncSpy).toHaveBeenCalled();
    expect(atomicReadJSONSync<{ a: number }>(target)).toEqual({ a: 1 });
  });

  it('async: durable path records content correctly', async () => {
    const target = path.join(dir, 'snap.json');
    await atomicWriteJSON(target, { b: 2 }, { durable: true });
    expect(atomicReadJSONSync<{ b: number }>(target)).toEqual({ b: 2 });
  });

  it('durable unset (legacy path) behaves unchanged without fsync', () => {
    const target = path.join(dir, 'plain.json');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    atomicWriteJSONSync(target, { c: 3 });
    // Legacy path does not call fsync (1-bit invariant).
    expect(fsyncSpy).not.toHaveBeenCalled();
    expect(atomicReadJSONSync<{ c: number }>(target)).toEqual({ c: 3 });
  });
});
