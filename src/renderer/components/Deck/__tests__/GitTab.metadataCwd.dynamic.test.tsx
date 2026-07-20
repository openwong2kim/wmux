// @vitest-environment jsdom
//
// Regression (2026-07-21, live-observed): an agent TUI pane's surface.cwd is the
// SHELL's directory (e.g. the home dir the shell was spawned in), while the
// agent's real working repo is only in workspace metadata.cwd (reported by the
// hook bridge — the same value the sidebar branch badge already trusts). The
// Git tab used to resolve the repo from surface.cwd only and showed "not a git
// repository" even though the sidebar showed the branch. It must fall back to
// metadata.cwd when the surface cwd does not resolve.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { GitTab } from '../GitTab';
import type { SessionData, Workspace } from '../../../../shared/types';

const HOME = '/home/me'; // shell's cwd — NOT a repo
const REPO = '/home/me/proj'; // agent's cwd from metadata — the repo

function makeWs(surfaceCwd: string, metadataCwd: string): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf',
      type: 'leaf',
      activeSurfaceId: 's1',
      surfaces: [{ id: 's1', ptyId: 'pty-1', title: 't', shell: 'bash', cwd: surfaceCwd, surfaceType: 'terminal' }],
    },
    activePaneId: 'leaf',
    metadata: { cwd: metadataCwd },
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;
// Only the repo path resolves; the shell home does not.
const resolveRepo = vi.fn((cwd: string) =>
  Promise.resolve(cwd === REPO ? { ok: true as const, repoPath: REPO } : { ok: false as const }),
);

beforeEach(() => {
  resolveRepo.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { resolveRepo },
    worktree: {
      list: (repoPath: string) =>
        Promise.resolve({
          ok: true,
          repoPath,
          mainPath: repoPath,
          worktrees: [{ path: repoPath, branch: 'main', headOid: '0000000', locked: null, prunable: null }],
        }),
      add: vi.fn(),
      remove: vi.fn(),
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

describe('GitTab — metadata.cwd fallback (agent pane whose shell sits outside the repo)', () => {
  it('resolves the repo via metadata.cwd when the surface cwd is not a repo', async () => {
    const data: SessionData = {
      workspaces: [makeWs(HOME, REPO)],
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
    };
    act(() => useStore.getState().loadSession(data));
    act(() => root.render(createElement(GitTab)));
    await flush();

    // Tried the shell cwd first (per-pane behavior preserved), then fell back.
    expect(resolveRepo).toHaveBeenCalledWith(HOME);
    expect(resolveRepo).toHaveBeenCalledWith(REPO);
    // The worktree roster rendered — no "not a git repository" placeholder.
    expect(container.querySelector('[data-git-worktree-list]')?.textContent).toContain('main');
  });

  it('a corrupted relative surface cwd (the "path" incident) is skipped entirely', async () => {
    const data: SessionData = {
      workspaces: [makeWs('path', REPO)],
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
    };
    act(() => useStore.getState().loadSession(data));
    act(() => root.render(createElement(GitTab)));
    await flush();

    // The implausible token never reaches resolveRepo; metadata.cwd wins.
    expect(resolveRepo).not.toHaveBeenCalledWith('path');
    expect(resolveRepo).toHaveBeenCalledWith(REPO);
    expect(container.querySelector('[data-git-worktree-list]')?.textContent).toContain('main');
  });
});
