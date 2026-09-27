// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Task, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { remindPendingA2aTasks, resetTurnEndRemindersForTest } from '../a2aTurnEndReminder';

const PTY = 'pty-remind';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

const WS = { id: 'ws-r', name: 'R', rootPane: leaf('pane-r', PTY), activePaneId: 'pane-r' } as Workspace;

function task(id: string, state: Task['status']['state'], paneId: string | undefined, ts = '2026-09-27T00:00:00.000Z'): Task {
  return {
    kind: 'task',
    id,
    status: { state, timestamp: ts },
    history: [],
    artifacts: [],
    metadata: {
      title: id,
      from: { workspaceId: 'ws-s', name: 'S' },
      to: { workspaceId: 'ws-r', name: 'R', ...(paneId ? { paneId } : {}) },
      createdAt: ts,
      updatedAt: ts,
    },
  } as Task;
}

let gatedSubmit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTurnEndRemindersForTest();
  gatedSubmit = vi.fn(async () => ({ ok: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { rpc: { gatedSubmit } };
  useStore.setState({ workspaces: [WS], a2aTasks: {} });
});

describe('turn-end A2A reminder', () => {
  it('reminds once, with the count of submitted tasks pinned to the pane', async () => {
    useStore.setState({
      a2aTasks: {
        a: task('a', 'submitted', 'pane-r'),
        b: task('b', 'submitted', 'pane-r'),
        c: task('c', 'working', 'pane-r'),
        d: task('d', 'submitted', 'pane-other'),
      },
    });

    await remindPendingA2aTasks(PTY);
    await remindPendingA2aTasks(PTY);

    expect(gatedSubmit).toHaveBeenCalledTimes(1);
    expect(gatedSubmit.mock.calls[0][0]).toBe(PTY);
    expect(gatedSubmit.mock.calls[0][1]).toBe('[wmux] 2 A2A tasks still waiting for you — a2a_task_query');
  });

  it('writes nothing when nothing is waiting', async () => {
    useStore.setState({ a2aTasks: { c: task('c', 'completed', 'pane-r') } });
    await remindPendingA2aTasks(PTY);
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('a write the gate withheld is retried at the next turn end', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r') } });
    gatedSubmit.mockResolvedValueOnce({ ok: false, reason: 'approval_pending' });

    await remindPendingA2aTasks(PTY);
    await remindPendingA2aTasks(PTY);

    expect(gatedSubmit).toHaveBeenCalledTimes(2);
  });

  it('a reopened task is reminded again', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r') } });
    await remindPendingA2aTasks(PTY);
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r', '2026-09-27T01:00:00.000Z') } });
    await remindPendingA2aTasks(PTY);
    expect(gatedSubmit).toHaveBeenCalledTimes(2);
    expect(gatedSubmit.mock.calls[1][1]).toBe('[wmux] 1 A2A task still waiting for you — a2a_task_query');
  });
});
