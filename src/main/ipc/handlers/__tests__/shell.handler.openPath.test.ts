/**
 * shell.handler — filesystem-path trust boundary.
 *
 * The request is anchored to a live PTY. Main resolves that PTY's location,
 * converts guest paths into host-accessible paths, and only then normalizes
 * and applies the executable-extension gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLocation } from '../../../../shared/sessionLocation';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const openPath = vi.fn();
  const showItemInFolder = vi.fn();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
    shell: { openPath, showItemInFolder, openExternal: vi.fn() },
    app: { isPackaged: false, getAppMetrics: vi.fn(() => []) },
    __handlers: handlers,
    __openPath: openPath,
    __showItemInFolder: showItemInFolder,
  };
});

vi.mock('../../../../shared/ShellDetector', () => ({
  ShellDetector: class {
    detect() {
      return Promise.resolve([]);
    }
  },
}));

vi.mock('../../../system/SystemStatsSampler', () => ({
  SystemStatsSampler: class {
    sample() {
      return Promise.resolve({});
    }
  },
}));

import * as electron from 'electron';
import { IPC } from '../../../../shared/constants';
import { registerShellHandlers } from '../shell.handler';

const mockedElectron = electron as unknown as {
  __handlers: Map<string, (...args: unknown[]) => unknown>;
  __openPath: ReturnType<typeof vi.fn>;
  __showItemInFolder: ReturnType<typeof vi.fn>;
};
const locations = new Map<string, SessionLocation>();
let cleanup: (() => void) | null = null;

function handler(): (...args: unknown[]) => unknown {
  const registered = mockedElectron.__handlers.get(IPC.SHELL_OPEN_PATH);
  if (!registered) throw new Error('open-path handler is not registered');
  return registered;
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent;
const hostLocation: SessionLocation = {
  domain: 'host',
  cwd: process.platform === 'win32' ? 'C:\\Users\\rizz' : '/home/rizz',
  shell: process.platform === 'win32' ? 'pwsh.exe' : '/bin/bash',
};

async function invoke(path: unknown, ptyId = 'pty-host'): Promise<unknown> {
  locations.set('pty-host', hostLocation);
  return handler()(fakeEvent, { path, ptyId });
}

beforeEach(() => {
  mockedElectron.__handlers.clear();
  mockedElectron.__openPath.mockReset().mockResolvedValue('');
  mockedElectron.__showItemInFolder.mockReset();
  locations.clear();
  cleanup = registerShellHandlers((ptyId) => locations.get(ptyId) ?? null);
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('shell.handler — SHELL_OPEN_PATH', () => {
  it('forwards a normalized host path', async () => {
    const input = process.platform === 'win32' ? 'C:\\foo\\..\\bar.txt' : '/foo/../bar.txt';
    const expected = process.platform === 'win32' ? 'C:\\bar.txt' : '/bar.txt';

    await expect(invoke(input)).resolves.toEqual({ ok: true, error: undefined });
    expect(mockedElectron.__openPath).toHaveBeenCalledWith(expected);
  });

  it.each([
    ['non-string', 42, /string/i],
    ['empty', '', /length/i],
    ['NUL', process.platform === 'win32' ? 'C:\\foo\0bar' : '/foo\0bar', /NUL/i],
    ['oversize', `${process.platform === 'win32' ? 'C:\\' : '/'}${'a'.repeat(5000)}`, /length/i],
    ['relative', 'relative/file.txt', /absolute/i],
    ['URL', 'https://example.com/file.txt', /filesystem|URL/i],
  ])('rejects %s path input', async (_name, value, error) => {
    await expect(invoke(value)).rejects.toThrow(error as RegExp);
    expect(mockedElectron.__openPath).not.toHaveBeenCalled();
  });

  it('rejects a missing or stale originating PTY identity explicitly', async () => {
    await expect(
      handler()(fakeEvent, { path: '/etc/hosts', ptyId: 'pty-stale' }),
    ).rejects.toThrow(/PTY.*not found|stale/i);
    expect(mockedElectron.__openPath).not.toHaveBeenCalled();
  });

  it('rejects a malformed PTY identity', async () => {
    await expect(handler()(fakeEvent, { path: '/etc/hosts', ptyId: '' })).rejects.toThrow(/PTY/i);
    expect(mockedElectron.__openPath).not.toHaveBeenCalled();
  });

  it('converts WSL paths before normalization', async () => {
    if (process.platform !== 'win32') return;
    locations.set('pty-wsl', {
      domain: 'wsl',
      cwd: '/home/me',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    });

    const result = await handler()(
      fakeEvent,
      { path: '/home/me/project/../safe.txt', ptyId: 'pty-wsl' },
    );

    expect(mockedElectron.__openPath).toHaveBeenCalledWith(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\safe.txt',
    );
    expect(result).toEqual({ ok: true, error: undefined });
  });

  it('fails explicitly when a WSL path needs a missing distro', async () => {
    locations.set('pty-wsl', { domain: 'wsl', cwd: '/home/me', shell: 'wsl.exe' });

    await expect(
      handler()(fakeEvent, { path: '/home/me/file.txt', ptyId: 'pty-wsl' }),
    ).rejects.toThrow(/WSL_DISTRO_REQUIRED|distro/i);
    expect(mockedElectron.__openPath).not.toHaveBeenCalled();
  });

  it('applies the executable blocklist to the converted target', async () => {
    if (process.platform !== 'win32') return;
    locations.set('pty-wsl', {
      domain: 'wsl',
      cwd: '/home/me',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    });

    const result = await handler()(
      fakeEvent,
      { path: '/home/me/setup.EXE', ptyId: 'pty-wsl' },
    );

    const resolved = '\\\\wsl.localhost\\Ubuntu\\home\\me\\setup.EXE';
    expect(mockedElectron.__openPath).not.toHaveBeenCalled();
    expect(mockedElectron.__showItemInFolder).toHaveBeenCalledWith(resolved);
    expect(result).toEqual({ ok: false, error: 'BLOCKED_EXTENSION' });
  });

  it('falls back to reveal when Electron cannot open the resolved path', async () => {
    mockedElectron.__openPath.mockResolvedValueOnce('Failed to open path');
    const input = process.platform === 'win32' ? 'C:\\missing.txt' : '/missing.txt';

    const result = await invoke(input);

    expect(mockedElectron.__showItemInFolder).toHaveBeenCalledWith(input);
    expect(result).toEqual({ ok: false, error: 'Failed to open path' });
  });

  it('blocks all configured executable extensions case-insensitively', async () => {
    // Windows hosts normalize forward slashes to backslashes; POSIX hosts leave
    // the input unchanged. Asserting the exact revealed path matters: a bare
    // call-count assertion passes even when main reveals the WRONG folder.
    const expectNormalized = (input: string) =>
      process.platform === 'win32' ? input.replace(/\//g, '\\') : input;
    const samples = [
      '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1',
      '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi',
      '.reg', '.lnk', '.hta', '.cpl',
    ];
    for (const extension of samples) {
      mockedElectron.__openPath.mockClear();
      mockedElectron.__showItemInFolder.mockClear();
      const input = process.platform === 'win32'
        ? `C:\\Users\\rizz\\evil${extension.toUpperCase()}`
        : `/home/rizz/evil${extension.toUpperCase()}`;
      await expect(invoke(input)).resolves.toEqual({
        ok: false,
        error: 'BLOCKED_EXTENSION',
      });
      expect(mockedElectron.__openPath).not.toHaveBeenCalled();
      expect(mockedElectron.__showItemInFolder).toHaveBeenCalledWith(expectNormalized(input));
    }
  });

  it('allows non-executable extensions', async () => {
    const input = process.platform === 'win32' ? 'C:\\foo.txt' : '/foo.txt';

    await expect(invoke(input)).resolves.toEqual({ ok: true, error: undefined });
    expect(mockedElectron.__openPath).toHaveBeenCalledWith(input);
    expect(mockedElectron.__showItemInFolder).not.toHaveBeenCalled();
  });

  it('allows extension-less paths (folders)', async () => {
    const input = process.platform === 'win32' ? 'C:\\Users\\rizz' : '/home/rizz';

    await expect(invoke(input)).resolves.toEqual({ ok: true, error: undefined });
    expect(mockedElectron.__openPath).toHaveBeenCalledWith(input);
    expect(mockedElectron.__showItemInFolder).not.toHaveBeenCalled();
  });
});
