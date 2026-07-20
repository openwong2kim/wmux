// @vitest-environment jsdom
//
// Dynamic tests for the Review tab (P1 2026-07-18): mounts the real
// <ReviewTab/> against a seeded store with a mocked electronAPI.diff bridge.
// Covers the roster contract: one row per workspace, dirty rows first with
// summed numstat, clean rows labelled, no-repo workspaces degrade gracefully,
// and the Diff action activates the target workspace + opens a diff surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReviewTab from '../ReviewTab';
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

const flush = async () => {
  // load() awaits two bridge calls per workspace — settle a few microtask turns.
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};

let container: HTMLDivElement;
let root: Root;

function mockDiffBridge(): { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async (repoPath: string) => {
    if (repoPath === 'D:/repo-dirty') {
      return {
        ok: true,
        files: [],
        numstat: [
          { path: 'a.ts', additions: 10, deletions: 2 },
          { path: 'b.ts', additions: 5, deletions: 1 },
        ],
        snapshot: { targetRepoPath: repoPath, targetBranch: 'feat/x', targetHeadOid: 'h', targetDirtyFiles: [] },
        truncated: [],
        unsupported: [],
      };
    }
    return {
      ok: true,
      files: [],
      numstat: [],
      snapshot: { targetRepoPath: repoPath, targetBranch: 'main', targetHeadOid: 'h', targetDirtyFiles: [] },
      truncated: [],
      unsupported: [],
    };
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    diff: {
      resolveRepo: vi.fn(async (cwd: string) =>
        cwd.startsWith('D:/repo') ? { ok: true, repoPath: cwd } : { ok: false },
      ),
      read,
    },
  };
  return { read };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockDiffBridge();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function seed(workspaces: Workspace[], activeWorkspaceId: string): void {
  act(() => {
    useStore.setState({ workspaces, activeWorkspaceId, startupDirectory: '' });
  });
}

async function mount(): Promise<void> {
  act(() => {
    root.render(createElement(ReviewTab));
  });
  await flush();
}

describe('ReviewTab — diff-first roster', () => {
  it('renders one row per workspace, dirty first with summed stats, clean labelled', async () => {
    seed(
      [
        workspace('ws-clean', 'clean-ws', 'D:/repo-clean'),
        workspace('ws-dirty', 'dirty-ws', 'D:/repo-dirty'),
      ],
      'ws-clean',
    );
    await mount();

    const rows = container.querySelectorAll('[data-review-list] li');
    expect(rows).toHaveLength(2);
    // Dirty row sorted first despite being second in the store.
    expect(rows[0].textContent).toContain('dirty-ws');
    expect(rows[0].textContent).toContain('2');
    expect(rows[0].textContent).toContain('+15');
    expect(rows[0].textContent).toContain('−3');
    expect(rows[1].textContent).toContain('clean-ws');
    expect(rows[1].textContent).toContain('clean');
    // Header count: 1 of 2 with changes.
    expect(container.textContent).toContain('1/2');
  });

  it('a workspace outside any repo degrades to a no-repo row without actions', async () => {
    seed([workspace('ws-x', 'no-repo-ws', 'C:/not-a-repo')], 'ws-x');
    await mount();
    const row = container.querySelector('[data-review-list] li')!;
    expect(row.textContent).toContain('no-repo-ws');
    expect(row.textContent).toContain('no repo');
    // No stat cell either — "clean" on a no-repo row reads as a false verdict.
    expect(row.textContent).not.toContain('clean');
    // No Diff button without a resolved repo.
    expect(Array.from(row.querySelectorAll('button')).some((b) => (b.getAttribute('title') ?? '').includes('review its diff'))).toBe(false);
  });

  it('Diff activates the target workspace and opens a diff surface on its leaf', async () => {
    seed(
      [
        workspace('ws-a', 'a', 'D:/repo-clean'),
        workspace('ws-dirty', 'b', 'D:/repo-dirty'),
      ],
      'ws-a',
    );
    await mount();
    const dirtyRow = container.querySelectorAll('[data-review-list] li')[0];
    const diffBtn = Array.from(dirtyRow.querySelectorAll('button')).find((b) =>
      (b.getAttribute('title') ?? '').includes('review its diff'),
    )!;
    act(() => diffBtn.click());

    const st = useStore.getState();
    expect(st.activeWorkspaceId).toBe('ws-dirty');
    const ws = st.workspaces.find((w) => w.id === 'ws-dirty')!;
    const leafPane = ws.rootPane;
    expect(leafPane.type).toBe('leaf');
    const surfaces = (leafPane as Extract<Pane, { type: 'leaf' }>).surfaces;
    expect(surfaces.some((s) => s.surfaceType === 'diff')).toBe(true);
  });

  it('스코프: 현재 repo(워크트리 포함)만 보이고 다른 repo는 제외된다', async () => {
    // 현재 repo = D:/repo-clean, 그 워크트리 = [본체, feat]. 다른 repo(D:/repo-other)는 제외.
    (window as unknown as { electronAPI: { worktree?: unknown } }).electronAPI.worktree = {
      list: vi.fn(async (repoPath: string) =>
        repoPath === 'D:/repo-clean'
          ? { ok: true, worktrees: [{ path: 'D:/repo-clean' }, { path: 'D:/repo-clean-worktrees/feat' }] }
          : { ok: false },
      ),
    };
    seed(
      [
        workspace('ws-main', 'main-ws', 'D:/repo-clean'),
        workspace('ws-feat', 'feat-ws', 'D:/repo-clean-worktrees/feat'),
        workspace('ws-other', 'other-ws', 'D:/repo-other'),
      ],
      'ws-main', // 활성 = repo-clean → 스코프 = repo-clean의 워크트리
    );
    await mount();
    const rows = container.querySelectorAll('[data-review-list] li');
    expect(rows).toHaveLength(2); // main + feat, other 제외
    const text = container.textContent ?? '';
    expect(text).toContain('main-ws');
    expect(text).toContain('feat-ws');
    expect(text).not.toContain('other-ws');
  });

  it('스코프 해결 실패(활성 워크스페이스가 repo 아님)면 전체 폴백', async () => {
    // worktree.list는 있으나 활성 워크스페이스 cwd가 repo가 아니라 scope=null → 전체.
    (window as unknown as { electronAPI: { worktree?: unknown } }).electronAPI.worktree = {
      list: vi.fn(async () => ({ ok: true, worktrees: [{ path: 'D:/repo-clean' }] })),
    };
    seed(
      [
        workspace('ws-home', 'home-ws', 'C:/not-a-repo'), // 활성, repo 아님 → scope null
        workspace('ws-repo', 'repo-ws', 'D:/repo-clean'),
      ],
      'ws-home',
    );
    await mount();
    const rows = container.querySelectorAll('[data-review-list] li');
    expect(rows).toHaveLength(2); // 폴백: 둘 다 표시
  });

  // Regression (2026-07-21): agent pane whose SHELL sits outside the repo —
  // surface.cwd is the shell home, the agent's repo lives in metadata.cwd
  // (hook-reported, already trusted by the sidebar). The row must resolve via
  // the metadata.cwd fallback instead of degrading to "no repo".
  it('falls back to metadata.cwd when the surface cwd is not a repo', async () => {
    seed(
      [workspace('ws-agent', 'agent-ws', 'C:/not-a-repo', {
        metadata: { cwd: 'D:/repo-dirty' },
      } as Partial<Workspace>)],
      'ws-agent',
    );
    await mount();
    const row = container.querySelector('[data-review-list] li')!;
    expect(row.textContent).toContain('agent-ws');
    expect(row.textContent).not.toContain('no repo');
    // Resolved to the dirty repo → summed numstat renders.
    expect(row.textContent).toContain('+15');
  });

  it('branch from workspace metadata and PR number render in the row', async () => {
    seed(
      [workspace('ws-dirty', 'meta-ws', 'D:/repo-dirty', {
        metadata: {
          gitBranch: 'feat/meta',
          pr: { number: 496, state: 'open', checks: 'passing', url: 'https://x/pull/496' },
        },
      } as Partial<Workspace>)],
      'ws-dirty',
    );
    await mount();
    const row = container.querySelector('[data-review-list] li')!;
    expect(row.textContent).toContain('⎇ feat/meta');
    expect(row.textContent).toContain('#496');
  });
});
