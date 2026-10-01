import { describe, expect, it, vi } from 'vitest';
import { daemonOpenTaskOnPane, gatedSubmitTaskContext, makeDaemonTaskQuery } from '../a2aOpenTasks';
import type { DaemonClient } from '../../../DaemonClient';

const PANE = { workspaceId: 'ws-1', paneId: 'pane-1', surfaceId: 'surf-1' };

describe('daemonOpenTaskOnPane (#1680)', () => {
  const task = (id: string, state: string | undefined, to: Record<string, unknown>, from: Record<string, unknown> = { workspaceId: 'ws-x' }) => ({
    id,
    ...(state ? { status: { state } } : {}),
    metadata: { to, from },
  });

  it('finds an open task pinned to the pane by pane, surface or pty, on either side', async () => {
    for (const t of [
      task('a', 'working', { workspaceId: 'ws-1', paneId: 'pane-1' }),
      task('b', 'input-required', { workspaceId: 'ws-x' }, { workspaceId: 'ws-1', surfaceId: 'surf-1' }),
      task('c', 'submitted', { workspaceId: 'ws-1', ptyId: 'pty-1' }),
      // An unreadable state counts as open: never fail open.
      task('d', undefined, { workspaceId: 'ws-1', paneId: 'pane-1' }),
    ]) {
      expect(await daemonOpenTaskOnPane(async () => [t], 'pty-1', PANE, 'new')).toBe('open_a2a_task');
    }
  });

  it('ignores ended tasks, the delivered task, and other panes or workspaces', async () => {
    const tasks = [
      task('done', 'completed', { workspaceId: 'ws-1', paneId: 'pane-1' }),
      task('new', 'submitted', { workspaceId: 'ws-1', paneId: 'pane-1' }),
      task('other-pane', 'working', { workspaceId: 'ws-1', paneId: 'pane-2' }),
      task('other-ws', 'working', { workspaceId: 'ws-2', paneId: 'pane-1' }),
    ];
    expect(await daemonOpenTaskOnPane(async () => tasks, 'pty-1', PANE, 'new')).toBeUndefined();
  });

  it('answers a2a_tasks_unknown without a pane address or a readable store', async () => {
    expect(await daemonOpenTaskOnPane(async () => [], 'pty-1', undefined, 'new')).toBe('a2a_tasks_unknown');
    expect(await daemonOpenTaskOnPane(async () => null, 'pty-1', PANE, 'new')).toBe('a2a_tasks_unknown');
  });

  it("reads the daemon's a2a.task.query, and null on any failure", async () => {
    const rpc = vi.fn(async () => ({ ok: true, tasks: [{ id: 'x' }] }));
    const dc = { isConnected: true, rpc } as unknown as DaemonClient;
    expect(await makeDaemonTaskQuery(() => dc)('ws-1')).toEqual([{ id: 'x' }]);
    expect(rpc).toHaveBeenCalledWith('a2a.task.query', { workspaceId: 'ws-1', view: 'anchors' }, { timeoutMs: 2_000 });
    rpc.mockResolvedValueOnce({ ok: false, error: 'task log unavailable' } as never);
    expect(await makeDaemonTaskQuery(() => dc)('ws-1')).toBeNull();
    rpc.mockRejectedValueOnce(new Error('pipe closed'));
    expect(await makeDaemonTaskQuery(() => dc)('ws-1')).toBeNull();
    expect(await makeDaemonTaskQuery(() => null)('ws-1')).toBeNull();
  });
});

describe('an older daemon that ignores the anchors view (#1680 review N2)', () => {
  it('answers with full tasks, which are read the same way', async () => {
    const fullTask = {
      kind: 'task',
      id: 'old',
      status: { state: 'working', timestamp: 't' },
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'long history' }] }],
      artifacts: [],
      metadata: { title: 'x', to: { workspaceId: 'ws-1', name: 'W', paneId: 'pane-1' }, from: { workspaceId: 'ws-2', name: 'S' } },
    };
    const dc = { isConnected: true, rpc: vi.fn(async () => ({ ok: true, tasks: [fullTask] })) } as unknown as DaemonClient;
    expect(await daemonOpenTaskOnPane(makeDaemonTaskQuery(() => dc), 'pty-1', PANE, 'new')).toBe('open_a2a_task');
  });
});

describe('gatedSubmitTaskContext', () => {
  it('keeps only a well-formed task id and a complete pane address', () => {
    expect(gatedSubmitTaskContext({ taskId: 't-1', pane: PANE })).toEqual({ taskId: 't-1', pane: PANE });
    expect(gatedSubmitTaskContext({ taskId: 7, pane: { ...PANE, surfaceId: '' } })).toEqual({});
    expect(gatedSubmitTaskContext({ taskId: 'x'.repeat(201) })).toEqual({});
    expect(gatedSubmitTaskContext(null)).toEqual({});
  });
});
