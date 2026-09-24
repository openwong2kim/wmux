// @vitest-environment jsdom
//
// The task cleanup list on ui/Dialog: it cannot be dismissed while a task
// close is in flight (the result lands in the list), and "Commit & close"
// leaves focus on the terminal holding the prepared line, so the next Enter
// runs it instead of reopening the list.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const focusTerminal = vi.fn();
vi.mock('../../../hooks/useTerminal', () => ({
  terminalRegistry: new Map([['pty-task', { focus: focusTerminal }]]),
}));

import { useStore } from '../../../stores';
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
