import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/unused-in-unit-tests',
    getVersion: () => 'test',
  },
}));

import { BoundedLogWriter, createResilientTee, isBrokenPipeError } from '../logSink';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class AsyncBrokenPipe extends EventEmitter {
  writes = 0;

  write(): boolean {
    this.writes++;
    queueMicrotask(() => {
      const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      this.emit('error', error);
    });
    return false;
  }
}

describe('main log sink', () => {
  it('recognises errors that the global exception handlers must not write back to stdio', () => {
    expect(isBrokenPipeError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))).toBe(false);
    expect(isBrokenPipeError('EPIPE')).toBe(false);
  });

  it('disables a broken pass-through after an asynchronous EPIPE instead of feeding uncaughtException recursion', async () => {
    const stream = new AsyncBrokenPipe();
    const mirrored: string[] = [];
    const tee = createResilientTee(stream, (chunk) => { mirrored.push(String(chunk)); });

    expect(tee('first write')).toBe(false);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Model the global uncaughtException reporter trying to print the EPIPE.
    // The failing fd is disabled, so this and all later logs are file-only and
    // cannot schedule another EPIPE event.
    for (let i = 0; i < 100; i++) expect(tee('[Main] Uncaught exception: write EPIPE')).toBe(true);

    expect(stream.writes).toBe(1);
    expect(mirrored).toHaveLength(101);

    const callback = vi.fn();
    expect(tee('file-only write', callback)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(callback).toHaveBeenCalledOnce();
  });

  it('disables a pass-through that throws EPIPE synchronously', () => {
    const stream = new EventEmitter() as EventEmitter & {
      writes: number;
      write(chunk: unknown, ...rest: unknown[]): boolean;
    };
    stream.writes = 0;
    stream.write = () => {
      stream.writes++;
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    };
    const tee = createResilientTee(stream, () => undefined);

    expect(tee('first')).toBe(true);
    expect(tee('second')).toBe(true);
    expect(stream.writes).toBe(1);
  });

  it('caps every generation and retains only the configured archive count', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-log-rotation-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'main-2026-08-04.log');
    const writer = new BoundedLogWriter(10, 2);

    writer.append(file, 'aaaaaaaa');
    writer.append(file, 'bbbbbbbb');
    writer.append(file, 'cccccccc');
    writer.append(file, 'dddddddd');

    expect(fs.readFileSync(file, 'utf8')).toBe('dddddddd');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('cccccccc');
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toBe('bbbbbbbb');
    expect(fs.readdirSync(dir).sort()).toEqual([
      'main-2026-08-04.log',
      'main-2026-08-04.log.1',
      'main-2026-08-04.log.2',
    ]);
    for (const name of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(10);
  });

  it('splits a single oversized write without letting any rotated file exceed the cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-log-oversized-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'main-2026-08-04.log');
    const writer = new BoundedLogWriter(8, 2);

    writer.append(file, 'abcdefghijklmnopqrst');

    expect(fs.readFileSync(`${file}.2`, 'utf8')).toBe('abcdefgh');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('ijklmnop');
    expect(fs.readFileSync(file, 'utf8')).toBe('qrst');
    for (const name of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(8);
  });

  it('rotates on the real file size so a second process appending to the same file cannot overshoot the cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-log-shared-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'main-2026-08-04.log');
    // Two writer instances model two wmux processes sharing one daily file.
    const installed = new BoundedLogWriter(10, 2);
    const devBuild = new BoundedLogWriter(10, 2);

    installed.append(file, 'aaaaa');
    devBuild.append(file, 'bbbbb');
    // A cached per-process byte counter would still read 5 here and append to
    // 15 bytes. The stat-based size sees 10 and rotates first.
    installed.append(file, 'ccccc');

    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('aaaaabbbbb');
    expect(fs.readFileSync(file, 'utf8')).toBe('ccccc');
    for (const name of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(10);
  });

  it('defers rotation while another process holds the lock instead of shifting a generation twice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-log-lock-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'main-2026-08-04.log');
    const writer = new BoundedLogWriter(10, 2);

    writer.append(file, 'aaaaaaaaaa');
    fs.writeFileSync(`${file}.lock`, ''); // another process is mid-rotation
    writer.append(file, 'bbbbb');

    // No archive was created and nothing was lost — the line went to the live
    // file, which is briefly over cap.
    expect(fs.existsSync(`${file}.1`)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('aaaaaaaaaabbbbb');

    fs.unlinkSync(`${file}.lock`); // the other process finished
    writer.append(file, 'ccccc');

    // The over-cap live file is tail-bounded before it becomes an archive, so
    // the cap holds for every generation even after a deferred rotation.
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('aaaaabbbbb');
    expect(fs.readFileSync(file, 'utf8')).toBe('ccccc');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    for (const name of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(10);
  });

  it('breaks a rotation lock abandoned by a crashed process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-log-stale-lock-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'main-2026-08-04.log');
    const writer = new BoundedLogWriter(10, 2);

    writer.append(file, 'aaaaaaaaaa');
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, '');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, stale, stale);

    writer.append(file, 'bbbbb');

    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('aaaaaaaaaa');
    expect(fs.readFileSync(file, 'utf8')).toBe('bbbbb');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('bounds a legacy oversized daily file before rotating it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-log-legacy-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'main-2026-08-04.log');
    fs.writeFileSync(file, 'abcdefghijklmnopqrst');
    const writer = new BoundedLogWriter(8, 1);

    writer.append(file, 'Z');

    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('mnopqrst');
    expect(fs.readFileSync(file, 'utf8')).toBe('Z');
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(8);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(8);
  });
});
