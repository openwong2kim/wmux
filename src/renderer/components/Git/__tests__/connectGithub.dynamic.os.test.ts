// @vitest-environment jsdom
//
// Connect GitHub's sign-in tab: it never leaves a gh process running with no
// tab to show it, never opens two tabs for a double click, and on Windows does
// not run inside a WSL default shell (whose gh is not the one wmux reads).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { useStore } from '../../../stores';
import { openGithubLoginTab } from '../connectGithub';
import type { Workspace } from '../../../../shared/types';

function ws(): Workspace {
  return {
    id: 'w', name: 'w', activePaneId: 'p',
    rootPane: { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty-0', title: 'zsh', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }] },
  } as unknown as Workspace;
}

let create: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;
let release: (() => void) | null;

beforeEach(() => {
  release = null;
  let n = 0;
  create = vi.fn(() => new Promise((resolve) => {
    const id = `pty-login-${++n}`;
    release = () => resolve({ id, shell: '/bin/zsh', cwd: '/r' });
  }));
  dispose = vi.fn(async () => undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'darwin', pty: { create, dispose } };
  act(() => useStore.setState({
    workspaces: [ws()], activeWorkspaceId: 'w', paneGate: 'ready', appRoute: 'git', defaultShell: '', defaultWslDistro: '',
  } as never));
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const surfaces = () => (useStore.getState().workspaces[0].rootPane as { surfaces: { ptyId?: string; title: string }[] }).surfaces;

describe('openGithubLoginTab', () => {
  it('opens one titled tab running the sign-in and shows the panes', async () => {
    const p = openGithubLoginTab('GitHub sign-in');
    await act(async () => { release!(); });
    expect(await p).toBe(true);
    expect(create.mock.calls[0][0]).toMatchObject({ initialCommand: 'gh auth login --web', spawnKind: 'user-shell' });
    expect(surfaces().some((s) => s.ptyId === 'pty-login-1' && s.title === 'GitHub sign-in')).toBe(true);
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('a double click opens one tab', async () => {
    const a = openGithubLoginTab('t');
    const b = openGithubLoginTab('t');
    await act(async () => { release!(); });
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a pane closed during the spawn: the process is disposed and the copy fallback is asked for', async () => {
    const p = openGithubLoginTab('t');
    // The workspace's only pane goes away while pty.create is in flight.
    act(() => useStore.setState({ workspaces: [{ ...ws(), activePaneId: 'q', rootPane: { id: 'q', type: 'leaf', activeSurfaceId: '', surfaces: [] } } as unknown as Workspace] }));
    await act(async () => { release!(); });
    expect(await p).toBe(false);
    expect(dispose).toHaveBeenCalledWith('pty-login-1');
  });

  it('on Windows with a WSL default shell it does not spawn: the command is shown instead', async () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI.platform = 'win32';
    act(() => useStore.setState({ defaultShell: 'C:\\Windows\\System32\\wsl.exe' } as never));
    expect(await openGithubLoginTab('t')).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
