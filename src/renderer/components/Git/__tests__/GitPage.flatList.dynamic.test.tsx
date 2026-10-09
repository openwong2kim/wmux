// @vitest-environment jsdom
//
// All repos as one flat list: every repo's rows merged newest first, each
// with its repo tag; repo chips (with counts, loading and failure) filter by
// repo and a tag toggles its chip; the Flat | By repo toggle; selecting a row
// from a repo that is not the active one opens it in the detail pane.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import GitPage from '../GitPage';
import { clearGitCaches } from '../repoCache';
import { useStore } from '../../../stores';
import { initialGitPageState } from '../gitPageState';
import type { Workspace } from '../../../../shared/types';

function workspace(id: string, cwd: string): Workspace {
  return {
    id, name: id,
    rootPane: { id: `p-${id}`, type: 'leaf', activeSurfaceId: `s-${id}`, surfaces: [{ id: `s-${id}`, ptyId: `pty-${id}`, title: id, shell: 'zsh', cwd, surfaceType: 'terminal' }] },
    activePaneId: `p-${id}`,
  } as Workspace;
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await act(async () => { await Promise.resolve(); });
};

const pr = (repo: string, number: number, updatedAt: string, title = `${repo} pr ${number}`) => ({
  number, title, state: 'open', author: 'me', headRefName: 'h', updatedAt, url: `https://github.com/o/${repo}/pull/${number}`,
  reviewDecision: '', checks: null, mergeable: 'MERGEABLE',
});
const issue = (repo: string, number: number, updatedAt: string) => ({
  number, title: `${repo} issue ${number}`, state: 'open', author: 'a', labels: [], assignees: [], updatedAt,
  url: `https://github.com/o/${repo}/issues/${number}`, comments: 0,
});

let container: HTMLDivElement;
let root: Root;
let prList: ReturnType<typeof vi.fn>;
let issueList: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearGitCaches();
  try { localStorage.clear(); } catch { /* none */ }
  // alpha (active) has two PRs, beta one with the same number as alpha's
  // older one, gamma's read fails.
  prList = vi.fn(async (p: string) => {
    if (p === '/code/alpha') return { ok: true, prs: [pr('alpha', 7, '2026-10-01T00:00:00Z'), pr('alpha', 9, '2026-10-05T00:00:00Z')] };
    if (p === '/code/beta') return { ok: true, prs: [pr('beta', 7, '2026-10-03T00:00:00Z', 'beta fix')] };
    return { ok: false, code: 'error', message: 'gh exploded' };
  });
  issueList = vi.fn(async (p: string) => (p === '/code/alpha'
    ? { ok: true, issues: [issue('alpha', 1, '2026-10-01T00:00:00Z')] }
    : p === '/code/beta' ? { ok: true, issues: [issue('beta', 2, '2026-10-02T00:00:00Z')] } : { ok: true, issues: [] }));
  const paths = ['/code/alpha', '/code/beta', '/code/gamma'];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
    diff: { resolveRepo: vi.fn(async (cwd: string) => (paths.includes(cwd) ? { ok: true, repoPath: cwd } : { ok: false })) },
    worktree: {
      list: vi.fn(async (p: string) => ({ ok: true, repoPath: p, mainPath: p, worktrees: [{ path: p, branch: 'main', headOid: '1', locked: null, prunable: null }] })),
    },
    github: {
      prList,
      prDetail: vi.fn(async (_p: string, n: number) => ({ ok: true, detail: { number: n, comments: [] } })),
      repoKey: vi.fn(async (p: string) => ({ key: `github.com/o/${p.split('/').pop()}` })),
      issueList,
      issueDetail: vi.fn(async () => ({ ok: true, detail: null })),
    },
  };
  act(() => useStore.setState({
    workspaces: [workspace('a', '/code/alpha'), workspace('b', '/code/beta'), workspace('c', '/code/gamma')],
    activeWorkspaceId: 'a', startupDirectory: '', appRoute: 'git', paneGate: 'pending',
    gitPage: { ...initialGitPageState(), tab: 'prs', scope: 'all', pick: null },
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

const rows = () => [...container.querySelectorAll('[data-git-flat-rows] > li')].map((li) => ({
  repo: li.querySelector('[data-git-repo-tag]')?.textContent,
  number: Number(li.getAttribute('data-pr-row') ?? li.getAttribute('data-issue-row')),
}));
const chip = (name: string) => container.querySelector(`[data-git-repo-chip="${name}"]`) as HTMLButtonElement;
const render = async () => {
  act(() => root.render(createElement(GitPage)));
  await settle();
};

describe('Git page, All repos flat list', () => {
  it('merges every repo\'s rows newest first, each with its repo tag; chips carry counts and a failed read', async () => {
    await render();
    expect(container.querySelector('[data-git-flat-list]')).not.toBeNull();
    expect(container.querySelector('[data-git-repo-group]')).toBeNull();
    expect(rows()).toEqual([{ repo: 'alpha', number: 9 }, { repo: 'beta', number: 7 }, { repo: 'alpha', number: 7 }]);
    const tag = container.querySelector('[data-git-flat-rows] [data-git-repo-tag="beta"]') as HTMLButtonElement;
    expect(tag.getAttribute('title')).toBe('o/beta');
    // A tag is its own button beside the row, never inside it.
    expect(tag.closest('.wmux-git-item')).toBeNull();
    expect(chip('alpha').textContent).toContain('2');
    expect(chip('beta').textContent).toContain('1');
    // gamma's read failed: its chip says so instead of silently showing nothing.
    expect(chip('gamma').getAttribute('data-state')).toBe('error');
    expect(chip('gamma').querySelector('[data-git-chip-error]')).not.toBeNull();
    expect(chip('gamma').getAttribute('title')).toContain('gh exploded');
    expect(container.querySelector('[data-git-list-stale]')).not.toBeNull();
    // Only the active repo's list polls; the other repos read once.
    expect(prList.mock.calls.filter((c) => c[0] === '/code/beta').length).toBe(1);
  });

  it('a repo still reading shows a spinner on its chip', async () => {
    prList.mockImplementation(async (p: string) => (p === '/code/gamma'
      ? new Promise(() => undefined)
      : { ok: true, prs: [] }));
    await render();
    expect(chip('gamma').getAttribute('data-state')).toBe('loading');
    expect(chip('gamma').querySelector('[data-git-chip-loading]')).not.toBeNull();
    // A repo with nothing open keeps its chip, dimmed.
    expect(chip('beta').getAttribute('data-state')).toBe('empty');
  });

  it('chips filter by repo, a row\'s tag toggles its chip, and the choice is kept', async () => {
    await render();
    act(() => chip('beta').click());
    expect(chip('beta').getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toEqual([{ repo: 'beta', number: 7 }]);
    expect(JSON.parse(localStorage.getItem('wmux.git.repoChips')!)).toEqual(['github.com/o/beta']);
    // The tag on the only row turns its chip off again: every repo.
    act(() => (container.querySelector('[data-git-flat-rows] [data-git-repo-tag="beta"]') as HTMLButtonElement).click());
    expect(chip('beta').getAttribute('aria-pressed')).toBe('false');
    expect(rows().length).toBe(3);
    // An alpha row's tag narrows to alpha, and selecting nothing else.
    act(() => (container.querySelector('[data-git-flat-rows] [data-git-repo-tag="alpha"]') as HTMLButtonElement).click());
    expect(rows()).toEqual([{ repo: 'alpha', number: 9 }, { repo: 'alpha', number: 7 }]);
    expect(useStore.getState().gitPage.selected).toBeNull();
    // Kept across a remount.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => useStore.setState({ gitPage: { ...initialGitPageState(), tab: 'prs', scope: 'all', pick: null } }));
    await render();
    expect(chip('alpha').getAttribute('aria-pressed')).toBe('true');
    expect(rows().every((r) => r.repo === 'alpha')).toBe(true);    // Two clicks before a re-render both count.
    act(() => { chip('alpha').click(); chip('beta').click(); });
    expect(useStore.getState().gitPage.repoChips).toEqual(['github.com/o/beta']);
  });

  it('the layout toggle switches to the grouped view and back, and is kept', async () => {
    await render();
    const toggle = container.querySelector('[data-testid="git-all-layout"]')!;
    const radio = (label: string) => [...toggle.querySelectorAll('[role="radio"]')].find((b) => b.textContent === label) as HTMLButtonElement;
    expect(radio('Flat').getAttribute('aria-checked')).toBe('true');
    act(() => radio('By repo').click());
    await settle();
    expect(container.querySelector('[data-git-flat-list]')).toBeNull();
    expect([...container.querySelectorAll('[data-git-repo-group]')].map((g) => g.getAttribute('data-git-repo-group'))).toEqual(['alpha', 'beta', 'gamma']);
    expect(localStorage.getItem('wmux.git.allLayout')).toBe('repo');
    expect(initialGitPageState().allLayout).toBe('repo');
    act(() => radio('Flat').click());
    await settle();
    expect(container.querySelector('[data-git-flat-list]')).not.toBeNull();
    // Worktrees has no toggle.
    act(() => (container.querySelector('[data-git-page-tab="worktrees"]') as HTMLButtonElement).click());
    await settle();
    expect(container.querySelector('[data-testid="git-all-layout"]')).toBeNull();
  });

  it('a row from a repo that is not the active one opens in the detail pane and drags as that repo\'s', async () => {
    await render();
    const betaRow = container.querySelector('[data-git-flat-rows] > li:nth-child(2) > button') as HTMLButtonElement;
    expect(betaRow.textContent).toContain('beta fix');
    act(() => betaRow.click());
    await settle();
    expect(useStore.getState().gitPage.selected).toEqual({ kind: 'pr', repoPath: '/code/beta', number: 7 });
    expect(betaRow.getAttribute('aria-current')).toBe('true');
    // alpha's #7 is another PR: not selected.
    expect(container.querySelector('[data-git-flat-rows] > li:nth-child(3) > button')!.getAttribute('aria-current')).toBeNull();
    const head = container.querySelector('[data-git-detailpane] [data-git-detail-head]')!;
    expect(head.textContent).toContain('beta fix');
    expect(head.textContent).toContain('o/beta');
    // The drag names beta and a workspace in it.
    const ev = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown };
    ev.dataTransfer = { setData: () => undefined, effectAllowed: 'all' };
    act(() => { betaRow.dispatchEvent(ev); });
    expect(useStore.getState().gitDragContext).toEqual({ repoPath: '/code/beta', workspaceId: 'b', owner: 'o', repo: 'beta' });
    act(() => { window.dispatchEvent(new Event('dragend')); });
  });

  it('Issues: one filter over the merged list', async () => {
    act(() => useStore.getState().setGitPage({ tab: 'issues' }));
    await render();
    expect(container.querySelectorAll('[data-issue-filter]').length).toBe(1);
    expect(rows()).toEqual([{ repo: 'beta', number: 2 }, { repo: 'alpha', number: 1 }]);
    expect(chip('gamma').getAttribute('data-state')).toBe('empty');
  });
});
