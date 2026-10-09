// @vitest-environment jsdom
//
// All repos flat, split into who-acts-next sections: rows land in their
// section (newest first within it), Agents on it and Waiting on others start
// folded, the header summary opens and scrolls to a section, Tab skips a
// folded section's rows, the repo chips change the counts, and a selected row
// in a folded section still shows in the detail.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import GitPage from '../GitPage';
import { clearGitCaches } from '../repoCache';
import { clearGitViewerCache } from '../GitTurnSections';
import { useStore } from '../../../stores';
import { initialGitPageState } from '../gitPageState';
import type { Workspace } from '../../../../shared/types';
import type { WorkLink } from '../../../../shared/workLink';

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

const pr = (repo: string, number: number, updatedAt: string, over: Record<string, unknown> = {}) => ({
  number, title: `${repo} pr ${number}`, state: 'open', author: 'me', headRefName: 'h', updatedAt,
  url: `https://github.com/o/${repo}/pull/${number}`, reviewDecision: '', checks: 'passing', mergeable: 'MERGEABLE', ...over,
});

// alpha (owner can write): #1 failing (needs you), #2 and #3 green (ready),
// #4 failing with an agent working (agents on it), #5 CI running (waiting).
// beta (read only): #6 by a contributor with red CI (waiting, not needs you),
// #8 the owner's own with no CI (ready).
const ALPHA = [
  pr('alpha', 1, '2026-10-01T00:00:00Z', { checks: 'failing' }),
  pr('alpha', 2, '2026-10-02T00:00:00Z'),
  pr('alpha', 3, '2026-10-04T00:00:00Z'),
  pr('alpha', 4, '2026-10-03T00:00:00Z', { checks: 'failing' }),
  pr('alpha', 5, '2026-10-05T00:00:00Z', { checks: 'pending' }),
];
const BETA = [
  pr('beta', 6, '2026-10-06T00:00:00Z', { author: 'contrib', checks: 'failing' }),
  pr('beta', 8, '2026-10-01T12:00:00Z', { checks: null }),
];

const agentLink: WorkLink = {
  id: 'l1', origin: 'pr', owner: { workspaceId: 'a', paneId: 'p-a' }, state: 'running',
  pr: { host: 'github.com', owner: 'o', repo: 'alpha', number: 4 }, decisionIds: [], createdAt: 1, updatedAt: 2,
};

let container: HTMLDivElement;
let root: Root;
let repoPermission: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearGitCaches();
  clearGitViewerCache();
  try { localStorage.clear(); } catch { /* none */ }
  repoPermission = vi.fn(async (p: string) => ({ permission: p === '/code/alpha' ? 'ADMIN' : 'READ' }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
    diff: { resolveRepo: vi.fn(async (cwd: string) => ({ ok: true, repoPath: cwd })) },
    worktree: {
      list: vi.fn(async (p: string) => ({ ok: true, repoPath: p, mainPath: p, worktrees: [{ path: p, branch: 'main', headOid: '1', locked: null, prunable: null }] })),
    },
    github: {
      prList: vi.fn(async (p: string) => ({ ok: true, prs: p === '/code/alpha' ? ALPHA : BETA })),
      prDetail: vi.fn(async (_p: string, n: number) => ({ ok: true, detail: { number: n, comments: [] } })),
      repoKey: vi.fn(async (p: string) => ({ key: `github.com/o/${p.split('/').pop()}` })),
      issueList: vi.fn(async () => ({ ok: true, issues: [] })),
      issueDetail: vi.fn(async () => ({ ok: true, detail: null })),
      viewerLogin: vi.fn(async () => ({ login: 'me' })),
      repoPermission,
    },
    workLinks: { list: vi.fn(async () => [agentLink]), onChanged: vi.fn(() => () => undefined) },
  };
  act(() => useStore.setState({
    workspaces: [workspace('a', '/code/alpha'), workspace('b', '/code/beta')],
    activeWorkspaceId: 'a', startupDirectory: '', appRoute: 'git', paneGate: 'pending',
    // The agent in alpha's pane is mid-turn.
    surfaceAgentStatus: { 'pty-a': 'running' },
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

const render = async () => {
  act(() => root.render(createElement(GitPage)));
  await settle();
};
const section = (turn: string) => container.querySelector(`[data-git-turn-section="${turn}"]`) as HTMLElement | null;
const head = (turn: string) => section(turn)?.querySelector('[data-git-turn-head]') as HTMLButtonElement;
const count = (turn: string) => section(turn)?.querySelector('[data-git-turn-count]')?.textContent;
const rowsOf = (turn: string) => [...(section(turn)?.querySelectorAll('[data-git-turn-rows] > li') ?? [])]
  .map((li) => `${li.querySelector('[data-git-repo-tag]')?.textContent}#${li.getAttribute('data-pr-row')}`);
const summary = () => container.querySelector('[data-git-turn-summary]')?.textContent ?? null;
const chip = (name: string) => container.querySelector(`[data-git-repo-chip="github.com/o/${name}"]`) as HTMLButtonElement;

describe('Git page, who-acts-next sections', () => {
  it('rows land in their sections, newest first; the folded ones show only a header', async () => {
    await render();
    expect([...container.querySelectorAll('[data-git-turn-section]')].map((s) => s.getAttribute('data-git-turn-section')))
      .toEqual(['needs_you', 'ready_to_merge', 'agents_on_it', 'waiting_on_others']);
    expect(rowsOf('needs_you')).toEqual(['alpha#1']);
    expect(rowsOf('ready_to_merge')).toEqual(['alpha#3', 'alpha#2', 'beta#8']);
    expect(count('agents_on_it')).toBe('1');
    expect(count('waiting_on_others')).toBe('2');
    // Folded by default: no rows drawn.
    expect(head('agents_on_it').getAttribute('aria-expanded')).toBe('false');
    expect(rowsOf('agents_on_it')).toEqual([]);
    expect(head('waiting_on_others').getAttribute('aria-expanded')).toBe('false');
    // Opened: the contributor's red PR on the read-only repo waits, newest first.
    act(() => head('waiting_on_others').click());
    expect(rowsOf('waiting_on_others')).toEqual(['beta#6', 'alpha#5']);
    act(() => head('agents_on_it').click());
    expect(rowsOf('agents_on_it')).toEqual(['alpha#4']);
    expect(useStore.getState().gitPage.turnCollapsed).toEqual({ waiting_on_others: false, agents_on_it: false });
    // Each repo's role was read once.
    expect(repoPermission).toHaveBeenCalledTimes(2);
    // Only Needs you carries the attention mark.
    expect(section('needs_you')!.querySelector('.wmux-git-turn-dot')).not.toBeNull();
    expect(container.querySelectorAll('.wmux-git-turn-dot').length).toBe(1);
  });

  it('the summary names every non-empty section; a click opens and scrolls to it', async () => {
    const scrolled: string[] = [];
    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    const prev = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) { scrolled.push(this.closest('[data-git-turn-section]')?.getAttribute('data-git-turn-section') ?? ''); };
    try {
      await render();
      expect(summary()).toBe('Needs you 1 · Ready to merge 3 · Agents on it 1 · Waiting on others 2');
      const jump = container.querySelector('[data-git-turn-jump="waiting_on_others"]') as HTMLButtonElement;
      await act(async () => {
        jump.click();
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      expect(head('waiting_on_others').getAttribute('aria-expanded')).toBe('true');
      expect(rowsOf('waiting_on_others')).toEqual(['beta#6', 'alpha#5']);
      expect(scrolled).toEqual(['waiting_on_others']);
      expect(document.activeElement).toBe(head('waiting_on_others'));
    } finally {
      proto.scrollIntoView = prev;
    }
  });

  it('Tab skips a folded section: from Ready to merge\'s last row it lands on the next header', async () => {
    await render();
    const focusables = [...section('ready_to_merge')!.parentElement!.querySelectorAll<HTMLElement>('button')];
    const lastReady = section('ready_to_merge')!.querySelector('[data-git-turn-rows] > li:last-child > button') as HTMLElement;
    // Each row is its button then its repo tag; the next stop after the tag is
    // the folded section's header, never one of its rows.
    const at = focusables.indexOf(lastReady);
    expect(focusables[at + 1].hasAttribute('data-git-repo-tag')).toBe(true);
    expect(focusables[at + 2]).toBe(head('agents_on_it'));
    expect(focusables[at + 3]).toBe(head('waiting_on_others'));
  });

  it('the repo chips filter first: the counts and the summary follow them', async () => {
    await render();
    act(() => chip('beta').click());
    expect(section('needs_you')).toBeNull();
    expect(section('agents_on_it')).toBeNull();
    expect(count('ready_to_merge')).toBe('1');
    expect(count('waiting_on_others')).toBe('1');
    expect(summary()).toBe('Ready to merge 1 · Waiting on others 1');
  });

  it('a selected row in a folded section still shows in the detail', async () => {
    act(() => useStore.getState().setGitPage({ selected: { kind: 'pr', repoPath: '/code/alpha', number: 4 } }));
    await render();
    expect(head('agents_on_it').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-git-detailpane] [data-git-detail-head]')?.textContent).toContain('alpha pr 4');
  });

  it('By repo is unchanged: no sections, no summary', async () => {
    act(() => useStore.getState().setGitPage({ allLayout: 'repo' }));
    await render();
    expect(container.querySelector('[data-git-turn-section]')).toBeNull();
    expect(summary()).toBeNull();
  });
});
