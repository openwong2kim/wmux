import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { decodeLsofName, driverCwd, readProcessCwd, type DriverCwdDeps } from '../cwd';

const SPAWN = '/spawn/dir';
const posix = process.platform === 'darwin' || process.platform === 'linux';

function deps(over: Partial<DriverCwdDeps> = {}): DriverCwdDeps {
  return {
    platform: 'darwin',
    processCwd: async () => '/link/repo',
    realpath: async (dir) => dir.replace(/^\/link/, '/work'),
    ...over,
  };
}

/** A short-lived child sitting in `cwd`, so the test reads a real process's directory. */
async function withChild<T>(cwd: string, run: (pid: number) => Promise<T>): Promise<T> {
  const child = spawn('sleep', ['30'], { cwd, stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return await run(child.pid!);
  } finally {
    child.kill();
  }
}

describe('driverCwd', () => {
  it('uses the real path of the shell\'s working directory', async () => {
    expect(await driverCwd({ spawnCwd: SPAWN, pid: 42 }, deps())).toBe('/work/repo');
  });

  it('falls back to the spawn directory when the shell\'s directory cannot be read', async () => {
    expect(await driverCwd({ spawnCwd: SPAWN, pid: 42 }, deps({ processCwd: async () => undefined }))).toBe(SPAWN);
    expect(await driverCwd({ spawnCwd: SPAWN, pid: 42 }, deps({ processCwd: async () => { throw new Error('lsof'); } }))).toBe(SPAWN);
    expect(await driverCwd({ spawnCwd: SPAWN, pid: 42 }, deps({ realpath: async () => { throw new Error('ENOENT'); } }))).toBe(SPAWN);
    expect(await driverCwd({ spawnCwd: SPAWN }, deps())).toBe(SPAWN);
  });

  it('uses the spawn directory on Windows', async () => {
    let asked = false;
    const win = deps({ platform: 'win32', processCwd: async () => { asked = true; return 'C:\\work\\repo'; } });
    expect(await driverCwd({ spawnCwd: 'C:\\spawn', pid: 42 }, win)).toBe('C:\\spawn');
    expect(asked).toBe(false);
  });

  it.runIf(posix)('reads a real shell\'s directory through a link as its canonical path', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chatv2-cwd-')));
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    const link = path.join(base, 'link');
    fs.symlinkSync(target, link);
    await withChild(link, async (pid) => {
      expect(await driverCwd({ spawnCwd: SPAWN, pid })).toBe(target);
    });
    // A process that is gone: the spawn directory.
    const gone = spawn('true');
    await new Promise((resolve) => gone.on('exit', resolve));
    expect(await driverCwd({ spawnCwd: SPAWN, pid: gone.pid! })).toBe(SPAWN);
  });
});

describe('readProcessCwd', () => {
  it.runIf(posix)('reads a non-ASCII directory with no locale in the daemon env', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '한글-작업-')));
    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE };
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    try {
      await withChild(dir, async (pid) => {
        const read = await readProcessCwd(pid);
        expect(read && fs.realpathSync(read)).toBe(dir);
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    }
  });

  it('reads nothing for an invalid pid or on Windows', async () => {
    expect(await readProcessCwd(-1)).toBeUndefined();
    expect(await readProcessCwd(process.pid, 'win32')).toBeUndefined();
  });

  it('decodes lsof\'s escaped bytes back to UTF-8 and leaves other text alone', () => {
    expect(decodeLsofName('/tmp/\\xed\\x95\\x9c\\xea\\xb8\\x80')).toBe('/tmp/한글');
    expect(decodeLsofName('/tmp/plain')).toBe('/tmp/plain');
    expect(decodeLsofName('/tmp/\\xff')).toBe('/tmp/\\xff');
  });
});
