// @vitest-environment jsdom
//
// The sidebar Git section's worktree list joins what used to be two lists in
// the tools panel: the Git tab's worktrees and the Review section's workspaces
// on them. Mounts the real <GitTab/> against a seeded store with mocked
// worktree + diff bridges. Covers: one row per worktree with its workspaces
// and summed numstat, dirty rows first, other repos excluded, the metadata.cwd
// fallback, PR + workspace switch on a row, and the current-branch card.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, type FC } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitTab, ROW_STATS_DEBOUNCE_MS, type GitTabProps } from '../GitTab';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

function surface(id: string, cwd: string): Surface {
  return { id, ptyId: `pty-${id}`, title: id, shell: 'pwsh', cwd, surfaceType: 'terminal' };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, cwd: string, extra: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name,
    rootPane: leaf(`p-${id}`, [surface(`s-${id}`, cwd)]),
    activePaneId: `p-${id}`,
    ...extra,
  } as Workspace;
}

const MAIN = 'D:/repo';
const FEAT = 'D:/repo-worktrees/feat';
const IDLE = 'D:/repo-worktrees/idle';

const flush = async () => {
  for (let i = 0; i < 16; i++) await act(async () => { await Promise.resolve(); });
};
/** Past the row-stats debounce, then drain what it started. */
const settle = async () => {
  await flush();
  await act(async () => { await new Promise((r) => setTimeout(r, ROW_STATS_DEBOUNCE_MS + 20)); });
  await flush();
};

let container: HTMLDivElement;
let root: Root;

function numstatResult(repoPath: string, numstat: { path: string; additions: number; deletions: number }[]) {
  return {
    ok: true,
    files: [],
    numstat,
    snapshot: { targetRepoPath: repoPath, targetBranch: 'x', targetHeadOid: 'h', targetDirtyFiles: [] },
    truncated: [],
    unsupported: [],
  };
}

let read: ReturnType<typeof vi.fn>;

beforeEach(() => {
  read = vi.fn(async (repoPath: string) =>
    repoPath === FEAT
      ? numstatResult(repoPath, [
        { path: 'a.ts', additions: 10, deletions: 2 },
        { path: 'b.ts', additions: 5, deletions: 1 },
      ])
      : numstatResult(repoPath, []),
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    diff: {
      resolveRepo: vi.fn(async (cwd: string) =>
        cwd.startsWith('D:/repo') ? { ok: true, repoPath: cwd } : { ok: false },
      ),
      read,
    },
    worktree: {
      list: vi.fn(async (repoPath: string) =>
        repoPath.startsWith('D:/repo-other')
          ? { ok: true, repoPath, mainPath: repoPath, worktrees: [{ path: repoPath, branch: 'other', headOid: '1', locked: null, prunable: null }] }
          : {
            ok: true,
            repoPath,
            mainPath: MAIN,
            worktrees: [
              { path: MAIN, branch: 'main', headOid: '1111111', locked: null, prunable: null },
              { path: FEAT, branch: 'feat/x', headOid: '2222222', locked: null, prunable: null },
              { path: IDLE, branch: 'idle', headOid: '3333333', locked: null, prunable: null },
            ],
          },
      ),
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

function seed(workspaces: Workspace[], activeWorkspaceId: string): void {
  act(() => {
    useStore.setState({ workspaces, activeWorkspaceId, startupDirectory: '' });
  });
}

async function mount(): Promise<void> {
  act(() => {
    root.render(createElement(GitTab));
  });
  await settle();
}

const rows = () => Array.from(container.querySelectorAll('[data-git-worktree-row]'));

describe('GitTab — one row per worktree, with the workspaces on it', () => {
  it('lists every worktree once, dirty first, with its workspaces and summed stat', async () => {
    seed(
      [
        workspace('ws-main', 'main-ws', MAIN),
        workspace('ws-feat', 'feat-ws', FEAT),
        workspace('ws-feat2', 'feat-ws-2', FEAT),
        workspace('ws-other', 'other-ws', 'D:/repo-other'),
      ],
      'ws-main',
    );
    await mount();

    const r = rows();
    expect(r).toHaveLength(3);
    // The dirty worktree sorts first, carries both workspaces and the sum.
    expect(r[0].textContent).toContain('feat/x');
    expect(r[0].textContent).toContain('feat-ws, feat-ws-2');
    expect(r[0].textContent).toContain('+15');
    expect(r[0].textContent).toContain('−3');
    // main stays labelled as main (and keeps its stat); the idle worktree shows its folder.
    expect(r[1].textContent).toContain('main-ws');
    expect(r[1].textContent).toContain('main');
    expect(r[1].textContent).toContain('clean');
    expect(r[2].textContent).toContain('idle');
    // A workspace on another repo is not on any row.
    expect(container.textContent).not.toContain('other-ws');
    // Idle worktrees are not read (only current + worktrees with a workspace).
    expect(read).not.toHaveBeenCalledWith(IDLE, '', 'workspace');
    // The one accent dot is on the active pane's worktree.
    expect(r[1].getAttribute('data-current')).toBe('true');
    expect(r[0].getAttribute('data-current')).toBeNull();
  });

  it('a workspace whose shell sits outside the repo joins its worktree via metadata.cwd', async () => {
    seed(
      [
        workspace('ws-main', 'main-ws', MAIN),
        workspace('ws-agent', 'agent-ws', 'C:/home', { metadata: { cwd: FEAT } } as Partial<Workspace>),
      ],
      'ws-main',
    );
    await mount();
    const feat = rows().find((el) => el.textContent?.includes('feat/x'))!;
    expect(feat.textContent).toContain('agent-ws');
    expect(feat.textContent).toContain('+15');
  });

  it('shows a row\'s PR and switches to a workspace from its name', async () => {
    seed(
      [
        workspace('ws-main', 'main-ws', MAIN),
        workspace('ws-feat', 'feat-ws', FEAT, {
          metadata: { pr: { number: 496, state: 'open', checks: 'passing', url: 'https://x/pull/496' } },
        } as Partial<Workspace>),
      ],
      'ws-main',
    );
    await mount();
    const feat = rows().find((el) => el.textContent?.includes('feat/x'))!;
    expect(feat.textContent).toContain('#496');
    const link = Array.from(feat.querySelectorAll('button')).find((b) => b.textContent === 'feat-ws')!;
    act(() => link.click());
    expect(useStore.getState().activeWorkspaceId).toBe('ws-feat');
  });

  it('a row\'s Diff opens a diff surface for that worktree on the active pane', async () => {
    seed([workspace('ws-main', 'main-ws', MAIN), workspace('ws-feat', 'feat-ws', FEAT)], 'ws-main');
    await mount();
    const feat = rows().find((el) => el.textContent?.includes('feat/x'))!;
    const diff = Array.from(feat.querySelectorAll('button')).find((b) => b.textContent === 'Diff')!;
    act(() => diff.click());
    const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-main')!;
    const surfaces = (ws.rootPane as Extract<Pane, { type: 'leaf' }>).surfaces;
    expect(surfaces.some((s) => s.surfaceType === 'diff')).toBe(true);
  });

  it('the current-branch card shows ahead/behind and the PR only while metadata is about that branch', async () => {
    const meta = {
      gitBranch: 'main',
      cwd: `${MAIN}/src`,
      gitSync: { dirty: 0, ahead: 2, behind: 1, hasUpstream: true },
      pr: { number: 1740, state: 'open', checks: 'failing', url: 'https://x/pull/1740' },
    };
    seed([workspace('ws-main', 'main-ws', MAIN, { metadata: meta } as Partial<Workspace>)], 'ws-main');
    await mount();
    const card = () => container.querySelector('[data-git-current-branch]')!;
    expect(card().textContent).toContain('main');
    expect(card().querySelector('[data-git-ahead-behind]')?.textContent).toBe('↑2↓1');
    expect(card().querySelector('[data-git-current-pr]')?.textContent).toContain('#1740');
    expect(card().querySelector('[data-git-changes]')?.textContent).toContain('clean');

    // Metadata trailing on another branch must not describe this one.
    act(() => {
      useStore.setState({
        workspaces: [workspace('ws-main', 'main-ws', MAIN, { metadata: { ...meta, gitBranch: 'other' } } as Partial<Workspace>)],
      });
    });
    await flush();
    expect(card().querySelector('[data-git-ahead-behind]')).toBeNull();
    expect(card().querySelector('[data-git-current-pr]')).toBeNull();
  });

  it('metadata from another repo with the same branch name does not describe the card', async () => {
    // Both repos are on `main`; the workspace's pushed status is about the other one.
    const meta = {
      gitBranch: 'main',
      cwd: 'D:/elsewhere/main-repo',
      gitSync: { dirty: 4, ahead: 3, behind: 0, hasUpstream: true, added: 9, removed: 1 },
      pr: { number: 7, state: 'open', checks: 'passing', url: 'https://x/pull/7' },
    };
    seed([workspace('ws-main', 'main-ws', MAIN, { metadata: meta } as Partial<Workspace>)], 'ws-main');
    await mount();
    const card = container.querySelector('[data-git-current-branch]')!;
    expect(card.querySelector('[data-git-ahead-behind]')).toBeNull();
    expect(card.querySelector('[data-git-current-pr]')).toBeNull();
    // Changes come from this worktree's own read, not the other repo's +9 −1.
    expect(card.querySelector('[data-git-changes]')?.textContent).toContain('clean');
  });

  it('the card reads its changes from the pushed git status when it is about this worktree', async () => {
    const meta = { gitBranch: 'main', cwd: MAIN, gitSync: { dirty: 3, ahead: 0, behind: 0, hasUpstream: true, added: 12, removed: 4 } };
    seed([workspace('ws-main', 'main-ws', MAIN, { metadata: meta } as Partial<Workspace>)], 'ws-main');
    await mount();
    const changes = container.querySelector('[data-git-changes]')?.textContent ?? '';
    expect(changes).toContain('3 files');
    expect(changes).toContain('+12');
    expect(changes).toContain('−4');
  });

  it('a dirty main worktree keeps both its badge and its stat', async () => {
    read.mockImplementation(async (repoPath: string) =>
      numstatResult(repoPath, repoPath === MAIN ? [{ path: 'x.ts', additions: 7, deletions: 2 }] : []));
    seed([workspace('ws-main', 'main-ws', MAIN)], 'ws-main');
    await mount();
    const main = rows().find((el) => el.textContent?.includes('main-ws'))!;
    expect(main.querySelector('.wmux-git-main-badge')).not.toBeNull();
    expect(main.textContent).toContain('+7');
    expect(main.textContent).toContain('−2');
  });

  it('switching to another repo drops the old content until the new one lands', async () => {
    seed([workspace('ws-main', 'main-ws', MAIN), workspace('ws-other', 'other-ws', 'D:/repo-other')], 'ws-main');
    await mount();
    expect(rows().length).toBe(3);
    const wt = (window as unknown as { electronAPI: { worktree: { list: ReturnType<typeof vi.fn> } } }).electronAPI.worktree;
    let release!: () => void;
    const original = wt.list.getMockImplementation() as (p: string) => unknown;
    wt.list.mockImplementation((p: string) => new Promise((r) => { release = () => r(original(p)); }));
    act(() => useStore.getState().setActiveWorkspace('ws-other'));
    await flush();
    // Mid-switch: no rows and no card from the previous repo, so no click can hit it.
    expect(rows().length).toBe(0);
    expect(container.querySelector('[data-git-current-branch]')).toBeNull();
    expect(container.textContent).toContain('Loading');
    await act(async () => { release(); });
    await settle();
    expect(rows().map((r) => r.querySelector('.wmux-git-branch')?.textContent)).toEqual(['other']);
  });

  it('reports the main worktree\'s folder as the repo name, even from a linked worktree', async () => {
    const onRepo = vi.fn();
    seed([workspace('ws-feat', 'feat-ws', FEAT)], 'ws-feat');
    act(() => {
      root.render(createElement(GitTab as FC<GitTabProps>, { onRepo }));
    });
    await flush();
    expect(onRepo).toHaveBeenLastCalledWith('repo');
  });
});
