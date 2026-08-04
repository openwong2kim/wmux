import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initDaemonLogSink, isBrokenPipeError } from '../logSink';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Models a POSIX stdio pipe whose reader is gone: write() returns normally and
 * the EPIPE arrives later as an `error` event. This is the shape the daemon's
 * old synchronous try/catch could not see.
 */
class AsyncBrokenPipe extends EventEmitter {
  writes = 0;

  write(): boolean {
    this.writes++;
    queueMicrotask(() => {
      this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    });
    return false;
  }
}

describe('daemon log sink', () => {
  it('shares the broken-pipe classification with the main sink', () => {
    expect(isBrokenPipeError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error('bad fd'), { code: 'EBADF' }))).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error('boom'), { code: 'ENOENT' }))).toBe(false);
  });

  it('retires a stdio pipe that fails asynchronously and keeps logging to the file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-daemon-log-'));
    tempDirs.push(dir);

    const stdout = new AsyncBrokenPipe();
    const stderr = new AsyncBrokenPipe();
    const realStdout = process.stdout;
    const realStderr = process.stderr;
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    Object.defineProperty(process, 'stderr', { value: stderr, configurable: true });

    try {
      initDaemonLogSink(dir);
      // The sink's own startup line goes through stderr and provokes the EPIPE.
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      // Model the uncaught-exception reporter printing the EPIPE 100 times. A
      // live pass-through would schedule 100 more error events; a retired one
      // schedules none.
      for (let i = 0; i < 100; i++) process.stderr.write('[daemon] Uncaught exception: write EPIPE\n');

      expect(stderr.writes).toBe(1);
    } finally {
      Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
      Object.defineProperty(process, 'stderr', { value: realStderr, configurable: true });
    }

    const logFile = fs.readdirSync(path.join(dir, 'logs')).find((f) => f.endsWith('.log'));
    if (!logFile) throw new Error('daemon sink wrote no log file');
    const contents = fs.readFileSync(path.join(dir, 'logs', logFile), 'utf8');
    // Every line still reached disk, and the file explains the silent console.
    expect(contents).toContain('daemon sink started');
    expect(contents).toContain('stderr pass-through disabled (code=EPIPE)');
    expect(contents.match(/Uncaught exception: write EPIPE/g)).toHaveLength(100);
  });
});
