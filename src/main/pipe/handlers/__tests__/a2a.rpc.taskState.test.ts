import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const fakeWindow = {} as BrowserWindow;
const worker = {
  execute: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockReturnValue(true),
  isFull: false,
  stop: vi.fn(),
} as unknown as ClaudeWorker;

type DaemonCall = { method: string; params: Record<string, unknown> };

function setup(daemonRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>): RpcRouter {
  const router = new RpcRouter();
  const dc = { rpc: daemonRpc } as unknown as DaemonClient;
  registerA2aRpc(router, () => fakeWindow, worker, { getDaemonClient: () => dc });
  return router;
}

/**
 * A daemon that behaves like A2aTaskService for a task pinned to a receiver
 * pane: a caller that claims a pane identity without a resolved pane is
 * soft-deferred, a resolved pane must be the pinned one.
 */
function pinnedTaskDaemon(calls: DaemonCall[]) {
  return async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method !== 'a2a.task.update') return { ok: false, error: 'unexpected' };
    if (typeof params.senderPtyId === 'string' && typeof params.callerPaneId !== 'string') {
      return { ok: false, error: 'a2a.task.update: pane-authz deferred to renderer (pane-pinned task)' };
    }
    if (typeof params.callerPaneId === 'string' && params.callerPaneId !== 'pane-b') {
      return { ok: false, error: 'a2a.task.update: caller pane is not the addressed receiver pane' };
    }
    return {
      ok: true,
      task: { id: 't1', status: { state: params.status, timestamp: 'x' }, metadata: { updatedAt: 'x' } },
    };
  };
}

function rendererWithPanes(panes: unknown) {
  sendToRendererMock.mockImplementation(async (_w: unknown, method: string) => {
    if (method === 'pane.list') return panes;
    if (method === 'a2a.task.update') return { ok: true, taskId: 't1' };
    return null;
  });
}

function rendererUpdateCalls(): Array<Record<string, unknown>> {
  return sendToRendererMock.mock.calls.filter((c) => c[1] === 'a2a.task.update').map((c) => c[2] as Record<string, unknown>);
}

// An MCP-driven agent always forwards its senderPtyId, and a task sent to an
// agent pane is always pinned to that pane. The daemon cannot map a ptyId to a
// pane, so before this fix every such status update was deferred to the
// renderer cache only: the durable copy stayed `submitted` and came back after
// the cache dropped the task (30 min GC, app restart).
describe('a2a.task.update — a pane-identified caller commits to the daemon', () => {
  beforeEach(() => sendToRendererMock.mockReset());

  it('resolves the caller pane and lands the transition in the daemon', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes([
      { id: 'pane-a', surfacePtyIds: ['pty-other'] },
      { id: 'pane-b', surfacePtyIds: ['pty-b'] },
    ]);
    const router = setup(pinnedTaskDaemon(calls));

    const res = await router.dispatch({
      id: 'u1',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'working', senderPtyId: 'pty-b' },
    });

    expect(res.ok).toBe(true);
    const update = calls.find((c) => c.method === 'a2a.task.update');
    expect(update?.params.callerPaneId).toBe('pane-b');
    const sent = rendererUpdateCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].daemonCommitted).toBe(true);
    // The pane tree was read for the caller's own workspace, stashed panes included.
    const paneList = sendToRendererMock.mock.calls.find((c) => c[1] === 'pane.list');
    expect(paneList?.[2]).toEqual({ workspaceId: 'ws-b', includeStashed: true });
  });

  it('a sibling pane is refused by the daemon, not committed', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes([
      { id: 'pane-b', surfacePtyIds: ['pty-b'] },
      { id: 'pane-sibling', surfacePtyIds: ['pty-sibling'] },
    ]);
    const router = setup(pinnedTaskDaemon(calls));

    const res = await router.dispatch({
      id: 'u2',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'working', senderPtyId: 'pty-sibling' },
    });

    expect(((res as { result: { error?: string } }).result).error).toMatch(/not the addressed receiver pane/);
    expect(rendererUpdateCalls()).toHaveLength(0);
  });

  it('a ptyId outside the caller workspace is treated as absent (workspace authz), like the renderer does', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes([{ id: 'pane-b', surfacePtyIds: ['pty-b'] }]);
    const router = setup(pinnedTaskDaemon(calls));

    await router.dispatch({
      id: 'u3',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'working', senderPtyId: 'pty-foreign' },
    });

    const update = calls.find((c) => c.method === 'a2a.task.update');
    expect(update?.params).not.toHaveProperty('senderPtyId');
    expect(update?.params).not.toHaveProperty('callerPaneId');
    expect(rendererUpdateCalls()[0].daemonCommitted).toBe(true);
  });

  it('keeps the old deferral when the pane tree cannot be read', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes({ error: 'pane gate not ready', retryable: true });
    const router = setup(pinnedTaskDaemon(calls));

    await router.dispatch({
      id: 'u4',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'working', senderPtyId: 'pty-b' },
    });

    const update = calls.find((c) => c.method === 'a2a.task.update');
    expect(update?.params.senderPtyId).toBe('pty-b');
    expect(update?.params).not.toHaveProperty('callerPaneId');
    const sent = rendererUpdateCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].daemonCommitted).toBeUndefined();
  });
});

describe('reopen mirror — a sender message on an ended task reaches the daemon', () => {
  beforeEach(() => sendToRendererMock.mockReset());

  const reopenedTask = { id: 't9', status: { state: 'submitted', timestamp: 'x' }, metadata: { updatedAt: 'x' } };

  it('a reply that reopened the task is mirrored and the internal field is stripped', async () => {
    const calls: DaemonCall[] = [];
    sendToRendererMock.mockResolvedValue({ ok: true, taskId: 't9', reopenedTask });
    const router = setup(async (method, params) => {
      calls.push({ method, params });
      return { ok: true, reopened: true, task: reopenedTask };
    });

    const res = await router.dispatch({
      id: 's1',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-a', taskId: 't9', message: 'one more' },
    });

    expect(calls).toEqual([{ method: 'a2a.task.reopen', params: { taskId: 't9', workspaceId: 'ws-a' } }]);
    expect((res as { result: Record<string, unknown> }).result).not.toHaveProperty('reopenedTask');
  });

  it('a message-only update that reopened the task is mirrored too', async () => {
    const calls: DaemonCall[] = [];
    sendToRendererMock.mockResolvedValue({ ok: true, taskId: 't9', reopenedTask });
    const router = setup(async (method, params) => {
      calls.push({ method, params });
      return { ok: true, reopened: true, task: reopenedTask };
    });

    const res = await router.dispatch({
      id: 'u9',
      method: 'a2a.task.update',
      params: { workspaceId: 'ws-a', taskId: 't9', message: 'follow-up' },
    });

    expect(calls.map((c) => c.method)).toEqual(['a2a.task.reopen']);
    expect((res as { result: Record<string, unknown> }).result).not.toHaveProperty('reopenedTask');
  });

  it('a reply that did not reopen touches nothing in the daemon', async () => {
    const calls: DaemonCall[] = [];
    sendToRendererMock.mockResolvedValue({ ok: true, taskId: 't9' });
    const router = setup(async (method, params) => {
      calls.push({ method, params });
      return { ok: true };
    });

    await router.dispatch({ id: 's2', method: 'a2a.task.send', params: { workspaceId: 'ws-a', taskId: 't9', message: 'x' } });

    expect(calls).toEqual([]);
  });
});
