/**
 * Commit-rename retry: on win32, real-time antivirus can hold a
 * handle on the destination just long enough for the tmp → target
 * rename to fail with EPERM/EACCES/EBUSY. Because the previous
 * primary is already at `.bak` by then, that failure leaves no
 * primary file — see #658.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { atomicWriteJSON, atomicWriteJSONSync } from '../core';

let tmpDir: string;
let targetPath: string;

/** No-sleep policy so tests never wait on real timers. */
const fastRetry = {
  delaysMs: [1, 1, 1, 1, 1],
  sleepSync: () => undefined,
  sleep: () => Promise.resolve(),
};

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: rename failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Force win32 for the duration of `fn`, then restore. */
async function asPlatform(value: string, fn: () => void | Promise<void>) {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'platform', {
      value: original,
      configurable: true,
    });
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rename-retry-'));
  targetPath = path.join(tmpDir, 'data.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Spy that fails the commit rename (destination === targetPath) the
 * first `failures` times and otherwise delegates to the real rename,
 * so the `.bak` rotation keeps working.
 */
/**
 * Only the tmp → target COMMIT is failed (`from` is a `.tmp.` path). The
 * `.bak` rotation and — critically — the `.bak` → target ROLLBACK go through,
 * matching real AV contention, which holds the freshly-written tmp content,
 * not the rename syscall as such.
 */
function failCommitRenameSync(failures: number, code = 'EPERM') {
  const real = fs.renameSync.bind(fs);
  let seen = 0;
  const spy = vi
    .spyOn(fs, 'renameSync')
    .mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      if (to === targetPath && String(from).includes('.tmp.') && seen++ < failures) throw errno(code);
      return real(from, to);
    });
  return spy;
}

function failCommitRename(failures: number, code = 'EPERM') {
  const real = fsp.rename.bind(fsp);
  let seen = 0;
  const spy = vi
    .spyOn(fsp, 'rename')
    .mockImplementation(async (from: fs.PathLike, to: fs.PathLike) => {
      if (to === targetPath && String(from).includes('.tmp.') && seen++ < failures) throw errno(code);
      return real(from, to);
    });
  return spy;
}

describe('atomicWriteJSONSync commit-rename retry', () => {
  it('succeeds once the transient EPERM window closes', async () => {
    await asPlatform('win32', () => {
      failCommitRenameSync(3);
      atomicWriteJSONSync(targetPath, { n: 1 }, { renameRetry: fastRetry });

      expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8'))).toEqual({ n: 1 });
    });
  });

  it('rethrows the original error after the bounded attempts', async () => {
    await asPlatform('win32', () => {
      const spy = failCommitRenameSync(Number.MAX_SAFE_INTEGER);

      expect(() =>
        atomicWriteJSONSync(targetPath, { n: 1 }, { renameRetry: fastRetry }),
      ).toThrow(expect.objectContaining({ code: 'EPERM' }));

      // 1 initial attempt + 5 retries, and no leaked tmp file.
      const commits = spy.mock.calls.filter((c) => c[1] === targetPath);
      expect(commits).toHaveLength(fastRetry.delaysMs.length + 1);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });
  });

  it('does not retry a non-transient error', async () => {
    await asPlatform('win32', () => {
      const spy = failCommitRenameSync(Number.MAX_SAFE_INTEGER, 'ENOENT');

      expect(() =>
        atomicWriteJSONSync(targetPath, { n: 1 }, { renameRetry: fastRetry }),
      ).toThrow(expect.objectContaining({ code: 'ENOENT' }));

      const commits = spy.mock.calls.filter((c) => c[1] === targetPath);
      expect(commits).toHaveLength(1);
    });
  });

  it('does not retry off win32', async () => {
    await asPlatform('linux', () => {
      const spy = failCommitRenameSync(1);

      expect(() =>
        atomicWriteJSONSync(targetPath, { n: 1 }, { renameRetry: fastRetry }),
      ).toThrow(expect.objectContaining({ code: 'EPERM' }));

      const commits = spy.mock.calls.filter((c) => c[1] === targetPath);
      expect(commits).toHaveLength(1);
    });
  });
});

describe('retry over an EXISTING primary (.bak rotated — the #658 shape)', () => {
  it('sync: transient window closes → new data committed, .bak holds the previous generation', async () => {
    await asPlatform('win32', () => {
      atomicWriteJSONSync(targetPath, { gen: 1 }, { renameRetry: fastRetry });
      failCommitRenameSync(3);
      atomicWriteJSONSync(targetPath, { gen: 2 }, { renameRetry: fastRetry });

      expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8'))).toEqual({ gen: 2 });
      expect(JSON.parse(fs.readFileSync(`${targetPath}.bak`, 'utf-8'))).toEqual({ gen: 1 });
    });
  });

  it('sync: retry exhaustion rolls .bak back — a failed write leaves the PREVIOUS state, not no state', async () => {
    await asPlatform('win32', () => {
      atomicWriteJSONSync(targetPath, { gen: 1 }, { renameRetry: fastRetry });
      failCommitRenameSync(Number.MAX_SAFE_INTEGER);

      expect(() =>
        atomicWriteJSONSync(targetPath, { gen: 2 }, { renameRetry: fastRetry }),
      ).toThrow(expect.objectContaining({ code: 'EPERM' }));

      // The primary must still exist and hold generation 1. Before the
      // rollback, exhaustion left NO primary at all (it was already at .bak),
      // and a crash in that window resurrected stale state on reload.
      expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8'))).toEqual({ gen: 1 });
    });
  });

  it('async: retry exhaustion rolls .bak back the same way', async () => {
    await asPlatform('win32', async () => {
      await atomicWriteJSON(targetPath, { gen: 1 }, { renameRetry: fastRetry });
      failCommitRename(Number.MAX_SAFE_INTEGER);

      await expect(
        atomicWriteJSON(targetPath, { gen: 2 }, { renameRetry: fastRetry }),
      ).rejects.toMatchObject({ code: 'EPERM' });

      expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8'))).toEqual({ gen: 1 });
    });
  });

  it('sync: the primary → .bak rotation itself is retried through the same transient window', async () => {
    await asPlatform('win32', () => {
      atomicWriteJSONSync(targetPath, { gen: 1 }, { renameRetry: fastRetry });
      // Fail the BACKUP rename (destination .bak), not the commit. Without a
      // retry here the write would still "succeed" but silently forfeit the
      // previous generation: .bak would hold nothing from this write.
      const bakPath = `${targetPath}.bak`;
      const real = fs.renameSync.bind(fs);
      let seen = 0;
      vi.spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
        if (to === bakPath && seen++ < 2) throw errno('EBUSY');
        return real(from, to);
      });

      atomicWriteJSONSync(targetPath, { gen: 2 }, { renameRetry: fastRetry });

      expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8'))).toEqual({ gen: 2 });
      expect(JSON.parse(fs.readFileSync(bakPath, 'utf-8'))).toEqual({ gen: 1 });
    });
  });
});

describe('policy clamping and default policy bounds', () => {
  it('caps an hostile/buggy delays array at the attempt and total-ms ceilings', async () => {
    await asPlatform('win32', () => {
      const spy = failCommitRenameSync(Number.MAX_SAFE_INTEGER);
      const slept: number[] = [];

      expect(() =>
        atomicWriteJSONSync(
          targetPath,
          { n: 1 },
          {
            renameRetry: {
              // 100 entries of 10s each — unclamped this would block for ~17min.
              delaysMs: new Array(100).fill(10_000),
              sleepSync: (ms) => void slept.push(ms),
            },
          },
        ),
      ).toThrow(expect.objectContaining({ code: 'EPERM' }));

      const total = slept.reduce((a, b) => a + b, 0);
      expect(slept.length).toBeLessThanOrEqual(8);
      expect(total).toBeLessThanOrEqual(500);
      expect(spy.mock.calls.filter((c) => c[1] === targetPath).length).toBeLessThanOrEqual(9);
    });
  });

  it('default delays sum to a sub-second stall', async () => {
    const { RENAME_RETRY_TOTAL_MS_FOR_TEST } = await import('../core');
    expect(RENAME_RETRY_TOTAL_MS_FOR_TEST).toBeLessThanOrEqual(500);
  });
});

describe('atomicWriteJSON commit-rename retry', () => {
  it('succeeds once the transient EBUSY window closes', async () => {
    await asPlatform('win32', async () => {
      failCommitRename(2, 'EBUSY');
      await atomicWriteJSON(targetPath, { n: 2 }, { renameRetry: fastRetry });

      expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8'))).toEqual({ n: 2 });
    });
  });

  it('rethrows the original error after the bounded attempts', async () => {
    await asPlatform('win32', async () => {
      const spy = failCommitRename(Number.MAX_SAFE_INTEGER, 'EACCES');

      await expect(
        atomicWriteJSON(targetPath, { n: 2 }, { renameRetry: fastRetry }),
      ).rejects.toMatchObject({ code: 'EACCES' });

      const commits = spy.mock.calls.filter((c) => c[1] === targetPath);
      expect(commits).toHaveLength(fastRetry.delaysMs.length + 1);
    });
  });

  it('does not retry off win32', async () => {
    await asPlatform('linux', async () => {
      const spy = failCommitRename(1);

      await expect(
        atomicWriteJSON(targetPath, { n: 2 }, { renameRetry: fastRetry }),
      ).rejects.toMatchObject({ code: 'EPERM' });

      const commits = spy.mock.calls.filter((c) => c[1] === targetPath);
      expect(commits).toHaveLength(1);
    });
  });
});
