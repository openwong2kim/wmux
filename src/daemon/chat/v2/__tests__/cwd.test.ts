import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { driverCwd, readProcessCwd, type DriverCwdDeps } from '../cwd';

const SPAWN = '/spawn/dir';

function deps(over: Partial<DriverCwdDeps> = {}): DriverCwdDeps {
  return {
    platform: 'darwin',
    processCwd: async () => '/work/repo',
    realpath: async (dir) => dir.replace(/^\/link/, '/work'),
    ...over,
  };
}

describe('driverCwd', () => {
  it('uses the reported directory when it is the shell\'s verified working directory', async () => {
    expect(await driverCwd({ cwd: '/work/repo', spawnCwd: SPAWN, pid: 42 }, deps())).toBe('/work/repo');
    // Same directory through a symlink on either side.
    expect(await driverCwd({ cwd: '/link/repo', spawnCwd: SPAWN, pid: 42 }, deps())).toBe('/link/repo');
  });

  it('falls back to the spawn directory when the shell is somewhere else', async () => {
    expect(await driverCwd({ cwd: '/elsewhere', spawnCwd: SPAWN, pid: 42 }, deps())).toBe(SPAWN);
  });

  it('falls back to the spawn directory when either directory cannot be read', async () => {
    expect(await driverCwd({ cwd: '/work/repo', spawnCwd: SPAWN, pid: 42 }, deps({ processCwd: async () => undefined }))).toBe(SPAWN);
    expect(await driverCwd({ cwd: '/work/repo', spawnCwd: SPAWN, pid: 42 }, deps({ processCwd: async () => { throw new Error('lsof'); } }))).toBe(SPAWN);
    expect(await driverCwd({ cwd: '/work/repo', spawnCwd: SPAWN, pid: 42 }, deps({ realpath: async () => { throw new Error('ENOENT'); } }))).toBe(SPAWN);
    expect(await driverCwd({ cwd: '/work/repo', spawnCwd: SPAWN }, deps())).toBe(SPAWN);
    expect(await driverCwd({ cwd: 'relative', spawnCwd: SPAWN, pid: 42 }, deps())).toBe(SPAWN);
    expect(await driverCwd({ spawnCwd: SPAWN, pid: 42 }, deps())).toBe(SPAWN);
  });

  it('uses the spawn directory on Windows', async () => {
    let asked = false;
    const win = deps({ platform: 'win32', processCwd: async () => { asked = true; return 'C:\\work\\repo'; } });
    expect(await driverCwd({ cwd: 'C:\\work\\repo', spawnCwd: 'C:\\spawn', pid: 42 }, win)).toBe('C:\\spawn');
    expect(asked).toBe(false);
  });
});

describe('readProcessCwd', () => {
  it('reads this process\'s own working directory where the platform allows it', async () => {
    const own = await readProcessCwd(process.pid);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(own && fs.realpathSync(own)).toBe(fs.realpathSync(process.cwd()));
    } else {
      expect(own).toBeUndefined();
    }
    expect(await readProcessCwd(-1)).toBeUndefined();
    expect(await readProcessCwd(process.pid, 'win32')).toBeUndefined();
  });
});
