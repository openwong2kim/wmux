// @vitest-environment jsdom
//
// The rail's Git page: the branch bar, then Pull requests / Issues as a
// list/detail split and Worktrees as its own tab; All repos grouping every
// open workspace by repo; the not-connected state when gh is missing or
// signed out; Diff and Go to terminal returning to the panes; and the page's
// view state (scope, tab, selection) surviving a remount.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import GitPage from '../GitPage';
import { clearGitCaches } from '../repoCache';
import { ROW_STATS_DEBOUNCE_MS } from '../GitTab';
import { useStore } from '../../../stores';
import { initialGitPageState } from '../gitPageState';
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
  '/tmp/alpha-clone': { mainPath: '/tmp/alpha-clone', worktrees: [{ path: '/tmp/alpha-clone', branch: 'fix' }] },
};
const remoteOf: Record<string, string | null> = { '/code/alpha': 'github.com/o/alpha', '/tmp/alpha-clone': 'github.com/o/alpha', '/code/beta': null };

let container: HTMLDivElement;
let root: Root;
let prList: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearGitCaches();
  prList = vi.fn(async (p: string) => ({ ok: true, prs: p === '/code/alpha' ? [PR] : [] }));
  try { localStorage.clear(); } catch { /* none */ }
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
    github: {
      prList,
      prDetail: vi.fn(async () => ({ ok: true, detail: { number: 7, comments: [] } })),
      shipStatus: vi.fn(async () => ({
        ok: true,
        status: {
          branch: 'main', head: 'e'.repeat(40), detached: false, upstream: 'origin/main', ahead: 0, behind: 0, dirty: 2,
          conflicts: 0, inProgress: false, defaultBranch: 'main', headSubject: 's', pr: null,
        },
      })),
      shipCommit: vi.fn(), shipPush: vi.fn(), shipCreatePr: vi.fn(),
      repoKey: vi.fn(async (p: string) => ({ key: remoteOf[p] ?? null })),
    },
  };
  act(() => useStore.setState({
    workspaces: [workspace('a', '/code/alpha'), workspace('b', '/code/alpha-wt/feat'), workspace('c', '/code/beta')],
    activeWorkspaceId: 'a', startupDirectory: '', appRoute: 'git', paneGate: 'pending',
    gitPage: initialGitPageState(),
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

const PR = { number: 7, title: 'feat: add x', state: 'open', author: 'me', headRefName: 'feat', updatedAt: '2026-10-01T00:00:00Z', url: 'https://github.com/o/alpha/pull/7', reviewDecision: 'APPROVED', checks: 'passing', mergeable: 'MERGEABLE' };
const tab = (name: string) => container.querySelector(`[data-git-page-tab="${name}"]`) as HTMLButtonElement;
const scopeOption = (label: string) => [...container.querySelectorAll<HTMLElement>('[data-testid="git-scope"] [role="radio"]')].find((b) => b.textContent === label)!;

describe('Git page', () => {
  it('This repo: the branch bar, then a list/detail split; worktrees live on their own tab', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-page-repo]')?.textContent).toBe('alpha');
    expect(container.querySelector('[data-git-current-branch]')?.textContent).toContain('main');
    expect(scopeOption('This repo').getAttribute('aria-checked')).toBe('true');
    expect(tab('prs').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-git-listpane] [data-pr-section]')).not.toBeNull();
    expect(container.querySelector('[data-git-detail-empty]')).not.toBeNull();
    expect(container.querySelectorAll('[data-git-worktree-row]').length).toBe(0);
    act(() => tab('worktrees').click());
    await settle();
    expect(container.querySelectorAll('[data-git-worktrees-tab] [data-git-worktree-row]').length).toBe(2);
    expect(container.querySelector('[data-git-split]')).toBeNull();
  });

  it('a selected PR opens in the detail pane under a sticky header, and stays selected after leaving the page', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    const row = container.querySelector('[data-pr-row="7"] button') as HTMLButtonElement;
    expect(row.textContent).toContain('Approved, mergeable');
    act(() => row.click());
    await settle();
    expect(row.getAttribute('aria-current')).toBe('true');
    const head = container.querySelector('[data-git-detailpane] [data-git-detail-head]')!;
    expect(head.textContent).toContain('feat: add x');
    expect(head.textContent).toContain('#7');
    expect(head.textContent).toContain('alpha');
    expect(head.querySelector('[data-git-detail-slot]')).not.toBeNull();
    // Leave the page and come back: the selection is still there.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-pr-row="7"] button')?.getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('[data-git-detail-head]')?.textContent).toContain('feat: add x');
  });

  it('the scope and tab survive a remount, and the tab is kept per viewer', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => tab('issues').click());
    act(() => scopeOption('All repos').click());
    await settle();
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(tab('issues').getAttribute('aria-selected')).toBe('true');
    expect(scopeOption('All repos').getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem('wmux.git.workView')).toBe('issues');
  });

  it('Go to terminal returns to the panes', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => (container.querySelector('[data-git-go-terminal]') as HTMLButtonElement).click());
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('All repos: one group per repo, the active repo first, the bar kept on top', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => scopeOption('All repos').click());
    await settle();
    const groups = [...container.querySelectorAll('[data-git-repo-group]')].map((g) => g.getAttribute('data-git-repo-group'));
    expect(groups).toEqual(['alpha', 'beta']);
    expect(container.querySelector('[data-git-repo-group="alpha"]')?.textContent).toContain('2 workspace');
    expect(container.querySelector('[data-git-current-branch]')).not.toBeNull();
    // The active repo's list is open; another repo's waits to be opened.
    expect(container.querySelector('[data-git-repo-group="alpha"] [data-pr-section]')).not.toBeNull();
    expect(container.querySelector('[data-git-repo-group="beta"] [data-pr-section]')).toBeNull();
    act(() => tab('worktrees').click());
    await settle();
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

  it('All repos folds two clones of one remote into one group: one PR list, each clone\'s worktrees labelled', async () => {
    act(() => useStore.setState({
      workspaces: [workspace('a', '/code/alpha'), workspace('b', '/code/alpha-wt/feat'), workspace('c', '/code/beta'), workspace('d', '/tmp/alpha-clone')],
    }));
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => scopeOption('All repos').click());
    await settle();
    const groups = [...container.querySelectorAll('[data-git-repo-group]')].map((g) => g.getAttribute('data-git-repo-group'));
    expect(groups).toEqual(['alpha', 'beta']);
    expect(container.querySelectorAll('[data-git-repo-group="alpha"] [data-pr-section]').length).toBe(1);
    expect(container.querySelector('[data-git-repo-group="alpha"]')!.textContent).toContain('3 workspace');
    act(() => tab('worktrees').click());
    await settle();
    const alpha = container.querySelector('[data-git-repo-group="alpha"]')!;
    expect([...alpha.querySelectorAll('[data-git-checkout]')].map((c) => c.getAttribute('data-git-checkout'))).toEqual(['alpha', 'alpha-clone']);
    // The other repo's PR list waits to be opened.
    const prCallsFor = (path: string) => prList.mock.calls.filter((c) => c[0] === path).length;
    expect(prCallsFor('/code/beta')).toBe(0);
  });

  it('All repos follows a workspace that moves to another repo', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => scopeOption('All repos').click());
    await settle();
    expect(container.querySelector('[data-git-repo-group="beta"]')?.textContent).toContain('1 workspace');
    // Workspace c's pane cds from beta into alpha.
    act(() => useStore.setState({ workspaces: [workspace('a', '/code/alpha'), workspace('b', '/code/alpha-wt/feat'), workspace('c', '/code/alpha')] }));
    await settle();
    expect(container.querySelector('[data-git-repo-group="beta"]')).toBeNull();
  });

  it('gh not installed: install guidance and Check again, no Connect', async () => {
    prList.mockResolvedValue({ ok: false, code: 'cli-missing', message: 'GitHub CLI (gh) is not installed', provider: 'github' });
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-install]')).not.toBeNull();
    expect(container.querySelector('[data-git-connect-button]')).toBeNull();
    expect(container.querySelector('[data-git-connect-recheck]')).not.toBeNull();
  });

  it('reads nothing while the window is hidden, and loads when it is shown', async () => {
    const hidden = { value: true };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden.value });
    try {
      const list = (window as unknown as { electronAPI: { worktree: { list: ReturnType<typeof vi.fn> } } }).electronAPI.worktree.list;
      act(() => root.render(createElement(GitPage)));
      await settle();
      expect(list).not.toHaveBeenCalled();
      hidden.value = false;
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await settle();
      expect(list).toHaveBeenCalled();
      act(() => tab('worktrees').click());
      await settle();
      expect(container.querySelectorAll('[data-git-worktree-row]').length).toBe(2);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it('This repo shows a selection only while it belongs to the current repo', async () => {
    act(() => useStore.setState({ gitPage: { ...initialGitPageState(), selected: { kind: 'pr', repoPath: '/code/beta', number: 7 } } }));
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-detail-empty]')).not.toBeNull();
    expect(container.querySelector('[data-git-detail-head]')).toBeNull();
  });

  it('a new selection starts at the top of the detail', async () => {
    prList.mockImplementation(async (p: string) => ({ ok: true, prs: p === '/code/alpha' ? [PR, { ...PR, number: 8, title: 'second' }] : [] }));
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => (container.querySelector('[data-pr-row="7"] button') as HTMLButtonElement).click());
    await settle();
    const pane = container.querySelector('[data-git-detailpane]') as HTMLElement;
    pane.scrollTop = 400;
    act(() => (container.querySelector('[data-pr-row="8"] button') as HTMLButtonElement).click());
    await settle();
    expect(pane.scrollTop).toBe(0);
  });

  it('a merge session started from the Worktrees tab holds the branch bar\'s ship button', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    const ship = () => container.querySelector('[data-git-ship-primary]') as HTMLButtonElement;
    expect(ship().textContent).toBe('Commit');
    expect(ship().disabled).toBe(false);
    act(() => useStore.getState().setGitMerge('/code/alpha', true));
    await settle();
    expect(ship().disabled).toBe(true);
    expect(container.querySelector('[data-git-ship-reason]')?.textContent).toBe('A merge session is running');
  });
});
