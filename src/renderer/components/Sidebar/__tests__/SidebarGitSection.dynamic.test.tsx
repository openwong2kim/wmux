// @vitest-environment jsdom
//
// The sidebar's Git section (2026-10-03): folding it unmounts the body, so a
// folded section reads nothing from git or the PR host; the fold and the
// height live in the store (and so in the session file).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import SidebarGitSection, { gitHeightForDrag, selectGitHeaderSummary } from '../SidebarGitSection';
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

  it('a fold and a repo switch while folded never let the old repo\'s late answer into the header', async () => {
    // The old repo answers late: it must land nowhere, not even in the header.
    let releaseOld!: () => void;
    list.mockImplementationOnce((repoPath: string) => new Promise((r) => {
      releaseOld = () => r({ ok: true, repoPath, mainPath: '/code/old-repo', worktrees: [{ path: '/code/old-repo', branch: 'main', headOid: '1', locked: null, prunable: null }] });
    }));
    act(() => root.render(createElement(SidebarGitSection)));
    await flush();
    act(() => toggle().click()); // fold while the old list is in flight
    act(() => {
      const ws = useStore.getState().workspaces[0];
      useStore.setState({ workspaces: [{ ...ws, rootPane: { ...(ws.rootPane as object), surfaces: [{ id: 's', ptyId: 'pty', title: 't', shell: 'zsh', cwd: '/code/wmux', surfaceType: 'terminal' }] } } as unknown as Workspace] });
    });
    act(() => toggle().click()); // unfold on the new repo
    await flush();
    await act(async () => { releaseOld(); });
    await flush();
    expect(container.querySelector('[data-sidebar-git-title]')?.textContent).toBe('Git · wmux');
  });

  it('folded, the header sums up the active workspace from pushed metadata only', async () => {
    act(() => {
      const ws = useStore.getState().workspaces[0];
      useStore.setState({
        sidebarGitCollapsed: true,
        workspaces: [{ ...ws, metadata: {
          gitBranch: 'feat/x',
          gitSync: { dirty: 2, ahead: 0, behind: 0, hasUpstream: true, added: 12, removed: 3 },
          pr: { number: 1742, state: 'open', checks: 'failing', url: 'u' },
        } } as unknown as Workspace],
      });
    });
    act(() => root.render(createElement(SidebarGitSection)));
    await flush();
    const line = container.querySelector('[data-sidebar-git-summary]')!;
    expect(line.textContent).toBe(' · feat/x · +12 −3 · PR #1742');
    expect(line.querySelector('[data-ci="failing"]')).not.toBeNull();
    expect(list).not.toHaveBeenCalled();

    // Out of a repo: just "Git".
    act(() => {
      const ws = useStore.getState().workspaces[0];
      useStore.setState({ workspaces: [{ ...ws, metadata: {} } as unknown as Workspace] });
    });
    expect(container.querySelector('[data-sidebar-git-summary]')).toBeNull();
    expect(container.querySelector('[data-sidebar-git-title]')?.textContent).toBe('Git');
  });

  it('summary leaves out what it does not know', () => {
    const state = { activeWorkspaceId: 'a', workspaces: [{ id: 'a', metadata: { gitBranch: 'main' } }] } as never;
    expect(selectGitHeaderSummary(state)).toEqual({ branch: 'main', added: 0, removed: 0, pr: null, checks: null });
  });

  it('the resize separator reports its value range', async () => {
    act(() => root.render(createElement(SidebarGitSection)));
    await flush();
    const sep = container.querySelector('[data-sidebar-git-resize]')!;
    expect(sep.getAttribute('aria-valuemin')).toBe(String(SIDEBAR_GIT_MIN_HEIGHT));
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(SIDEBAR_GIT_DEFAULT_HEIGHT);
    expect(Number(sep.getAttribute('aria-valuemax'))).toBeGreaterThanOrEqual(SIDEBAR_GIT_DEFAULT_HEIGHT);
  });

  it('a drag up grows the section, within its floor and the 45% share', () => {
    expect(gitHeightForDrag(280, -40, 1000)).toBe(320);
    expect(gitHeightForDrag(280, 400, 1000)).toBe(SIDEBAR_GIT_MIN_HEIGHT);
    expect(gitHeightForDrag(280, -400, 1000)).toBe(450);
  });
});
