// @vitest-environment jsdom
//
// Variant A — verifies that when GitTab renders as a central pane surface, it prefers
// the prop cwd as the repo base. Reading the active pane's cwd (e.g. '' for an empty
// util surface) would point at the wrong repo, so the path that injects the
// surface.cwd captured at creation time as a prop wins.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, type FC } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { GitTab } from '../GitTab';
import { clearGitCaches } from '../repoCache';
import type { SessionData, Workspace } from '../../../../shared/types';

// The active pane's cwd — if the prop wins, resolveRepo should receive the prop, not this value.
function makeWs(activeCwd: string): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf',
      type: 'leaf',
      activeSurfaceId: 's1',
      surfaces: [{ id: 's1', ptyId: 'pty-1', title: 't', shell: 'bash', cwd: activeCwd, surfaceType: 'terminal' }],
    },
    activePaneId: 'leaf',
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;
const resolveRepo = vi.fn((cwd: string) => Promise.resolve({ ok: true as const, repoPath: cwd }));
const list = vi.fn((repoPath: string) =>
  Promise.resolve({ ok: true, repoPath, mainPath: repoPath, worktrees: [] }));

beforeEach(() => {
  clearGitCaches();
  resolveRepo.mockClear();
  list.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { resolveRepo },
    worktree: {
      list,
      add: vi.fn(),
      remove: vi.fn(),
    },
  };
  const data: SessionData = {
    workspaces: [makeWs('/active/pane/cwd')],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => useStore.getState().loadSession(data));
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
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('GitTab — prop cwd takes precedence as the repo base', () => {
  it('resolves the repo from the prop cwd instead of the active pane cwd when present', async () => {
    act(() => root.render(createElement(GitTab as FC<{ cwd?: string }>, { cwd: '/central/surface/repo' })));
    await flush();
    expect(resolveRepo).toHaveBeenCalledWith('/central/surface/repo');
    // The repo listed is the prop's. (The active pane's cwd is still resolved
    // later, as one of the workspaces that may sit on this repo's worktrees.)
    expect(list).toHaveBeenCalledWith('/central/surface/repo');
    expect(list).not.toHaveBeenCalledWith('/active/pane/cwd');
  });

  it('falls back to the active pane cwd when there is no prop cwd (the sidebar section)', async () => {
    act(() => root.render(createElement(GitTab)));
    await flush();
    expect(resolveRepo).toHaveBeenCalledWith('/active/pane/cwd');
  });
});
