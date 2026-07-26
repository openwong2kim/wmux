import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSensitivePath, registerFsHandlers, resolveAccessiblePath } from '../fs.handler';
import { ipcMain } from 'electron';

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
  // Use an OS-native absolute home path. The previous Windows-only hardcode
  // (`path.join('C:', 'Users', 'tester')`) produced "C:/Users/tester" on
  // Unix, which path.resolve treats as a relative segment under cwd. The
  // resulting absolute path no longer prefix-matches `home`, so
  // isSensitivePath returned false and realpath was unexpectedly called.
  const home = process.platform === 'win32'
    ? path.join('C:', 'Users', 'tester')
    : path.join('/home', 'tester');
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
    expect(isSensitivePath(path.join(home, '.fmux', 'daemon-auth-token'))).toBe(true);
  });

  it('rejects a symlink whose canonical target is sensitive', async () => {
    realpathSpy.mockResolvedValue(path.join(home, '.ssh', 'id_rsa'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'link-to-secret'))).resolves.toBeNull();
  });

  it('rejects a direct sensitive path before canonical lookup', async () => {
    await expect(resolveAccessiblePath(path.join(home, '.fmux-auth-token'))).resolves.toBeNull();
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

  it('converts a WSL path before canonicalization and security checks', async () => {
    const guestPath = '/home/me/project/src';
    const hostPath = path.join(home, 'converted', 'project', 'src');
    realpathSpy.mockResolvedValue(hostPath);
    const convert = vi.fn(() => ({ ok: true as const, path: hostPath }));

    await expect(resolveAccessiblePath(
      guestPath,
      { domain: 'wsl', cwd: '/home/me/project', shell: 'wsl.exe', distro: 'Ubuntu' },
      convert,
    )).resolves.toBe(hostPath);

    expect(convert).toHaveBeenCalledWith(
      { domain: 'wsl', cwd: '/home/me/project', shell: 'wsl.exe', distro: 'Ubuntu' },
      guestPath,
    );
    expect(realpathSpy).toHaveBeenCalledWith(path.resolve(hostPath));
  });

  it('fails softly when WSL conversion requires a missing distro', async () => {
    await expect(resolveAccessiblePath(
      '/home/me/project',
      { domain: 'wsl', cwd: '/home/me/project', shell: 'wsl.exe' },
    )).resolves.toBeNull();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('accepts structured location payloads in file-tree handlers', async () => {
    const hostPath = path.join(home, 'project');
    realpathSpy.mockResolvedValue(hostPath);
    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([] as never);
    registerFsHandlers();
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const readDir = calls.find(([channel]) => channel === 'fs:read-dir')?.[1];
    expect(readDir).toBeTypeOf('function');

    await expect(readDir!(
      {} as Electron.IpcMainInvokeEvent,
      {
        path: hostPath,
        location: { domain: 'host', cwd: hostPath, shell: 'pwsh.exe' },
      },
    )).resolves.toEqual([]);
    expect(realpathSpy).toHaveBeenCalled();
  });

  // Issue #21: `msys` is a legal wire domain. The handler used to re-declare
  // the SessionLocation contract itself and reject it, so a Git Bash pane got
  // an empty file tree.
  it('accepts an MSYS location and converts its guest path', async () => {
    const converted = path.resolve('C:\\dev\\proj');
    realpathSpy.mockResolvedValue(converted);
    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([] as never);
    registerFsHandlers();
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const readDir = calls.find(([channel]) => channel === 'fs:read-dir')?.[1];
    expect(readDir).toBeTypeOf('function');

    await expect(readDir!(
      {} as Electron.IpcMainInvokeEvent,
      {
        path: '/c/dev/proj',
        location: {
          domain: 'msys',
          cwd: '/c/dev/proj',
          shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
        },
      },
    )).resolves.toEqual([]);
    expect(realpathSpy).toHaveBeenCalledWith(converted);
  });

  // The guest-path guard belongs to toHostAccessiblePath (issue #21 AC 6), not
  // to a `process.platform === 'win32' && isLinuxLikeCwd(...)` sniff in here.
  it('rejects a bare guest cwd through the shared choke point on Windows', async () => {
    if (process.platform !== 'win32') return;
    registerFsHandlers();
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const readDir = calls.find(([channel]) => channel === 'fs:read-dir')?.[1];

    await expect(readDir!({} as Electron.IpcMainInvokeEvent, '/home/me/project')).resolves.toEqual([]);
    expect(realpathSpy).not.toHaveBeenCalled();
  });
});
