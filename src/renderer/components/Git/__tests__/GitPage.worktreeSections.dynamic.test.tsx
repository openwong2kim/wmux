// @vitest-environment jsdom
//
// The Git page's Worktrees tab in the who-acts-next grammar: In use,
// Uncommitted changes, No open PR, Cleanup candidates and No workspace, a
// summary line under the title that jumps to a section, and snooze (a row
// leaves its section for a folded Snoozed group until a chosen time or until
// it changes, kept per viewer). Mounts the real page with mocked worktree,
// diff and gh bridges; the open PR list is the one the header already reads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import GitPage from '../GitPage';
import { clearGitCaches } from '../repoCache';
import { ROW_STATS_DEBOUNCE_MS } from '../GitTab';
import { useStore } from '../../../stores';
import { GIT_WT_SNOOZE_KEY, initialGitPageState } from '../gitPageState';
import type { Workspace } from '../../../../shared/types';

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
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });
};

const MAIN = '/code/alpha';
const wt = (name: string) => `/code/alpha-wt/${name}`;
let heads: Record<string, string>;
let dirty: Record<string, number>;
const worktrees = () => [
  { path: MAIN, branch: 'main' },
  { path: wt('feat'), branch: 'feat' },
  { path: wt('done'), branch: 'done' },
  { path: wt('wip'), branch: 'wip' },
  { path: wt('ship'), branch: 'ship' },
  { path: wt('review'), branch: 'review' },
].map((w) => ({ ...w, headOid: heads[w.path] ?? '1', detached: false, bare: false, locked: null, prunable: null }));

const pr = (number: number, headRefName: string) => ({
  number, title: `pr ${number}`, state: 'open', author: 'me', headRefName, updatedAt: '2026-10-01T00:00:00Z',
  url: `https://github.com/o/alpha/pull/${number}`, reviewDecision: '', checks: 'passing', mergeable: 'MERGEABLE',
});

let container: HTMLDivElement;
let root: Root;
let prList: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearGitCaches();
  heads = {};
  dirty = { [wt('wip')]: 2 };
  try { localStorage.clear(); } catch { /* none */ }
  prList = vi.fn(async () => ({ ok: true, prs: [pr(7, 'feat'), pr(8, 'review')] }));
  list = vi.fn(async (p: string) => ({ ok: true, repoPath: p, mainPath: MAIN, worktrees: worktrees() }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
    diff: {
      resolveRepo: vi.fn(async (cwd: string) => (cwd.startsWith('/code/alpha') ? { ok: true, repoPath: cwd } : { ok: false })),
      read: vi.fn(async (p: string) => ({
        ok: true, files: [],
        numstat: Array.from({ length: dirty[p] ?? 0 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 })),
        snapshot: { targetRepoPath: p, targetBranch: 'x', targetHeadOid: 'h', targetDirtyFiles: [] }, truncated: [], unsupported: [],
      })),
    },
    worktree: { list, add: vi.fn(), remove: vi.fn() },
    github: {
      prList,
      prDetail: vi.fn(async () => ({ ok: true, detail: { number: 7, comments: [] } })),
      shipStatus: vi.fn(async () => ({ ok: false, error: 'n/a' })),
      repoKey: vi.fn(async () => ({ key: 'github.com/o/alpha' })),
      issueList: vi.fn(async () => ({ ok: true, issues: [] })),
      issueDetail: vi.fn(async () => ({ ok: true, detail: null })),
      onLoginEvent: vi.fn(() => () => undefined),
    },
  };
  act(() => useStore.setState({
    workspaces: [
      workspace('a', MAIN),
      workspace('b', wt('feat')),
      workspace('d', wt('done'), { metadata: { pr: { number: 9, state: 'merged', checks: null, url: 'https://github.com/o/alpha/pull/9' } } } as Partial<Workspace>),
    ],
    activeWorkspaceId: 'a', startupDirectory: '', appRoute: 'git', paneGate: 'pending',
    gitPage: { ...initialGitPageState(), tab: 'worktrees' },
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const mount = async () => {
  act(() => root.render(createElement(GitPage)));
  await settle();
};
const sections = () => [...container.querySelectorAll('[data-git-wt-section]')].map((s) => s.getAttribute('data-git-wt-section'));
const section = (key: string) => container.querySelector(`[data-git-wt-section="${key}"]`) as HTMLElement | null;
const head = (key: string) => section(key)!.querySelector('[data-git-wt-head]') as HTMLButtonElement;
const branchesIn = (key: string) => [...(section(key)?.querySelectorAll('[data-git-worktree-row] .wmux-git-branch') ?? [])].map((b) => b.textContent);
const summary = () => container.querySelector('[data-git-wt-summary]')?.textContent ?? '';
const snoozeBtn = (path: string) => container.querySelector(`[data-git-snooze="${path}"]`) as HTMLButtonElement;
const stored = () => JSON.parse(localStorage.getItem(GIT_WT_SNOOZE_KEY) ?? '{}') as Record<string, { until: number | null }>;

describe('Git page Worktrees: who acts next', () => {
  it('splits the worktrees into sections from signals the page already has, with a summary under the title', async () => {
    await mount();
    expect(sections()).toEqual(['inUse', 'uncommitted', 'noPr', 'cleanup', 'idle']);
    expect(branchesIn('inUse')).toEqual(['main', 'feat']);
    expect(branchesIn('uncommitted')).toEqual(['wip']);
    expect(branchesIn('noPr')).toEqual(['ship']);
    // Merged, clean, nobody at work there: a candidate, its workspace still named.
    expect(branchesIn('cleanup')).toEqual(['done']);
    expect(section('cleanup')!.textContent).toContain('d');
    expect(branchesIn('idle')).toEqual(['review']);
    expect(summary()).toBe('In use 2 · Uncommitted changes 1 · No open PR 1 · Cleanup candidates 1 · No workspace 1');
    // The open PRs are the header's own read: the tab read no list of its own.
    expect(prList).toHaveBeenCalledTimes(1);
    // Every worktree's uncommitted changes were read (local git).
    const read = (window as unknown as { electronAPI: { diff: { read: ReturnType<typeof vi.fn> } } }).electronAPI.diff.read;
    expect(read).toHaveBeenCalledWith(wt('ship'), '', 'workspace');
  });

  it('a summary entry opens its folded section and focuses its header', async () => {
    await mount();
    act(() => head('noPr').click());
    expect(head('noPr').getAttribute('aria-expanded')).toBe('false');
    expect(branchesIn('noPr')).toEqual([]);
    act(() => (container.querySelector('[data-git-wt-jump="noPr"]') as HTMLButtonElement).click());
    await settle();
    expect(head('noPr').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(head('noPr'));
  });

  it('without a PR list the page holds, a branch is not called No open PR', async () => {
    prList.mockResolvedValue({ ok: false, code: 'error', message: 'boom' });
    await mount();
    expect(section('noPr')).toBeNull();
    expect(branchesIn('idle')).toEqual(['ship', 'review']);
  });

  it('snooze: pick a time, the row folds into Snoozed, is kept per viewer, and Unsnooze brings it back', async () => {
    await mount();
    act(() => snoozeBtn(wt('ship')).click());
    await settle();
    const choices = container.querySelector('[data-git-snooze-choices]')!;
    expect([...choices.querySelectorAll('[data-git-snooze-choice]')].map((b) => b.getAttribute('data-git-snooze-choice')))
      .toEqual(['hour', 'day', 'week', 'change']);
    expect(document.activeElement).toBe(choices.querySelector('[data-git-snooze-choice="hour"]'));
    const before = Date.now();
    act(() => (choices.querySelector('[data-git-snooze-choice="day"]') as HTMLButtonElement).click());
    await settle();
    expect(section('noPr')).toBeNull();
    expect(summary()).not.toContain('No open PR');
    // Snoozed starts folded, with its count; focus lands on its header.
    expect(head('snoozed').getAttribute('aria-expanded')).toBe('false');
    expect(section('snoozed')!.querySelector('[data-git-wt-count]')!.textContent).toBe('1');
    expect(document.activeElement).toBe(head('snoozed'));
    const until = stored()[wt('ship')].until!;
    expect(until).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(until).toBeLessThan(Date.now() + 86_400_000 + 1000);
    // A restart reads it back.
    act(() => root.unmount());
    act(() => useStore.setState({ gitPage: { ...initialGitPageState(), tab: 'worktrees' } }));
    root = createRoot(container);
    await mount();
    expect(section('noPr')).toBeNull();
    act(() => head('snoozed').click());
    expect(branchesIn('snoozed')).toEqual(['ship']);
    act(() => (container.querySelector(`[data-git-unsnooze="${wt('ship')}"]`) as HTMLButtonElement).click());
    await settle();
    expect(branchesIn('noPr')).toEqual(['ship']);
    expect(section('snoozed')).toBeNull();
    expect(localStorage.getItem(GIT_WT_SNOOZE_KEY)).toBeNull();
  });

  it('Escape closes the choices and returns to Snooze; In use and No workspace rows have no Snooze', async () => {
    await mount();
    expect(snoozeBtn(MAIN)).toBeNull();
    expect(snoozeBtn(wt('review'))).toBeNull();
    act(() => snoozeBtn(wt('wip')).click());
    await settle();
    const choices = container.querySelector('[data-git-snooze-choices]') as HTMLElement;
    act(() => { choices.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(container.querySelector('[data-git-snooze-choices]')).toBeNull();
    expect(document.activeElement).toBe(snoozeBtn(wt('wip')));
    expect(localStorage.getItem(GIT_WT_SNOOZE_KEY)).toBeNull();
  });

  it('until it changes: a new commit on the worktree ends the snooze', async () => {
    await mount();
    act(() => snoozeBtn(wt('wip')).click());
    await settle();
    act(() => (container.querySelector('[data-git-snooze-choice="change"]') as HTMLButtonElement).click());
    await settle();
    expect(section('uncommitted')).toBeNull();
    expect(stored()[wt('wip')].until).toBeNull();
    // A refresh with the same state keeps it snoozed.
    act(() => (container.querySelector('[data-git-refresh]') as HTMLButtonElement).click());
    await settle();
    expect(section('uncommitted')).toBeNull();
    // Someone commits there: the row is back and the snooze is gone.
    heads[wt('wip')] = '2';
    act(() => (container.querySelector('[data-git-refresh]') as HTMLButtonElement).click());
    await settle();
    expect(branchesIn('uncommitted')).toEqual(['wip']);
    expect(localStorage.getItem(GIT_WT_SNOOZE_KEY)).toBeNull();
  });

  it('a timed snooze ends when its time passes', async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await mount();
    act(() => snoozeBtn(wt('ship')).click());
    await settle();
    act(() => (container.querySelector('[data-git-snooze-choice="hour"]') as HTMLButtonElement).click());
    await settle();
    expect(section('noPr')).toBeNull();
    clock.mockReturnValue(t0 + 61 * 60 * 1000);
    // Any re-render past the time shows it again (the tab also wakes itself then).
    act(() => head('inUse').click());
    await settle();
    expect(branchesIn('noPr')).toEqual(['ship']);
    expect(localStorage.getItem(GIT_WT_SNOOZE_KEY)).toBeNull();
  });
});
