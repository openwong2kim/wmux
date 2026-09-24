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

let taskRow: Record<string, unknown> = {};
const invoke = vi.fn(async (method: string) => {
  const result =
    method === 'task.mission.list'
      ? { ok: true, tasks: [{ id: TASK_ID, status: 'open', worktreePath: '/wt', branch: 'b', missionChannelId: '', ...taskRow }] }
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

function buttonByText(c: Element, text: string): HTMLButtonElement | undefined {
  return [...c.querySelectorAll('button')].find((b) => b.textContent === text);
}

function closeButton(c: Element): HTMLButtonElement {
  const btn = buttonByText(c, 'Close');
  if (!btn) throw new Error('Close button not rendered');
  return btn;
}

beforeEach(() => {
  taskRow = {};
  invoke.mockClear();
  read.mockReset();
  read.mockImplementation(async () => readResult());
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
    // The guidance names the worktree, leads with the safe routes, and stays in
    // the panel. The discard recipe also unstages and warns what it deletes.
    expect(c.textContent).toContain('the task worktree at /wt still has uncommitted changes');
    expect(c.textContent).toContain('commit the changes and open a PR');
    expect(c.textContent).toContain('git restore --staged --worktree . && git clean -fd in /wt');
    expect(c.textContent).toContain('including files that were not adopted');
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

  it('opens a closed task without reading its removed worktree', async () => {
    taskRow = { status: 'closed' };
    const c = render();
    await flush();

    expect(read).not.toHaveBeenCalled();
    expect(c.textContent).toContain('This task is closed');
    expect(adoptButton(c)).toBeNull();
    expect(buttonByText(c, 'PR')).toBeUndefined();
    expect(buttonByText(c, 'Close')).toBeUndefined();
  });

  it('still shows a detached task, which is closed but keeps its worktree', async () => {
    taskRow = { status: 'closed', detachedAt: 1000 };
    const c = render();
    await flush();

    expect(read).toHaveBeenCalledWith('/wt', undefined, 'task');
    expect(c.textContent).not.toContain('This task is closed');
    expect(c.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(adoptButton(c)).not.toBeNull();
  });

  it('ignores a reload that was still in flight when Close succeeded', async () => {
    const c = render();
    await flush();

    // Hold the reload's task lookup: it will answer with the pre-close 'open' row.
    let releaseList: () => void = () => undefined;
    const held = new Promise<void>((r) => (releaseList = r));
    invoke.mockImplementationOnce(async () => {
      await held;
      return {
        id: 'renderer-1',
        ok: true,
        result: { ok: true, tasks: [{ id: TASK_ID, status: 'open', worktreePath: '/wt', branch: 'b', missionChannelId: '' }] },
      };
    });
    click(buttonByText(c, 'Reload')!);
    await flush();

    close.mockResolvedValueOnce({ ok: true, taskId: TASK_ID, archivePending: false });
    click(closeButton(c));
    await flush();
    expect(c.textContent).toContain('This task is closed');

    // The stale lookup lands after the close: it must not reopen the task.
    await act(async () => releaseList());
    await flush();
    expect(c.textContent).toContain('This task is closed');
    expect(adoptButton(c)).toBeNull();
    expect(buttonByText(c, 'Close')).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
