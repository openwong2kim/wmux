// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Task, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import {
  noteAgentTurnEnd,
  remindedSizeForTest,
  resetTurnEndRemindersForTest,
  sweepTurnEndReminders,
} from '../a2aTurnEndReminder';

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

function idleAgent(status: 'waiting' | 'running' | 'awaiting_input' = 'waiting'): void {
  useStore.getState().setSurfaceAgent(PTY, 'Claude Code', status, 'claude');
  useStore.getState().hydrateAgentAlive({ [PTY]: true });
  useStore.getState().hydrateCommandRunning({ [PTY]: true });
}

async function turnEnd(): Promise<void> {
  noteAgentTurnEnd(PTY);
  await sweepTurnEndReminders();
}

beforeEach(() => {
  resetTurnEndRemindersForTest();
  gatedSubmit = vi.fn(async () => ({ ok: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { rpc: { gatedSubmit } };
  useStore.setState({ workspaces: [WS], a2aTasks: {} });
  idleAgent();
});

describe('turn-end A2A reminder', () => {
  it('reminds once, counting every submitted task pinned to the pane', async () => {
    useStore.setState({
      a2aTasks: {
        a: task('a', 'submitted', 'pane-r'),
        b: task('b', 'submitted', 'pane-r'),
        c: task('c', 'working', 'pane-r'),
        d: task('d', 'submitted', 'pane-other'),
      },
    });
    await turnEnd();
    await turnEnd();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
    expect(gatedSubmit.mock.calls[0][0]).toBe(PTY);
    expect(gatedSubmit.mock.calls[0][1]).toBe('[wmux] 2 A2A tasks still waiting for you — a2a_task_query');
  });

  it('a new task later counts the one already reminded too', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r') } });
    await turnEnd();
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r'), b: task('b', 'submitted', 'pane-r') } });
    await turnEnd();
    expect(gatedSubmit).toHaveBeenCalledTimes(2);
    expect(gatedSubmit.mock.calls[1][1]).toBe('[wmux] 2 A2A tasks still waiting for you — a2a_task_query');
  });

  it('writes nothing when nothing is waiting', async () => {
    useStore.setState({ a2aTasks: { c: task('c', 'completed', 'pane-r') } });
    await turnEnd();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('never writes to a pane back at a shell prompt (#1489)', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r') } });
    useStore.getState().hydrateCommandRunning({ [PTY]: false });
    await turnEnd();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('never writes without a detected agent, or without proof it is alive', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r') } });
    useStore.getState().hydrateAgentAlive({});
    await turnEnd();
    useStore.getState().clearSurfaceAgent(PTY);
    await turnEnd();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('waits while the agent is busy, then writes once it is idle', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r') } });
    idleAgent('running');
    await turnEnd();
    idleAgent('awaiting_input');
    await sweepTurnEndReminders();
    expect(gatedSubmit).not.toHaveBeenCalled();
    idleAgent('waiting');
    await sweepTurnEndReminders();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
    // The stop was consumed: later sweeps write nothing more.
    await sweepTurnEndReminders();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
  });

  it('a write the gate withheld is retried at the next turn end', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r') } });
    gatedSubmit.mockResolvedValueOnce({ ok: false, reason: 'approval_pending' });
    await turnEnd();
    await turnEnd();
    expect(gatedSubmit).toHaveBeenCalledTimes(2);
  });

  it('a reopened task is reminded again', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r') } });
    await turnEnd();
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r', '2026-09-27T01:00:00.000Z') } });
    await turnEnd();
    expect(gatedSubmit).toHaveBeenCalledTimes(2);
    expect(gatedSubmit.mock.calls[1][1]).toBe('[wmux] 1 A2A task still waiting for you — a2a_task_query');
  });

  it('forgets reminded tasks once they are gone or picked up', async () => {
    useStore.setState({ a2aTasks: { a: task('a', 'submitted', 'pane-r'), b: task('b', 'submitted', 'pane-r') } });
    await turnEnd();
    expect(remindedSizeForTest()).toBe(2);
    useStore.setState({ a2aTasks: { b: task('b', 'working', 'pane-r') } });
    await sweepTurnEndReminders();
    expect(remindedSizeForTest()).toBe(0);
  });
});
