import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSensitivePath, resolveAccessiblePath } from '../fs.handler';

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
}));

describe('fs.handler security helpers', () => {
  const home = path.join('C:', 'Users', 'tester');
  let realpathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    realpathSpy = vi.spyOn(fs.promises, 'realpath');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats the daemon auth token path as sensitive', () => {
    expect(isSensitivePath(path.join(home, '.wmux', 'daemon-auth-token'))).toBe(true);
  });

  it('rejects a symlink whose canonical target is sensitive', async () => {
    realpathSpy.mockResolvedValue(path.join(home, '.ssh', 'id_rsa'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'link-to-secret'))).resolves.toBeNull();
  });

  it('rejects a direct sensitive path before canonical lookup', async () => {
    await expect(resolveAccessiblePath(path.join(home, '.wmux-auth-token'))).resolves.toBeNull();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('returns the canonical path for an allowed target', async () => {
    const canonical = path.join(home, 'project', 'src', 'index.ts');
    realpathSpy.mockResolvedValue(canonical);

    await expect(resolveAccessiblePath(path.join(home, 'project', 'src', '..', 'src', 'index.ts'))).resolves.toBe(canonical);
  });

  it('returns null when canonicalization fails', async () => {
    realpathSpy.mockRejectedValue(new Error('ENOENT'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'missing.txt'))).resolves.toBeNull();
  });
});
