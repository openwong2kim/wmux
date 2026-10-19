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
  it('sync: durable 경로가 tmp fsync를 호출하고 내용이 왕복된다', () => {
    const target = path.join(dir, 'manifest.json');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    atomicWriteJSONSync(target, { a: 1 }, { durable: true });
    // §2.3-2 tmp fd fsync가 최소 1회(+win32 아니면 §2.3-4 dir fsync).
    expect(fsyncSpy).toHaveBeenCalled();
    expect(atomicReadJSONSync<{ a: number }>(target)).toEqual({ a: 1 });
  });

  it('async: durable 경로가 내용을 정상 기록한다', async () => {
    const target = path.join(dir, 'snap.json');
    await atomicWriteJSON(target, { b: 2 }, { durable: true });
    expect(atomicReadJSONSync<{ b: number }>(target)).toEqual({ b: 2 });
  });

  it('durable 미지정(기존 경로)은 fsync 없이 동작이 불변', () => {
    const target = path.join(dir, 'plain.json');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    atomicWriteJSONSync(target, { c: 3 });
    // 기존 경로는 fsync를 호출하지 않는다(1비트 불변).
    expect(fsyncSpy).not.toHaveBeenCalled();
    expect(atomicReadJSONSync<{ c: number }>(target)).toEqual({ c: 3 });
  });
});
