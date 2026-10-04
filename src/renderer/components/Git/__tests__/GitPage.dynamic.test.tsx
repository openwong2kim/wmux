// @vitest-environment jsdom
//
// The rail's Git page: the repo (owner/repo, a link) and its open counts on
// top, then Issues / Pull requests as a list/detail split and Worktrees (with
// the branch bar and the ship button) as its own, last tab; All repos grouping every
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
      issueList: vi.fn(async () => ({ ok: true, issues: [] })),
      issueDetail: vi.fn(async () => ({ ok: true, detail: null })),
      loginStart: vi.fn(async () => ({ ok: false, message: 'no code', fallback: true })),
      loginCancel: vi.fn(async () => undefined),
      onLoginEvent: vi.fn(() => () => undefined),
    },
  };
  act(() => useStore.setState({
    workspaces: [workspace('a', '/code/alpha'), workspace('b', '/code/alpha-wt/feat'), workspace('c', '/code/beta')],
    activeWorkspaceId: 'a', startupDirectory: '', appRoute: 'git', paneGate: 'pending',
    // Most cases read PRs; the reading-first defaults have their own test.
    gitPage: { ...initialGitPageState(), tab: 'prs' },
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
const switcher = () => container.querySelector('[data-git-repo-switcher]') as HTMLButtonElement;
/** Opens the header's repo menu and picks an entry: 'all', 'follow' or `repo:<group key>`. */
const chooseRepo = async (value: string) => {
  if (switcher().getAttribute('aria-expanded') !== 'true') act(() => switcher().click());
  await settle();
  act(() => (container.querySelector(`[data-git-repo-option="${value}"]`) as HTMLElement).click());
  await settle();
};

describe('Git page', () => {
  it('reading first: opens on Issues; tabs are Issues, Pull requests, then Worktrees; the tab is remembered', async () => {
    act(() => useStore.setState({ gitPage: initialGitPageState() }));
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect([...container.querySelectorAll('[data-git-page-tab]')].map((b) => b.getAttribute('data-git-page-tab'))).toEqual(['issues', 'prs', 'worktrees']);
    expect(tab('issues').getAttribute('aria-selected')).toBe('true');
    expect(tab('worktrees').classList.contains('wmux-git-tab-aside')).toBe(true);
    act(() => tab('prs').click());
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(tab('prs').getAttribute('aria-selected')).toBe('true');
  });

  it('the header leads with owner/repo as a link to it, and the open counts', async () => {
    const issues = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1, title: `i${i}`, state: 'open', author: 'a', labels: [], assignees: [], updatedAt: '2026-10-01T00:00:00Z',
      url: `https://github.com/o/alpha/issues/${i + 1}`, comments: 0,
    }));
    const api = (window as unknown as { electronAPI: { github: { issueList: ReturnType<typeof vi.fn> } } }).electronAPI;
    api.github.issueList.mockResolvedValue({ ok: true, issues });
    act(() => useStore.setState({ gitPage: { ...initialGitPageState(), tab: 'issues' } }));
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('h1')?.textContent).toBe('Git');
    expect(container.querySelector('[data-git-page-repo]')?.textContent).toBe('o/alpha');
    // Truncated only by real overflow; the full owner/repo is always in the tooltip.
    expect(container.querySelector('[data-git-page-repo]')?.getAttribute('title')).toBe('o/alpha');
    const link = container.querySelector('[data-git-page-repo-link]') as HTMLAnchorElement;
    expect(link.getAttribute('aria-label')).toBe('Open o/alpha on GitHub');
    expect(link.getAttribute('href')).toBe('https://github.com/o/alpha');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    act(() => link.click());
    expect(open).toHaveBeenCalledWith('https://github.com/o/alpha', '_blank');
    open.mockRestore();
    // Both counts on a first visit to Issues: the PR count from one read of
    // that list (never polled); a full read says 100+.
    expect(container.querySelector('[data-git-page-counts]')?.textContent).toBe('100+ issues · 1 pull request');
    expect(prList).toHaveBeenCalledTimes(1);
    expect(prList).toHaveBeenCalledWith('/code/alpha', false);
    // A filter on: the issue count still says all open issues.
    act(() => useStore.getState().setGitPage({ issueFilter: { kind: 'assigned' } }));
    await settle();
    expect(container.querySelector('[data-git-page-counts]')?.textContent).toBe('100+ issues · 1 pull request');
    // All repos keeps the name and drops the counts.
    await chooseRepo('all');
    expect(container.querySelector('[data-git-page-repo]')?.textContent).toBe('All repos');
    expect(container.querySelector('[data-git-page-counts]')).toBeNull();
  });

  it('a repo without a GitHub remote is named by its folder, without a link', async () => {
    act(() => useStore.setState({ activeWorkspaceId: 'c' }));
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-page-repo]')?.textContent).toBe('beta');
    expect(container.querySelector('[data-git-page-repo-link]')).toBeNull();
  });

  it('nothing about branches above the lists; the branch bar and ship button live in Worktrees', async () => {
    const list = (window as unknown as { electronAPI: { worktree: { list: ReturnType<typeof vi.fn> } } }).electronAPI.worktree.list;
    act(() => root.render(createElement(GitPage)));
    await settle();
    // The lists load with the Worktrees tab never opened.
    expect(prList).toHaveBeenCalledWith('/code/alpha', false);
    expect(container.querySelector('[data-pr-row="7"]')).not.toBeNull();
    expect(container.querySelector('[data-git-current-branch]')).toBeNull();
    expect(container.querySelector('[data-git-ship-primary]')).toBeNull();
    // One worktree list resolved the repo (the cached resolver), nothing more.
    expect(list).toHaveBeenCalledTimes(1);
    act(() => tab('worktrees').click());
    await settle();
    const wt = container.querySelector('[data-git-worktrees-tab]')!;
    expect(wt.firstElementChild!.querySelector('[data-git-current-branch]')?.textContent).toContain('main');
    expect(wt.querySelector('[data-git-ship-primary]')).not.toBeNull();
  });

  it('This repo: a list/detail split; worktrees live on their own tab', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-page-repo]')?.textContent).toBe('o/alpha');
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
    await chooseRepo('all');
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(tab('issues').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-git-page-repo]')?.textContent).toBe('All repos');
    expect(localStorage.getItem('wmux.git.workView')).toBe('issues');
  });

  it('Go to terminal returns to the panes', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => tab('worktrees').click());
    await settle();
    act(() => (container.querySelector('[data-git-go-terminal]') as HTMLButtonElement).click());
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('All repos: one group per repo, the active repo first; Worktrees keeps the branch bar on top', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    await chooseRepo('all');
    const groups = [...container.querySelectorAll('[data-git-repo-group]')].map((g) => g.getAttribute('data-git-repo-group'));
    expect(groups).toEqual(['alpha', 'beta']);
    expect(container.querySelector('[data-git-repo-group="alpha"]')?.textContent).toContain('2 workspace');
    // The active repo's list is open; another repo's waits to be opened.
    expect(container.querySelector('[data-git-repo-group="alpha"] [data-pr-section]')).not.toBeNull();
    expect(container.querySelector('[data-git-repo-group="beta"] [data-pr-section]')).toBeNull();
    act(() => tab('worktrees').click());
    await settle();
    expect(container.querySelector('[data-git-worktrees-tab] [data-git-current-branch]')).not.toBeNull();
    // Only the active repo's group marks a row with the dot.
    expect(container.querySelectorAll('[data-git-repo-group="beta"] [data-current="true"]').length).toBe(0);
    expect(container.querySelectorAll('[data-git-repo-group="alpha"] [data-current="true"]').length).toBe(1);
  });

  it('signed out of GitHub: the whole page is the connect card, falling back to the terminal sign-in', async () => {
    prList.mockResolvedValue({ ok: false, code: 'unauthenticated', message: 'GitHub CLI is not authenticated', provider: 'github' });
    act(() => root.render(createElement(GitPage)));
    await settle();
    const connect = container.querySelector('[data-gh-connect]')!;
    expect(connect).not.toBeNull();
    expect(container.querySelector('[data-git-page-tab]')).toBeNull();
    // gh gave no code: the dialog offers the terminal sign-in instead.
    await act(async () => { (connect.querySelector('[data-gh-connect-button]') as HTMLButtonElement).click(); });
    await settle();
    expect(document.body.querySelector('[data-testid="gh-connect-dialog"]')).not.toBeNull();
    // Check again re-asks past the cache.
    prList.mockClear();
    await act(async () => { (container.querySelector('[data-gh-connect-recheck]') as HTMLButtonElement).click(); });
    expect(prList).toHaveBeenCalledWith('/code/alpha', true);
  });

  it('signed in from the connect card: the lists read again, forced, once gh answers', async () => {
    prList.mockResolvedValue({ ok: false, code: 'unauthenticated', message: 'GitHub CLI is not authenticated', provider: 'github' });
    act(() => useStore.setState({ gitPage: { ...initialGitPageState(), tab: 'issues' } }));
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-gh-connect]')).not.toBeNull();
    const issueList = (window as unknown as { electronAPI: { github: { issueList: ReturnType<typeof vi.fn> } } }).electronAPI.github.issueList;
    prList.mockResolvedValue({ ok: true, prs: [] });
    issueList.mockClear();
    await act(async () => { (container.querySelector('[data-gh-connect-recheck]') as HTMLButtonElement).click(); });
    await settle();
    expect(container.querySelector('[data-gh-connect]')).toBeNull();
    expect(issueList.mock.calls.some((c) => c[2] === true)).toBe(true);
  });

  it('a GitLab remote keeps its own message instead of Connect GitHub', async () => {
    prList.mockResolvedValue({ ok: false, code: 'unauthenticated', message: 'GitLab CLI is not authenticated', provider: 'gitlab' });
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-gh-connect]')).toBeNull();
    expect(container.textContent).toContain('GitLab CLI is not authenticated');
  });

  it('the card\'s Diff opens the diff on that workspace and returns to the panes', async () => {
    act(() => root.render(createElement(GitPage)));
    await settle();
    act(() => tab('worktrees').click());
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
    await chooseRepo('all');
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
    await chooseRepo('all');
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
    expect(container.querySelector('[data-gh-connect-install]')).not.toBeNull();
    expect(container.querySelector('[data-gh-connect-button]')).toBeNull();
    expect(container.querySelector('[data-gh-connect-recheck]')).not.toBeNull();
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
    act(() => tab('worktrees').click());
    await settle();
    const ship = () => container.querySelector('[data-git-ship-primary]') as HTMLButtonElement;
    expect(ship().textContent).toBe('Commit');
    expect(ship().disabled).toBe(false);
    act(() => useStore.getState().setGitMerge('/code/alpha', true));
    await settle();
    expect(ship().disabled).toBe(true);
    expect(container.querySelector('[data-git-ship-reason]')?.textContent).toBe('A merge session is running');
  });

  describe('the repo switcher', () => {
    const options = () => [...container.querySelectorAll('[data-git-repo-option]')].map((o) => o.getAttribute('data-git-repo-option'));
    const repoText = () => container.querySelector('[data-git-page-repo]')?.textContent;

    it('lists All repos first, the repos grouped by remote with their known counts, then Follow active workspace', async () => {
      act(() => root.render(createElement(GitPage)));
      await settle();
      expect(switcher().getAttribute('aria-haspopup')).toBe('listbox');
      expect(container.querySelector('[data-testid="git-scope"]')).toBeNull();
      act(() => switcher().click());
      await settle();
      expect(switcher().getAttribute('aria-expanded')).toBe('true');
      expect(options()).toEqual(['all', 'repo:github.com/o/alpha', 'repo:path:/code/beta', 'follow']);
      const alpha = container.querySelector('[data-git-repo-option="repo:github.com/o/alpha"]')!;
      expect(alpha.textContent).toContain('o/alpha');
      expect(alpha.textContent).toContain('1 pull request');
      expect(container.querySelector('[data-git-repo-option="follow"]')?.getAttribute('aria-selected')).toBe('true');
      // Counts are never read just for the menu: beta's PR list was not read.
      expect(prList.mock.calls.some((c) => c[0] === '/code/beta')).toBe(false);
    });

    it('a picked repo shows its lists and stays when the active workspace changes; Follow goes back', async () => {
      act(() => root.render(createElement(GitPage)));
      await settle();
      await chooseRepo('repo:path:/code/beta');
      expect(repoText()).toBe('beta');
      expect(prList.mock.calls.some((c) => c[0] === '/code/beta')).toBe(true);
      expect(container.querySelector('[data-pr-row="7"]')).toBeNull();
      act(() => useStore.setState({ activeWorkspaceId: 'b' }));
      await settle();
      expect(repoText()).toBe('beta');
      await chooseRepo('follow');
      expect(repoText()).toBe('o/alpha');
      expect(useStore.getState().gitPage.pick).toBeNull();
    });

    it('the pick is kept across a remount and a restart', async () => {
      act(() => root.render(createElement(GitPage)));
      await settle();
      await chooseRepo('repo:path:/code/beta');
      expect(localStorage.getItem('wmux.git.repo')).toBe('repo:path:/code/beta');
      act(() => root.unmount());
      // A restart: the UI store starts over from what was persisted.
      act(() => useStore.setState({ gitPage: initialGitPageState() }));
      root = createRoot(container);
      act(() => root.render(createElement(GitPage)));
      await settle();
      expect(repoText()).toBe('beta');
    });

    it('a picked repo with no open workspace left falls back to following, quietly', async () => {
      act(() => useStore.setState({ gitPage: { ...initialGitPageState(), tab: 'prs', pick: 'github.com/o/gone' } }));
      act(() => root.render(createElement(GitPage)));
      await settle();
      expect(repoText()).toBe('o/alpha');
      expect(container.querySelector('[data-git-pick-missing]')).not.toBeNull();
    });

    it('keyboard: type to filter, arrows move, Enter picks, Esc closes and returns focus', async () => {
      act(() => root.render(createElement(GitPage)));
      await settle();
      act(() => switcher().click());
      await settle();
      const input = container.querySelector('[data-git-repo-filter]') as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'bet');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(options()).toEqual(['repo:path:/code/beta']);
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      await settle();
      expect(repoText()).toBe('beta');
      expect(document.activeElement).toBe(switcher());
      act(() => switcher().click());
      await settle();
      const box = container.querySelector('[data-git-repo-filter]') as HTMLInputElement;
      const activeId = () => box.getAttribute('aria-activedescendant');
      const activeValue = () => document.getElementById(activeId()!)?.getAttribute('data-git-repo-option');
      expect(activeValue()).toBe('repo:path:/code/beta');
      act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      expect(activeValue()).toBe('follow');
      act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      expect(activeValue()).toBe('all');
      act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
      expect(activeValue()).toBe('follow');
      act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(container.querySelector('[data-git-repo-menu]')).toBeNull();
      expect(document.activeElement).toBe(switcher());
      expect(repoText()).toBe('beta');
    });

    it('the hand-off owner is a workspace in the picked repo, not the active one', async () => {
      const api = (window as unknown as { electronAPI: { github: { issueList: ReturnType<typeof vi.fn>; issueDetail: ReturnType<typeof vi.fn> } } }).electronAPI;
      const issue = { number: 3, title: 'Beta bug', state: 'open', author: 'a', labels: [], assignees: [], updatedAt: '2026-10-01T00:00:00Z', url: 'https://github.com/o/beta/issues/3', comments: 0 };
      api.github.issueList.mockImplementation(async (p: string) => ({ ok: true, issues: p === '/code/beta' ? [issue] : [] }));
      act(() => useStore.setState({ gitPage: { ...initialGitPageState(), tab: 'issues' } }));
      act(() => root.render(createElement(GitPage)));
      await settle();
      await chooseRepo('repo:path:/code/beta');
      act(() => (container.querySelector('[data-issue-row="3"] button') as HTMLButtonElement).click());
      await settle();
      act(() => (container.querySelector('[data-git-start-worktree]') as HTMLButtonElement).click());
      expect(useStore.getState().gitHandoff?.repo).toEqual({ repoPath: '/code/beta', workspaceId: 'c' });
    });
  });
});
