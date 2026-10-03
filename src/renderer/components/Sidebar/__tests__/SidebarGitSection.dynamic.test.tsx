// @vitest-environment jsdom
//
// The sidebar's Git section (2026-10-03): folding it unmounts the body, so a
// folded section reads nothing from git or the PR host; the fold and the
// height live in the store (and so in the session file).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import SidebarGitSection, { gitHeightForDrag } from '../SidebarGitSection';
import { SIDEBAR_GIT_DEFAULT_HEIGHT, SIDEBAR_GIT_MIN_HEIGHT } from '../../../utils/sidebarLayout';
import type { Workspace } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;
const resolveRepo = vi.fn(async (cwd: string) => ({ ok: true as const, repoPath: cwd }));
const list = vi.fn(async (repoPath: string) => ({
  ok: true,
  repoPath,
  mainPath: '/code/wmux',
  worktrees: [{ path: '/code/wmux', branch: 'main', headOid: '1', locked: null, prunable: null }],
}));

const flush = async () => {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  resolveRepo.mockClear();
  list.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { resolveRepo },
    worktree: { list, add: vi.fn(), remove: vi.fn() },
  };
  act(() => {
    useStore.setState({
      workspaces: [{
        id: 'ws-1',
        name: 'One',
        rootPane: { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty', title: 't', shell: 'zsh', cwd: '/code/wmux', surfaceType: 'terminal' }] },
        activePaneId: 'p',
      } as unknown as Workspace],
      activeWorkspaceId: 'ws-1',
      startupDirectory: '',
      sidebarGitCollapsed: false,
      sidebarGitHeight: SIDEBAR_GIT_DEFAULT_HEIGHT,
    });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const toggle = () => container.querySelector('[data-sidebar-git-toggle]') as HTMLButtonElement;

describe('SidebarGitSection', () => {
  it('names the main worktree\'s repo in its header once the body has read it', async () => {
    act(() => root.render(createElement(SidebarGitSection)));
    await flush();
    expect(container.querySelector('[data-sidebar-git-title]')?.textContent).toBe('Git · wmux');
    expect(container.querySelector('[data-git-tab]')).not.toBeNull();
  });

  it('folded, it mounts no body and reads nothing; the fold is stored', async () => {
    act(() => useStore.setState({ sidebarGitCollapsed: true }));
    act(() => root.render(createElement(SidebarGitSection)));
    await flush();
    expect(container.querySelector('[data-git-tab]')).toBeNull();
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    act(() => toggle().click());
    await flush();
    expect(useStore.getState().sidebarGitCollapsed).toBe(false);
    expect(container.querySelector('[data-git-tab]')).not.toBeNull();
    expect(list).toHaveBeenCalled();
  });

  it('a drag up grows the section, within its floor and the 45% share', () => {
    expect(gitHeightForDrag(280, -40, 1000)).toBe(320);
    expect(gitHeightForDrag(280, 400, 1000)).toBe(SIDEBAR_GIT_MIN_HEIGHT);
    expect(gitHeightForDrag(280, -400, 1000)).toBe(450);
  });
});
