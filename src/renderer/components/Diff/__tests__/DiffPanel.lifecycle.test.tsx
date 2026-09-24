// @vitest-environment jsdom
//
// #1461 — what the task diff panel shows after Adopt and after Close:
//  - the adopt confirmation used to be wiped by the reload it triggered, and
//    the ticks survived it, so the button still read "Adopt (N)";
//  - Close refusing on a dirty worktree (the normal state right after an
//    adopt) gave no hint how to get out of it;
//  - a successful Close left the removed worktree's hunks up with Adopt live.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import DiffPanel from '../DiffPanel';
import type { DiffReadResult } from '../../../../shared/diffParse';

const TASK_ID = 'wtask-1';
const WS = 'ws-owner';

function readResult(): DiffReadResult {
  return {
    ok: true,
    files: [
      {
        path: 'a.txt',
        oldPath: 'a.txt',
        newPath: 'a.txt',
        kind: 'modify',
        hunkSelectable: true,
        headerBlock: 'diff --git a/a.txt b/a.txt\n',
        digest: 'd1',
        hunks: [
          {
            header: '@@ -1,2 +1,3 @@',
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            section: '',
            bodyLines: [' ctx', '+added'],
          },
        ],
      },
    ],
    numstat: [{ path: 'a.txt', additions: 1, deletions: 0 }],
    snapshot: { targetRepoPath: '/repo', targetBranch: 'main', targetHeadOid: 'oid', targetDirtyFiles: [] },
    truncated: [],
    unsupported: [],
  };
}

const invoke = vi.fn(async (method: string) => {
  const result =
    method === 'task.mission.list'
      ? { ok: true, tasks: [{ id: TASK_ID, status: 'open', worktreePath: '/wt', branch: 'b', missionChannelId: '' }] }
      : { ok: true };
  return { id: 'renderer-1', ok: true, result };
});
const read = vi.fn(async () => readResult());
const applyHunks = vi.fn(async () => ({ ok: true as const, appliedFiles: ['a.txt'] }));
const close = vi.fn();

const mounted: Array<() => void> = [];

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <DiffPanel source={{ kind: 'task', taskId: TASK_ID }} isActive surfaceId="s1" verifiedWorkspaceId={WS} />,
    ),
  );
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

async function flush(ticks = 20) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function adoptButton(c: Element): HTMLButtonElement | null {
  return c.querySelector<HTMLButtonElement>('[data-testid="diff-adopt"]');
}

function closeButton(c: Element): HTMLButtonElement {
  const btn = [...c.querySelectorAll('button')].find((b) => b.textContent === 'Close');
  if (!btn) throw new Error('Close button not rendered');
  return btn;
}

beforeEach(() => {
  invoke.mockClear();
  read.mockClear();
  applyHunks.mockClear();
  close.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { read, applyHunks },
    rpc: { invoke, mutateChannelLocal: vi.fn() },
    workTask: { close },
  };
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  vi.restoreAllMocks();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('DiffPanel — adopt and close lifecycle (#1461)', () => {
  it('keeps the adopt confirmation after the reload and clears the hunk selection', async () => {
    const c = render();
    await flush();
    click(c.querySelector('input[type="checkbox"]')!);
    expect(adoptButton(c)!.textContent).toBe('Adopt (1)');

    click(adoptButton(c)!);
    await flush();

    expect(applyHunks).toHaveBeenCalledTimes(1);
    // The panel reloaded after the adopt ...
    expect(read).toHaveBeenCalledTimes(2);
    // ... and the confirmation survived it.
    expect(c.textContent).toContain('Adopted — applied to the target working tree (1 files)');
    // No ticks carried over: a second click cannot re-apply the same hunks.
    expect(adoptButton(c)!.textContent).toBe('Adopt (0)');
    expect(adoptButton(c)!.disabled).toBe(true);
    expect(c.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  });

  it('says how to get past a dirty-worktree refusal, then drops the hunks once Close succeeds', async () => {
    const c = render();
    await flush();

    close.mockResolvedValueOnce({
      ok: false,
      taskId: TASK_ID,
      reason: 'dirty',
      error: 'removeWorktree: worktree is dirty; preserved',
      preservedWorktree: '/wt',
    });
    click(closeButton(c));
    await flush();
    // The guidance names the worktree and the way out, and stays in the panel.
    expect(c.textContent).toContain('discard them in /wt (git restore . && git clean -fd)');
    expect(adoptButton(c)).not.toBeNull();

    close.mockResolvedValueOnce({ ok: true, taskId: TASK_ID, archivePending: false });
    click(closeButton(c));
    await flush();

    expect(close).toHaveBeenCalledTimes(2);
    expect(c.textContent).toContain('This task is closed');
    // Nothing from the removed worktree is left to adopt.
    expect(c.textContent).not.toContain('@@ -1,2 +1,3 @@');
    expect(c.querySelector('input[type="checkbox"]')).toBeNull();
    expect(adoptButton(c)).toBeNull();
  });
});
