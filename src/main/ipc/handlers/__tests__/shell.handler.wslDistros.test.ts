// @wmux-lane unit — the WSL enumeration is mocked; nothing platform-specific runs.
// SHELL_WSL_DISTROS answers from the cache at once and refreshes in the
// background; only a cold cache waits for wsl.exe.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = new Map<string, (...args: unknown[]) => unknown>();
let known: string[] | null = null;
let resolveEnum: (v: string[]) => void = () => undefined;
const enumerate = vi.fn(() => new Promise<string[]>((r) => { resolveEnum = r; }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home', on: () => undefined },
  ipcMain: {
    handle: (c: string, fn: (...a: unknown[]) => unknown) => { captured.set(c, fn); },
    removeHandler: (c: string) => { captured.delete(c); },
    on: () => undefined,
  },
  shell: {},
  systemPreferences: {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {},
}));
vi.mock('../../../pty/defaultWslDistro', () => ({
  enumerateWslDistros: () => enumerate(),
  getKnownWslDistros: () => known,
}));

import { registerShellHandlers } from '../shell.handler';
import { IPC } from '../../../../shared/constants';

const call = async (): Promise<unknown> => captured.get(IPC.SHELL_WSL_DISTROS)!({});

beforeEach(() => { captured.clear(); enumerate.mockClear(); known = null; registerShellHandlers(); });

describe('SHELL_WSL_DISTROS', () => {
  it('returns the cached list without awaiting enumeration and refreshes in the background', async () => {
    known = ['Ubuntu'];
    const res = await call();
    expect(res).toEqual(['Ubuntu']);
    expect(enumerate).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent background refreshes', async () => {
    known = ['Ubuntu'];
    await call(); await call();
    expect(enumerate).toHaveBeenCalledTimes(1);
    resolveEnum(['Ubuntu']);
    await new Promise((r) => setTimeout(r, 0));
    await call();
    expect(enumerate).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed background refresh', async () => {
    known = ['Ubuntu'];
    enumerate.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await expect(call()).resolves.toEqual(['Ubuntu']);
  });

  it('awaits enumeration when the cache is cold', async () => {
    const p = call();
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    resolveEnum(['Debian']);
    expect(await p).toEqual(['Debian']);
  });
});
