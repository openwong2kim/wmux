import { describe, expect, it, vi } from 'vitest';
import path from 'path';
import type fs from 'fs';
import {
  DAEMON_STDERR_LOG,
  DAEMON_STDERR_ROTATE_BYTES,
  openDaemonStderrLog,
  rotateDaemonStderrLog,
} from '../daemonLauncherCore';

/**
 * #3440: the daemon's stderr goes to <wmuxDir>/daemon-stderr.log, rotated to
 * `.1` at spawn once past 1 MiB, so a native abort leaves its line behind.
 * Any failure keeps stderr off ('ignore') and never fails the spawn.
 */
const DIR = path.join('data', '.wmux-test');
const FILE = path.join(DIR, DAEMON_STDERR_LOG);

function fakeFs(opts: { size?: number; dir?: boolean; stat?: Error; rename?: Error; open?: Error }) {
  const calls: string[] = [];
  const impl = {
    statSync: vi.fn((p: string) => {
      calls.push(`stat ${p}`);
      if (opts.stat) throw opts.stat;
      if (opts.dir) return { size: 0, isFile: () => false };
      return opts.size === undefined ? undefined : { size: opts.size, isFile: () => true };
    }),
    renameSync: vi.fn((from: string, to: string) => {
      calls.push(`rename ${from} -> ${to}`);
      if (opts.rename) throw opts.rename;
    }),
    openSync: vi.fn((p: string, flags: string, mode: number) => {
      calls.push(`open ${p} ${flags} ${mode.toString(8)}`);
      if (opts.open) throw opts.open;
      return 42;
    }),
  };
  return { impl: impl as unknown as Pick<typeof fs, 'statSync' | 'renameSync' | 'openSync'>, calls };
}

describe('daemon stderr log', () => {
  it('opens a new file for append, owner-only, without rotating', () => {
    const { impl, calls } = fakeFs({});
    expect(openDaemonStderrLog(DIR, impl)).toBe(42);
    expect(calls).toEqual([`stat ${FILE}`, `open ${FILE} a 600`]);
  });

  it('appends to a file at or under 1 MiB', () => {
    const { impl, calls } = fakeFs({ size: DAEMON_STDERR_ROTATE_BYTES });
    expect(openDaemonStderrLog(DIR, impl)).toBe(42);
    expect(calls).toEqual([`stat ${FILE}`, `open ${FILE} a 600`]);
  });

  it('moves a file past 1 MiB to .1 (one kept) before opening a fresh one', () => {
    const { impl, calls } = fakeFs({ size: DAEMON_STDERR_ROTATE_BYTES + 1 });
    expect(openDaemonStderrLog(DIR, impl)).toBe(42);
    expect(calls).toEqual([`stat ${FILE}`, `rename ${FILE} -> ${FILE}.1`, `open ${FILE} a 600`]);
  });

  it.each([
    ['the size check fails', { stat: Object.assign(new Error('EACCES'), { code: 'EACCES' }) }],
    ['the rotation fails', { size: DAEMON_STDERR_ROTATE_BYTES + 1, rename: Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) }],
    ['the open fails', { open: Object.assign(new Error('EMFILE'), { code: 'EMFILE' }) }],
    ['something other than a file is at its path', { dir: true }],
  ])('keeps stderr off when %s, without throwing', (_what, opts) => {
    const { impl, calls } = fakeFs(opts);
    expect(openDaemonStderrLog(DIR, impl)).toBe('ignore');
    if ('dir' in opts) expect(calls).toEqual([`stat ${FILE}`]);
  });

  it('rotation alone reports the path, or null when it failed (launchd opens the file itself)', () => {
    expect(rotateDaemonStderrLog(DIR, fakeFs({ size: 10 }).impl)).toBe(FILE);
    expect(rotateDaemonStderrLog(DIR, fakeFs({ size: DAEMON_STDERR_ROTATE_BYTES + 1, rename: new Error('EPERM') }).impl)).toBeNull();
  });
});
