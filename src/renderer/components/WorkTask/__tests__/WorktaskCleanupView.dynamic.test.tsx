// @vitest-environment jsdom
//
// The task cleanup list on ui/Dialog: it cannot be dismissed while a task
// close is in flight (the result lands in the list), and "Commit & close"
// leaves focus on the terminal holding the prepared line, so the next Enter
// runs it instead of reopening the list.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const focusTerminal = vi.fn();
vi.mock('../../../hooks/useTerminal', () => ({
  terminalRegistry: new Map([['pty-task', { focus: focusTerminal }]]),
}));

import { useStore } from '../../../stores';
import { loadLocale, setLocale } from '../../../i18n';

// Tables other than English load on demand; the tests below read German synchronously.
beforeAll(() => loadLocale('de'));
import { en } from '../../../i18n/locales/en';
import WorktaskCleanupView from '../WorktaskCleanupView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let finishClose: (v: unknown) => void = () => undefined;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const escape = () =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  focusTerminal.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    workTask: {
      scan: vi.fn(async () => ({
        ok: true,
        scannedRoot: '/wt',
        entries: [{ category: 'preserved', taskId: 'task-1', title: 'Fix parser', worktreePath: '/wt/fix-parser', ownerWorkspaceId: 'ws-task' }],
      })),
      close: vi.fn(() => new Promise((r) => { finishClose = r; })),
    },
    diff: {
      read: vi.fn(async () => ({ ok: true, snapshot: { targetDirtyFiles: ['src/a.ts'] } })),
    },
    pty: { write: vi.fn() },
    shell: { openPath: vi.fn(async () => ({ ok: true })) },
  };
  act(() =>
    useStore.setState({
      activeWorkspaceId: 'ws-task',
      missionByPaneGroup: { 'ws-task': { id: 'task-1', title: 'Fix parser', status: 'open' } },
      workspaces: [
        {
          id: 'ws-task',
          name: 'task',
          activePaneId: 'pane-1',
          rootPane: {
            id: 'pane-1',
            type: 'leaf',
            activeSurfaceId: 's-1',
            surfaces: [{ id: 's-1', ptyId: 'pty-task', title: 'zsh', shell: 'zsh', cwd: '/wt/fix-parser' }],
          },
        },
      ],
      surfaceAgent: {},
      worktaskCleanupVisible: true,
    } as never),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState({ worktaskCleanupVisible: false } as never));
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('WorktaskCleanupView', () => {
  it('cannot be dismissed while a task close is in flight', async () => {
    act(() => root.render(createElement(WorktaskCleanupView)));
    await flush();
    act(() => button('Close').click());
    await flush();
    const x = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(x.disabled).toBe(true);
    button('Rescan').focus();
    escape();
    expect(useStore.getState().worktaskCleanupVisible).toBe(true);

    await act(async () => { finishClose({ ok: false, reason: 'dirty' }); });
    await flush();
    expect(x.disabled).toBe(false);
    button('Rescan').focus();
    escape();
    expect(useStore.getState().worktaskCleanupVisible).toBe(false);
  });

  // #2388: a half-removed folder whose repository is gone is kept: the close
  // says where it stays.
  it('a close that kept the folder says where it stays', async () => {
    act(() => root.render(createElement(WorktaskCleanupView)));
    await flush();
    act(() => button('Close').click());
    await flush();
    await act(async () => { finishClose({ ok: true, taskId: 'task-1', archivePending: false, unmaterialized: true, keptFolder: '/wt/fix-parser' }); });
    await flush();
    expect(useStore.getState().toasts.some((toast) => toast.message === 'Task closed. Its folder was kept at /wt/fix-parser.')).toBe(true);
  });

  it('says why a phone worktree was not removed: a shell inside it, or a Windows hold', async () => {
    const api = (window as unknown as { electronAPI: { workTask: Record<string, unknown> } }).electronAPI.workTask;
    api.scan = vi.fn(async () => ({
      ok: true,
      scannedRoot: '/wt',
      entries: [{ category: 'phone-worktree', worktreePath: '/wt/abc123def456/phone-x' }],
    }));
    api.removePhone = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'in-use' })
      .mockResolvedValueOnce({ ok: false, reason: 'held' });
    const confirm = vi.spyOn(window, 'confirm');
    act(() => useStore.setState({ toasts: [] } as never));
    act(() => root.render(createElement(WorktaskCleanupView)));
    await flush();
    for (let i = 0; i < 2; i++) {
      act(() => button('Remove').click());
      await flush();
    }
    expect(useStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'A pane or another shell is still running in this worktree — close it first.',
      'Windows will not delete this worktree right now: a program has a file or folder in it open, or the folder may not be deleted. Close it and try again.',
    ]);
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('asks before removing a locked phone worktree, and says so when the confirmed retry fails the same way', async () => {
    const api = (window as unknown as { electronAPI: { workTask: Record<string, unknown> } }).electronAPI.workTask;
    api.scan = vi.fn(async () => ({
      ok: true,
      scannedRoot: '/wt',
      entries: [{ category: 'phone-worktree', worktreePath: '/wt/abc123def456/phone-x' }],
    }));
    const removePhone = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'locked' })
      .mockResolvedValueOnce({ ok: false, reason: 'locked' });
    api.removePhone = removePhone;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    act(() => useStore.setState({ toasts: [] } as never));
    act(() => root.render(createElement(WorktaskCleanupView)));
    await flush();
    act(() => button('Remove').click());
    await flush();
    expect(confirm).toHaveBeenCalledWith('This worktree is locked. Unlock and remove it, discarding any uncommitted changes?');
    expect(removePhone.mock.calls).toEqual([['/wt/abc123def456/phone-x', false], ['/wt/abc123def456/phone-x', true]]);
    expect(useStore.getState().toasts.map((toast) => toast.message)).toEqual(['The worktree is still there (locked). Try again, or remove it with git.']);
    confirm.mockRestore();
  });

  describe('company seat worktree', () => {
    const SEAT = '/cw/abc123def456/dev-1-456789ab';
    const seatApi = () => {
      const api = (window as unknown as { electronAPI: { workTask: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.workTask;
      api.scan = vi.fn(async () => ({
        ok: true,
        scannedRoot: '/wt',
        entries: [{ category: 'company-seat', title: 'dev-1', company: 'checkout', worktreePath: SEAT, detailCode: 'seat-uncommitted' }],
      }));
      api.removeCompanySeat = vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'dirty' })
        .mockResolvedValueOnce({ ok: true, branch: 'company/dev-1-456789ab', repo: '/repo/.git', oid: 'c'.repeat(40) });
      api.deleteCompanySeatBranch = vi.fn(async () => ({ ok: true }));
      return api;
    };
    const el = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

    it('scans with every folder a pane here is in', async () => {
      const api = seatApi();
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      expect(api.scan).toHaveBeenCalledWith('ws-task', expect.any(Array), ['/wt/fix-parser']);
      expect(container.textContent).toContain('dev-1 · checkout');
    });

    it('says how many commits are only on this PC', async () => {
      const api = seatApi();
      api.scan = vi.fn(async () => ({
        ok: true,
        scannedRoot: '/wt',
        entries: [{ category: 'company-seat', title: 'dev-1', worktreePath: SEAT, detailCode: 'seat-unpushed', commitCount: 3, detail: 'RAW-FROM-MAIN' }],
      }));
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      expect(container.textContent).toContain('Company seat worktree');
      expect(container.textContent).toContain('3 commit(s) only on this PC — push them, or remove the worktree and keep its branch.');
      expect(container.textContent).not.toContain('RAW-FROM-MAIN');
    });

    it('asks in place before removing a seat with changes, then asks before deleting its branch', async () => {
      const api = seatApi();
      const confirm = vi.spyOn(window, 'confirm');
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      act(() => (container.querySelector('[data-cleanup-remove-seat]') as HTMLButtonElement).click());
      await flush();
      expect(api.removeCompanySeat.mock.calls).toEqual([[SEAT, false]]);
      expect(el('cleanup-seat-remove-confirm-row')).not.toBeNull();
      act(() => el('cleanup-seat-remove-confirm')!.click());
      await flush();
      expect(api.removeCompanySeat.mock.calls).toEqual([[SEAT, false], [SEAT, true]]);
      // The row stays until the branch question is answered.
      expect(api.scan).toHaveBeenCalledTimes(1);
      expect(el('cleanup-seat-branch-confirm-row')?.textContent).toContain(
        'Also delete the branch company/dev-1-456789ab? Commits that are only on this PC go with it.',
      );
      act(() => el('cleanup-seat-branch-confirm')!.click());
      await flush();
      expect(api.deleteCompanySeatBranch).toHaveBeenCalledWith(SEAT, '/repo/.git', 'company/dev-1-456789ab', 'c'.repeat(40));
      expect(api.scan).toHaveBeenCalledTimes(2);
      expect(confirm).not.toHaveBeenCalled();
      confirm.mockRestore();
    });

    it('asks in place before removing a seat whose commits are on no branch', async () => {
      const api = seatApi();
      api.removeCompanySeat = vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'unpushed' })
        .mockResolvedValueOnce({ ok: true });
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      act(() => (container.querySelector('[data-cleanup-remove-seat]') as HTMLButtonElement).click());
      await flush();
      expect(el('cleanup-seat-remove-confirm-row')?.textContent).toContain(
        'Its commits are on no branch and only on this PC. Removing the worktree loses them. Remove it anyway?',
      );
      act(() => el('cleanup-seat-remove-confirm')!.click());
      await flush();
      expect(api.removeCompanySeat.mock.calls).toEqual([[SEAT, false], [SEAT, true]]);
    });

    it('keeps the seat on Cancel, and its branch on the second question\'s cancel', async () => {
      const api = seatApi();
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      act(() => (container.querySelector('[data-cleanup-remove-seat]') as HTMLButtonElement).click());
      await flush();
      act(() => el('cleanup-seat-remove-cancel')!.click());
      await flush();
      expect(api.removeCompanySeat).toHaveBeenCalledTimes(1);
      expect(el('cleanup-seat-remove-confirm-row')).toBeNull();
      act(() => (container.querySelector('[data-cleanup-remove-seat]') as HTMLButtonElement).click());
      await flush();
      expect(el('cleanup-seat-remove-confirm-row')).toBeNull();
      act(() => el('cleanup-seat-branch-cancel')!.click());
      await flush();
      expect(api.deleteCompanySeatBranch).not.toHaveBeenCalled();
      expect(api.scan).toHaveBeenCalledTimes(2);
    });
  });

  describe('detail line', () => {
    const scanReturns = (entries: unknown[]) => {
      const api = (window as unknown as { electronAPI: { workTask: Record<string, unknown> } }).electronAPI.workTask;
      api.scan = vi.fn(async () => ({ ok: true, scannedRoot: '/wt', entries }));
    };
    afterEach(() => setLocale('en'));

    it('shows the localized text for a known detail code, not the raw detail', async () => {
      scanReturns([
        { category: 'orphan-dir', worktreePath: '/wt/abc/bare', detailCode: 'orphan-unlinked', detail: 'RAW-FROM-MAIN' },
      ]);
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      expect(container.textContent).toContain('No task or task record links to it — check it, then delete it.');
      expect(container.textContent).not.toContain('RAW-FROM-MAIN');
    });

    // Each code shows its own situation's line (a swapped mapping fails here).
    it.each([
      ['unmaterialized', 'worktask.cleanup.detail.unmaterialized'],
      ['preserved', 'worktask.cleanup.detail.preserved'],
      ['phone', 'worktask.cleanup.detail.phone'],
      ['orphan-ended', 'worktask.cleanup.detail.orphanEnded'],
      ['orphan-unlinked', 'worktask.cleanup.detail.orphanUnlinked'],
      ['orphan-meta', 'worktask.cleanup.detail.orphanMeta'],
      ['disk-missing', 'worktask.cleanup.detail.diskMissing'],
    ] as const)('detail code %s shows %s', async (code, key) => {
      scanReturns([{ category: 'orphan-dir', worktreePath: '/wt/abc/x', detailCode: code, detail: 'RAW-FROM-MAIN' }]);
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      expect(container.textContent).toContain(en[key]);
      expect(container.textContent).not.toContain('RAW-FROM-MAIN');
    });

    it('follows the UI language for the detail code', async () => {
      setLocale('de');
      scanReturns([
        { category: 'disk-missing', taskId: 'task-9', title: 'Gone', worktreePath: '/wt/abc/gone', detailCode: 'disk-missing', detail: 'RAW-FROM-MAIN' },
      ]);
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      expect(container.textContent).toContain('Der Worktree fehlt auf der Festplatte');
      expect(container.textContent).not.toContain('RAW-FROM-MAIN');
    });

    it('falls back to the raw detail when the code is unknown or absent (another main version)', async () => {
      scanReturns([
        { category: 'orphan-dir', worktreePath: '/wt/abc/new', detailCode: 'from-a-newer-main', detail: 'Detail from a newer main' },
        { category: 'orphan-dir', worktreePath: '/wt/abc/old', detail: 'Detail from an older main' },
      ]);
      act(() => root.render(createElement(WorktaskCleanupView)));
      await flush();
      expect(container.textContent).toContain('Detail from a newer main');
      expect(container.textContent).toContain('Detail from an older main');
    });
  });

  // #2388: Close and keep folder shows only after a refused close, never for
  // an unpushed branch, and closes the task through task:close with keepFolder.
  it('offers Close and keep folder after a refused close, and it closes keeping the folder', async () => {
    act(() => root.render(createElement(WorktaskCleanupView)));
    await flush();
    expect(container.querySelector('[data-cleanup-close-keep-folder]')).toBeNull();
    act(() => button('Close').click());
    await flush();
    await act(async () => { finishClose({ ok: false, reason: 'error', error: 'could not verify all processes exited' }); });
    await flush();
    const keep = container.querySelector('[data-cleanup-close-keep-folder]') as HTMLButtonElement;
    expect(keep?.textContent).toBe('Close and keep folder');
    act(() => keep.click());
    await flush();
    const close = (window as unknown as { electronAPI: { workTask: { close: ReturnType<typeof vi.fn> } } }).electronAPI.workTask.close;
    expect(close).toHaveBeenLastCalledWith('task-1', 'ws-task', { keepFolder: true });
    await act(async () => { finishClose({ ok: true, taskId: 'task-1', archivePending: false, keptFolder: '/wt/fix-parser' }); });
    await flush();
    expect(useStore.getState().toasts.some((toast) => toast.message === 'Task closed. Its folder was kept at /wt/fix-parser.')).toBe(true);
    expect(container.querySelector('[data-cleanup-close-keep-folder]')).toBeNull();
  });

  it('offers no Close and keep folder for an unpushed branch', async () => {
    act(() => root.render(createElement(WorktaskCleanupView)));
    await flush();
    act(() => button('Close').click());
    await flush();
    await act(async () => { finishClose({ ok: false, reason: 'unpushed', aheadCount: 1 }); });
    await flush();
    expect(container.querySelector('[data-cleanup-close-failed]')).not.toBeNull();
    expect(container.querySelector('[data-cleanup-close-keep-folder]')).toBeNull();
  });

  it('Commit & close leaves focus on the terminal holding the prepared line', async () => {
    act(() => root.render(createElement(WorktaskCleanupView)));
    await flush();
    act(() => button('Close').click());
    await flush();
    await act(async () => { finishClose({ ok: false, reason: 'dirty' }); });
    await flush();
    const commit = container.querySelector('[data-cleanup-commit-close]') as HTMLButtonElement;
    commit.focus();
    act(() => commit.click());
    await flush();
    expect(focusTerminal).toHaveBeenCalledTimes(1);
    expect(useStore.getState().worktaskCleanupVisible).toBe(false);
  });
});
