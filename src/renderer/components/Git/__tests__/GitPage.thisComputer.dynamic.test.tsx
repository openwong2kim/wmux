// @vitest-environment jsdom
//
// PC rail, "This computer only" on the Git page: with another computer
// selected, the header names its files when following the active workspace,
// a computer not named yet gets no line (never "no repository"), and the
// active workspace's branch card is gone in every scope, so no remote note
// sits above this computer's worktrees.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import GitPage from '../GitPage';
import { clearGitCaches } from '../repoCache';
import { ROW_STATS_DEBOUNCE_MS } from '../GitTab';
import { useStore } from '../../../stores';
import { initialGitPageState } from '../gitPageState';
import type { Workspace } from '../../../../shared/types';
import { DEFAULT_PC_RAIL_PERSISTED } from '../../../../shared/pcRail';

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
  prList = vi.fn(async () => ({ ok: true, prs: [] }));
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

const worktreesTab = () => container.querySelector('[data-git-page-tab="worktrees"]') as HTMLButtonElement;
const selectPc = (id: string, hosts = [{ id: 'h1', label: 'office-mac' }]) =>
  act(() => useStore.setState({ pcRailHosts: hosts, pcRail: { ...DEFAULT_PC_RAIL_PERSISTED, activePcId: id } }));

afterEach(() => {
  useStore.setState({ pcRailHosts: [], pcRail: { ...DEFAULT_PC_RAIL_PERSISTED } });
});

describe('Git page with another computer selected', () => {
  it('this computer: the branch card and the worktrees show, no files line', async () => {
    act(() => root.render(createElement(GitPage)));
    act(() => worktreesTab().click());
    await settle();
    expect(container.querySelector('[data-git-current-branch]')).not.toBeNull();
    expect(container.querySelector('[data-git-worktree-list]')).not.toBeNull();
    expect(container.querySelector('[data-git-remote-files]')).toBeNull();
  });

  it('following: one header line names the computer, and nothing of the active workspace is read', async () => {
    selectPc('h1');
    act(() => root.render(createElement(GitPage)));
    act(() => worktreesTab().click());
    await settle();
    expect([...container.querySelectorAll('[data-git-remote-files]')].map((e) => e.textContent)).toEqual(["Files on office-mac aren't shown yet"]);
    expect(container.querySelector('[data-git-current-branch]')).toBeNull();
    expect(container.querySelector('[data-git-worktree-list]')).toBeNull();
    expect(container.querySelector('[data-git-no-repo]')).toBeNull();
  });

  it('following: the Worktrees summary line goes with the list when another computer is picked', async () => {
    act(() => root.render(createElement(GitPage)));
    act(() => worktreesTab().click());
    await settle();
    expect(container.querySelector('[data-git-wt-summary]')).not.toBeNull();
    selectPc('h1');
    await settle();
    expect(container.querySelector('[data-git-worktree-list]')).toBeNull();
    expect(container.querySelector('[data-git-wt-summary]')).toBeNull();
  });

  it('a computer the roster has not named: no line at all, never "no repository"', async () => {
    selectPc('h9', []);
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-remote-files]')).toBeNull();
    expect(container.querySelector('[data-git-no-repo]')).toBeNull();
  });

  it('All repos: this computer\'s worktrees show with no remote note or branch card above them', async () => {
    selectPc('h1');
    act(() => useStore.setState({ gitPage: { ...initialGitPageState(), scope: 'all', tab: 'worktrees' } }));
    act(() => root.render(createElement(GitPage)));
    await settle();
    expect(container.querySelector('[data-git-repo-group]')).not.toBeNull();
    expect(container.querySelector('[data-git-remote-files]')).toBeNull();
    expect(container.querySelector('[data-git-current-branch]')).toBeNull();
  });
});
