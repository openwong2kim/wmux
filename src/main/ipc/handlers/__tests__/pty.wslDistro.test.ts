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

import { launchPlace, liveWslTarget, requestedWslDistro } from '../pty.handler';
import { WslAccountState } from '../../../account/wslAccountState';

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
    expect(src.match(/wslDistroArgs\(shell, (requestedWslDistro\(options\)|localRequestedDistro)\)/g)).toHaveLength(1);
    expect(src).not.toMatch(/wslDistroArgs\(shell, getDefaultWslDistro\(\)\)/);
    expect(src).toMatch(/!wslFromTarget && isWslDistroSpawnArgs\(shell, trustedRecovery\?\.args\)\s*\? \[\.\.\.trustedRecovery\.args\]\s*: wslDistroArgs\(shell, knownTarget\?\.distribution \?\? requestedDistro\)/);
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

describe('launchPlace (where the quota gate reads a WSL launch)', () => {
  const me = { distribution: 'Ubuntu', user: 'me' };
  it('is absent for a native shell, the known target when there is one, else where a plain pane of that distro started', () => {
    const state = new WslAccountState();
    expect(launchPlace(false, 'Ubuntu', me, state)).toBeUndefined();
    expect(launchPlace(true, 'Ubuntu', { distribution: 'Ubuntu', user: 'other' }, state)).toEqual({ wsl: { distribution: 'Ubuntu', user: 'other' } });
    // Unknown until a plain pane of that distro was seen: kept as is.
    expect(launchPlace(true, 'Ubuntu', undefined, state)).toEqual({ wsl: null });
    state.noteDefaultPlace('Ubuntu', me);
    expect(launchPlace(true, 'Ubuntu', undefined, state)).toEqual({ wsl: me });
    expect(launchPlace(true, null, undefined, state)).toEqual({ wsl: null });
  });

  it('a recovered pane without a valid target of its own has no place and records none; the distro is read once', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'), 'utf8');
    expect(src).toMatch(/const createPlace: LaunchPlace \| undefined = trustedRecovery && !knownTarget && isWslShell\(shell\)\s*\? \{ wsl: null \}/);
    expect(src).toContain('if (isWslShell(shell) && !wslFromTarget && !trustedRecovery && !poolTarget && validWslTarget(createdTarget)) {');
    expect(src).toContain('getWslAccountState().noteDefaultPlace(requestedDistro, createdTarget);');
    // The distro booted is the gate's: the source pane's, else the recovered pane's recorded one.
    expect(src).toContain('wslDistroArgs(shell, knownTarget?.distribution ?? requestedDistro)');
    expect(src).toContain('const wslArgs = !wslFromTarget && isWslDistroSpawnArgs(shell, trustedRecovery?.args)');
    // The spawn's target is the gate's, in the same order; a pool pick's home is pinned last.
    expect(src).toContain('wslTarget: wslFromTarget ?? trustedRecovery?.wslTarget ?? poolTarget,');
    expect(src).not.toMatch(/noteDefaultPlace\(requestedWslDistro\(options\)/);
  });
});

