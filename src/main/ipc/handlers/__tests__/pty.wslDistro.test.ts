// A pane opened where an external WSL session runs boots that session's
// distro; anything else keeps the settings picker's.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home', on: () => undefined },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {},
}));
vi.mock('../../../pty/defaultWslDistro', () => ({ getDefaultWslDistro: () => 'Debian' }));

import { liveWslTarget, requestedWslDistro } from '../pty.handler';

describe('requestedWslDistro', () => {
  it('takes a valid distro the create names', () => {
    expect(requestedWslDistro({ wslDistro: 'Ubuntu-24.04' })).toBe('Ubuntu-24.04');
  });

  it('falls back to the settings picker\'s distro for none or an invalid name', () => {
    expect(requestedWslDistro(undefined)).toBe('Debian');
    expect(requestedWslDistro({})).toBe('Debian');
    for (const bad of ['', '--exec', '-d', 'a;b', 'x"y']) expect(requestedWslDistro({ wslDistro: bad })).toBe('Debian');
  });

  it('both create paths (daemon and local) ask it; a dead session\'s own distro still wins', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'), 'utf8');
    expect(src.match(/wslDistroArgs\(shell, requestedWslDistro\(options\)\)/g)).toHaveLength(1);
    expect(src).not.toMatch(/wslDistroArgs\(shell, getDefaultWslDistro\(\)\)/);
    expect(src).toMatch(/isWslDistroSpawnArgs\(shell, trustedRecovery\?\.args\)\s*\? \[\.\.\.trustedRecovery\.args\]\s*: wslDistroArgs\(shell, wslFromTarget\?\.distribution \?\? requestedWslDistro\(options\)\)/);
  });
});

describe('liveWslTarget (a conversation continued from a WSL pane)', () => {
  const target = { distribution: 'Ubuntu', user: 'me' };
  it('is the live WSL pane\'s own distro and user', () => {
    expect(liveWslTarget([{ id: 'p1', state: 'attached', cmd: 'C:\\Windows\\System32\\wsl.exe', wslTarget: target }], 'p1')).toEqual(target);
    expect(liveWslTarget([{ id: 'p1', state: 'detached', cmd: 'wsl.exe', wslTarget: target }], 'p1')).toEqual(target);
  });

  it('is nothing for a closed, suspended, native or unknown pane, or a bad target', () => {
    expect(liveWslTarget([{ id: 'p1', state: 'dead', cmd: 'wsl.exe', wslTarget: target }], 'p1')).toBeUndefined();
    expect(liveWslTarget([{ id: 'p1', state: 'suspended', cmd: 'wsl.exe', wslTarget: target }], 'p1')).toBeUndefined();
    expect(liveWslTarget([{ id: 'p1', state: 'attached', cmd: 'pwsh.exe', wslTarget: target }], 'p1')).toBeUndefined();
    expect(liveWslTarget([{ id: 'p1', state: 'attached', cmd: 'wsl.exe', wslTarget: target }], 'p2')).toBeUndefined();
    expect(liveWslTarget([{ id: 'p1', state: 'attached', cmd: 'wsl.exe', wslTarget: { distribution: 'Ubuntu', user: '-x' } }], 'p1')).toBeUndefined();
  });
});
