import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import type { SessionLocationSnapshot } from '../../../../shared/sessionLocation';
import {
  getRememberedSessionLocation,
  rememberSessionLocation,
  resetSessionLocationProjections,
} from '../../sessionLocationProjection';
import { createSurfaceSlice } from '../surfaceSlice';

type TestState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

function createHarness() {
  const workspace = createWorkspace('Test');
  const state: TestState = {
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  };
  const set = (updater: (state: TestState) => void) => updater(state);
  const slice = createSurfaceSlice(set as never, (() => state) as never, {} as never);
  Object.assign(state, slice);
  return { state, slice };
}

function snapshot(revision: number, cwd: string, distro?: string): SessionLocationSnapshot {
  return {
    generation: 100,
    revision,
    location: {
      domain: 'wsl',
      cwd,
      shell: 'wsl.exe',
      ...(distro ? { distro } : {}),
    },
  };
}

beforeEach(() => {
  resetSessionLocationProjections();
  vi.stubGlobal('window', { electronAPI: { platform: 'win32' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('surface location snapshot projection', () => {
  it('adopts the create response only after the surface binding exists', () => {
    const { state, slice } = createHarness();
    expect(slice.updateSurfaceLocation('pty-1', snapshot(1, '/too-early'))).toBe(false);
    slice.addSurface(
      state.workspaces[0].rootPane.id,
      'pty-1',
      'wsl.exe',
      '/stale',
      undefined,
      snapshot(2, '/home/me/repo', 'Ubuntu'),
    );

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces[0]).toMatchObject({
      cwd: '/home/me/repo',
      location: snapshot(2, '/home/me/repo', 'Ubuntu').location,
    });
  });

  it('updates cwd and location atomically and rejects a stale snapshot response', () => {
    const { state, slice } = createHarness();
    slice.addSurface(state.workspaces[0].rootPane.id, 'pty-1', 'wsl.exe', '/initial');
    slice.updateSurfaceLocation('pty-1', snapshot(3, '/new', 'Ubuntu'));
    slice.updateSurfaceLocation('pty-1', snapshot(2, '/old'));

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces[0]).toMatchObject({
      cwd: '/new',
      location: snapshot(3, '/new', 'Ubuntu').location,
    });
  });

  it('rejects an implausible atomic snapshot without changing the surface', () => {
    const { state, slice } = createHarness();
    slice.addSurface(
      state.workspaces[0].rootPane.id,
      'pty-1',
      'wsl.exe',
      '/home/me/repo',
      undefined,
      snapshot(1, '/home/me/repo', 'Ubuntu'),
    );

    expect(slice.updateSurfaceLocation('pty-1', snapshot(2, 'relative/path', 'Ubuntu')))
      .toBe(false);

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces[0]).toMatchObject({
      cwd: '/home/me/repo',
      location: snapshot(1, '/home/me/repo', 'Ubuntu').location,
    });
    expect(getRememberedSessionLocation('pty-1')).toEqual(
      snapshot(1, '/home/me/repo', 'Ubuntu'),
    );
  });

  it('rejects a Windows cwd for a WSL snapshot on win32', () => {
    const { state, slice } = createHarness();
    slice.addSurface(
      state.workspaces[0].rootPane.id,
      'pty-1',
      'wsl.exe',
      '/home/me/repo',
      undefined,
      snapshot(1, '/home/me/repo', 'Ubuntu'),
    );

    expect(slice.updateSurfaceLocation('pty-1', snapshot(2, 'C:\\repo', 'Ubuntu')))
      .toBe(false);

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces[0]).toMatchObject({
      cwd: '/home/me/repo',
      location: snapshot(1, '/home/me/repo', 'Ubuntu').location,
    });
    expect(getRememberedSessionLocation('pty-1')).toEqual(
      snapshot(1, '/home/me/repo', 'Ubuntu'),
    );
  });

  it('uses the exposed renderer platform for host snapshots', () => {
    const { state, slice } = createHarness();
    const hostSnapshot = (revision: number, cwd: string): SessionLocationSnapshot => ({
      generation: 100,
      revision,
      location: { domain: 'host', cwd, shell: 'pwsh.exe' },
    });
    slice.addSurface(
      state.workspaces[0].rootPane.id,
      'pty-1',
      'pwsh.exe',
      'C:\\repo',
      undefined,
      hostSnapshot(1, 'C:\\repo'),
    );

    expect(slice.updateSurfaceLocation('pty-1', hostSnapshot(2, 'D:\\repo'))).toBe(true);
    window.electronAPI.platform = 'darwin';
    expect(slice.updateSurfaceLocation('pty-1', hostSnapshot(3, 'E:\\repo'))).toBe(false);

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces[0]).toMatchObject({
      cwd: 'D:\\repo',
      location: hostSnapshot(2, 'D:\\repo').location,
    });
  });

  it('releases projection state before delayed delivery after close', () => {
    const { state, slice } = createHarness();
    slice.addSurface(
      state.workspaces[0].rootPane.id,
      'pty-1',
      'wsl.exe',
      '/initial',
      undefined,
      snapshot(1, '/live'),
    );
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');

    slice.closeSurface(pane.id, pane.surfaces[0].id);

    expect(getRememberedSessionLocation('pty-1')).toBeUndefined();
    expect(slice.updateSurfaceLocation('pty-1', snapshot(2, '/late'))).toBe(false);
  });

  it('does not mint a lease for a delayed rebind after its surface disappeared', () => {
    const { slice } = createHarness();

    slice.updateSurfacePtyId('missing-pane', 'missing-surface', 'pty-late');

    expect(rememberSessionLocation('pty-late', snapshot(1, '/late'))).toBe(false);
    expect(getRememberedSessionLocation('pty-late')).toBeUndefined();
  });
});
