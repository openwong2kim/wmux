// @vitest-environment jsdom
//
// The rail's Git page: This repo by default (card, Pull requests, Worktrees),
// All repos grouping every open workspace by repo, the not-connected state
// when gh is missing or signed out, and Diff returning to the panes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import GitPage from '../GitPage';
import { ROW_STATS_DEBOUNCE_MS } from '../GitTab';
import { useStore } from '../../../stores';
import type { Workspace, Pane } from '../../../../shared/types';

function workspace(id: string, cwd: string, extra: Partial<Workspace> = {}): Workspace {
  return {
    id, name: id,
    rootPane: { id: `p-${id}`, type: 'leaf', activeSurfaceId: `s-${id}`, surfaces: [{ id: `s-${id}`, ptyId: `pty-${id}`, title: id, shell: 'zsh', cwd, surfaceType: 'terminal' }] },
    activePaneId: `p-${id}`,
    ...extra,
  } as Workspace;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, ROW_STATS_DEBOUNCE_MS + 20)); });
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
};

const repos: Record<string, { mainPath: string; worktrees: { path: string; branch: string }[] }> = {
  '/code/alpha': { mainPath: '/code/alpha', worktrees: [{ path: '/code/alpha', branch: 'main' }, { path: '/code/alpha-wt/feat', branch: 'feat' }] },
  '/code/alpha-wt/feat': { mainPath: '/code/alpha', worktrees: [{ path: '/code/alpha', branch: 'main' }, { path: '/code/alpha-wt/feat', branch: 'feat' }] },
  '/code/beta': { mainPath: '/code/beta', worktrees: [{ path: '/code/beta', branch: 'main' }] },
};

let container: HTMLDivElement;
let root: Root;
let prList: ReturnType<typeof vi.fn>;

beforeEach(() => {
  prList = vi.fn(async () => ({ ok: true, prs: [] }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
    diff: {
      resolveRepo: vi.fn(async (cwd: string) => (repos[cwd] ? { ok: true, repoPath: cwd } : { ok: false })),
      read: vi.fn(async (p: string) => ({ ok: true, files: [], numstat: [], snapshot: { targetRepoPath: p, targetBranch: 'x', targetHeadOid: 'h', targetDirtyFiles: [] }, truncated: [], unsupported: [] })),
    },
    worktree: {
      list: vi.fn(async (p: string) => {
        const r = repos[p];
        return r
          ? { ok: true, repoPath: p, mainPath: r.mainPath, worktrees: r.worktrees.map((w) => ({ ...w, headOid: '1', locked: null, prunable: null })) }
          : { ok: false, error: 'no' };
      }),
      add: vi.fn(), remove: vi.fn(),
    },
    github: { prList, prDetail: vi.fn() },
  };
  act(() => useStore.setState({
    workspaces: [workspace('a', '/code/alpha'), workspace('b', '/code/alpha-wt/feat'), workspace('c', '/code/beta')],
    activeWorkspaceId: 'a', startupDirectory: '', appRoute: 'git', paneGate: 'pending',
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const scopeOption = (label: string) => [...container.querySelectorAll<HTMLElement>('[data-testid="git-scope"] [role="radio"]')].find((b) => b.textContent === label)!;

describe('Git page', () => {
  it('This repo: the card, then this repo\'s Pull requests and Worktrees', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-page-repo]')?.textContent).toBe('alpha');
    expect(container.querySelector('[data-git-current-branch]')?.textContent).toContain('main');
    expect(scopeOption('This repo').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-pr-section]')).not.toBeNull();
    expect(container.querySelectorAll('[data-git-worktree-row]').length).toBe(2);
    expect(container.querySelector('[data-git-all-repos]')).toBeNull();
  });

  it('All repos: one group per repo, the active repo first, the card kept on top', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => scopeOption('All repos').click());
    await settle();
    const groups = [...container.querySelectorAll('[data-git-repo-group]')].map((g) => g.getAttribute('data-git-repo-group'));
    expect(groups).toEqual(['alpha', 'beta']);
    expect(container.querySelector('[data-git-repo-group="alpha"]')?.textContent).toContain('2 workspace');
    expect(container.querySelector('[data-git-current-branch]')).not.toBeNull();
    // Only the active repo's group marks a row with the dot.
    expect(container.querySelectorAll('[data-git-repo-group="beta"] [data-current="true"]').length).toBe(0);
    expect(container.querySelectorAll('[data-git-repo-group="alpha"] [data-current="true"]').length).toBe(1);
  });

  it('signed out of GitHub: Connect GitHub, falling back to the command to copy', async () => {
    prList.mockResolvedValue({ ok: false, code: 'unauthenticated', message: 'GitHub CLI is not authenticated', provider: 'github' });
    act(() => root.render(createElement(GitPage)));
    await settle();
    const connect = container.querySelector('[data-git-connect]')!;
    expect(connect).not.toBeNull();
    // paneGate is not ready in this test, so no tab can open: the command shows instead.
    await act(async () => { (connect.querySelector('[data-git-connect-button]') as HTMLButtonElement).click(); });
    await settle();
    expect(container.querySelector('[data-git-connect-command]')?.textContent).toContain('gh auth login --web');
    // Check again re-asks past the cache.
    prList.mockClear();
    await act(async () => { (container.querySelector('[data-git-connect-recheck]') as HTMLButtonElement).click(); });
    expect(prList).toHaveBeenCalledWith('/code/alpha', true);
  });

  it('a GitLab remote keeps its own message instead of Connect GitHub', async () => {
    prList.mockResolvedValue({ ok: false, code: 'unauthenticated', message: 'GitLab CLI is not authenticated', provider: 'gitlab' });
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-connect]')).toBeNull();
    expect(container.textContent).toContain('GitLab CLI is not authenticated');
  });

  it('the card\'s Diff opens the diff on that workspace and returns to the panes', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => (container.querySelector('[data-git-diff-current]') as HTMLButtonElement).click());
    const st = useStore.getState();
    expect(st.appRoute).toBe('workspaces');
    const surfaces = (st.workspaces.find((w) => w.id === 'a')!.rootPane as Extract<Pane, { type: 'leaf' }>).surfaces;
    expect(surfaces.some((s) => s.surfaceType === 'diff')).toBe(true);
  });
});
