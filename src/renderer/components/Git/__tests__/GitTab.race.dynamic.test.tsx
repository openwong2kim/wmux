// @vitest-environment jsdom
//
// Regression test for GitTab's load() race guard (loadSeq monotonic token). On a fast
// repo (pane cwd) switch, a late-arriving earlier response must not overwrite the newer
// result — checks that a late repo-A response doesn't overwrite the already-committed
// repo-B worktree. The packaged UI can't be automated, so this jsdom harness is the
// verification surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { GitTab } from '../GitTab';
import type { SessionData, Workspace } from '../../../../shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const listDeferreds = new Map<string, Deferred<unknown>>();

function makeWs(cwd: string): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf',
      type: 'leaf',
      activeSurfaceId: 's1',
      surfaces: [{ id: 's1', ptyId: 'pty-1', title: 't', shell: 'bash', cwd, surfaceType: 'terminal' }],
    },
    activePaneId: 'leaf',
  } as unknown as Workspace;
}

function seed(cwd: string): void {
  const data: SessionData = { workspaces: [makeWs(cwd)], activeWorkspaceId: 'ws-1', sidebarVisible: true };
  act(() => useStore.getState().loadSession(data));
}

function wtResult(repoPath: string, branch: string) {
  return {
    ok: true,
    repoPath,
    mainPath: repoPath,
    worktrees: [{ path: repoPath, branch, headOid: '0000000', locked: null, prunable: null }],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  listDeferreds.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { resolveRepo: (cwd: string) => Promise.resolve({ ok: true, repoPath: cwd }) },
    worktree: {
      list: (repoPath: string) => {
        const d = deferred<unknown>();
        listDeferreds.set(repoPath, d);
        return d.promise;
      },
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

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('GitTab load() race guard', () => {
  it('a late repo-A response does not overwrite the newer repo-B roster', async () => {
    seed('/repoA');
    act(() => root.render(createElement(GitTab)));
    await flush(); // load(A) → list('/repoA') pending

    // pane cwd switch → re-run load(B).
    act(() => useStore.setState({ workspaces: [makeWs('/repoB')] }));
    await flush(); // load(B) → list('/repoB') pending

    expect(listDeferreds.has('/repoA')).toBe(true);
    expect(listDeferreds.has('/repoB')).toBe(true);

    // Commit the newer one (B) first.
    act(() => listDeferreds.get('/repoB')!.resolve(wtResult('/repoB', 'branch-B')));
    await flush();
    expect(container.querySelector('[data-git-worktree-list]')?.textContent).toContain('branch-B');

    // Late A response — the guard should block it and not overwrite B.
    act(() => listDeferreds.get('/repoA')!.resolve(wtResult('/repoA', 'branch-A')));
    await flush();
    const list = container.querySelector('[data-git-worktree-list]')?.textContent ?? '';
    expect(list).toContain('branch-B');
    expect(list).not.toContain('branch-A');
  });
});
