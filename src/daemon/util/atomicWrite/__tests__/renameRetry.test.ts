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
function failCommitRenameSync(failures: number, code = 'EPERM') {
  const real = fs.renameSync.bind(fs);
  let seen = 0;
  const spy = vi
    .spyOn(fs, 'renameSync')
    .mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      if (to === targetPath && seen++ < failures) throw errno(code);
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
      if (to === targetPath && seen++ < failures) throw errno(code);
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
