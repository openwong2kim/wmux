// DaemonLogWriter behavior (T7~T11): buffering, ordering, durability, rotation.
// Real fs against a temp dir; fake timers drive the flush window.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDaemonLogWriter, type DaemonLogWriter } from '../logWriter';

let dir: string;
let logPath: string;

function make(overrides: Partial<Parameters<typeof createDaemonLogWriter>[0]> = {}): DaemonLogWriter {
  return createDaemonLogWriter({
    path: logPath,
    maxBytes: 5 * 1024 * 1024,
    flushMs: 250,
    bufferMaxBytes: 64 * 1024,
    ...overrides,
  });
}

function readLog(): string {
  try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; }
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-logwriter-'));
  logPath = path.join(dir, 'daemon.log');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DaemonLogWriter', () => {
  it('T8: info lines buffer and land after the flush window, in one chunk', () => {
    const w = make();
    w.write('info', 'a\n');
    w.write('info', 'b\n');
    expect(readLog()).toBe(''); // nothing on disk inside the window
    vi.advanceTimersByTime(250);
    expect(readLog()).toBe('a\nb\n');
  });

  it('T7: warn/error write through immediately AND drain earlier info first (order preserved)', () => {
    const w = make();
    w.write('info', 'earlier-info\n');
    w.write('error', 'the-error\n');
    // No timer advance: the error line forced everything out synchronously,
    // with the earlier info line physically BEFORE it.
    expect(readLog()).toBe('earlier-info\nthe-error\n');
  });

  it('T9: exceeding bufferMaxBytes force-flushes without waiting for the timer', () => {
    const w = make({ bufferMaxBytes: 10 });
    w.write('info', '0123456789ABC\n'); // 14 bytes ≥ 10 → immediate flush
    expect(readLog()).toBe('0123456789ABC\n');
  });

  it('T10: flush() drains the tail synchronously (the exit-hook path)', () => {
    const w = make();
    w.write('info', 'tail\n');
    expect(readLog()).toBe('');
    w.flush(); // what process.on('exit') calls
    expect(readLog()).toBe('tail\n');
  });

  it('T11: rotation happens on the flush path once the file exceeds maxBytes', () => {
    fs.writeFileSync(logPath, 'x'.repeat(100)); // pre-existing oversized file
    const w = make({ maxBytes: 50 });
    w.write('info', 'after-rotate\n');
    vi.advanceTimersByTime(250);
    expect(readLog()).toBe('after-rotate\n'); // fresh file post-rotation
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('x'.repeat(100));
  });

  it('write and flush never throw when the directory disappears (best-effort contract)', () => {
    const w = make();
    w.write('info', 'a\n');
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => w.write('error', 'boom\n')).not.toThrow();
    expect(() => w.flush()).not.toThrow();
    fs.mkdirSync(dir, { recursive: true }); // restore for afterEach
  });
});
