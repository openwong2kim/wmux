import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMoaHandoffService } from '../../../deck/moaHandoff';
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

  it('a ptyId outside the caller workspace is treated as absent, like the renderer does', async () => {
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
    // An external caller must then prove its pane for a pinned task.
    expect(update?.params.requirePaneIdentity).toBe(true);
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

/** Renderer fake: answers preflights with `reopen`, records real calls. */
function rendererForReopen(reopen: boolean, panes: unknown = [{ id: 'pane-from', surfacePtyIds: ['pty-from'] }]) {
  sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'pane.list') return panes;
    if (params?.reopenPreflight === true) return { ok: true, preflight: { reopen } };
    return { ok: true, taskId: 't9' };
  });
}

function realCalls(method: string): Array<Record<string, unknown>> {
  return sendToRendererMock.mock.calls
    .filter((c) => c[1] === method && (c[2] as Record<string, unknown>).reopenPreflight !== true)
    .map((c) => c[2] as Record<string, unknown>);
}

describe('reopen — committed in the daemon first', () => {
  beforeEach(() => sendToRendererMock.mockReset());

  const reopenedTask = { id: 't9', status: { state: 'submitted', timestamp: 'T-reopen' }, metadata: { updatedAt: 'T-reopen' } };

  it('a reply that reopens: daemon commit, then the renderer gets the daemon snapshot', async () => {
    const calls: DaemonCall[] = [];
    rendererForReopen(true);
    const router = setup(async (method, params) => {
      calls.push({ method, params });
      return { ok: true, reopened: true, task: reopenedTask };
    });

    const res = await router.dispatch({
      id: 's1',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-a', taskId: 't9', message: 'one more', senderPtyId: 'pty-from' },
    });

    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ method: 'a2a.task.reopen', params: { taskId: 't9', workspaceId: 'ws-a', callerPaneId: 'pane-from' } }]);
    const real = realCalls('a2a.task.send');
    expect(real).toHaveLength(1);
    expect(real[0].daemonReopenedTask).toEqual(reopenedTask);
  });

  it('a failed daemon reopen stores nothing and reports the error', async () => {
    rendererForReopen(true);
    const router = setup(async () => ({ ok: false, error: 'a2a.task.reopen: daemon log append failed (uncommitted)' }));

    const res = await router.dispatch({
      id: 's2',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-a', taskId: 't9', message: 'one more' },
    });

    expect(((res as { result: { error?: string } }).result).error).toMatch(/could not reopen/);
    expect(realCalls('a2a.task.send')).toHaveLength(0);
  });

  it('a daemon that refuses the caller as sender stores nothing', async () => {
    rendererForReopen(true);
    const router = setup(async () => ({ ok: false, error: 'a2a.task.reopen: caller is not the verified sender of this task' }));
    const res = await router.dispatch({
      id: 's3',
      method: 'a2a.task.update',
      params: { workspaceId: 'ws-a', taskId: 't9', message: 'follow-up' },
    });
    expect(((res as { result: { error?: string } }).result).error).toMatch(/not the verified sender/);
    expect(realCalls('a2a.task.update')).toHaveLength(0);
  });

  it('a task the daemon does not hold reopens in the cache alone', async () => {
    rendererForReopen(true);
    const router = setup(async () => ({ ok: false, error: 'a2a.task.reopen: task not found: t9' }));
    await router.dispatch({ id: 's4', method: 'a2a.task.update', params: { workspaceId: 'ws-a', taskId: 't9', message: 'x' } });
    const real = realCalls('a2a.task.update');
    expect(real).toHaveLength(1);
    expect(real[0].localReopen).toBe(true);
  });

  it('no reopen wanted: the daemon is not touched', async () => {
    const calls: DaemonCall[] = [];
    rendererForReopen(false);
    const router = setup(async (method, params) => {
      calls.push({ method, params });
      return { ok: true };
    });
    await router.dispatch({ id: 's5', method: 'a2a.task.send', params: { workspaceId: 'ws-a', taskId: 't9', message: 'x' } });
    expect(calls).toEqual([]);
    expect(realCalls('a2a.task.send')[0]).not.toHaveProperty('daemonReopenedTask');
  });

  it('internal fields supplied on the wire are dropped', async () => {
    rendererForReopen(false);
    const router = setup(async () => ({ ok: true }));
    await router.dispatch({
      id: 's6',
      method: 'a2a.task.send',
      params: {
        workspaceId: 'ws-a', taskId: 't9', message: 'x',
        daemonReopenedTask: reopenedTask, localReopen: true, daemonCommitted: true, committedTask: reopenedTask,
      },
    });
    const real = realCalls('a2a.task.send')[0];
    for (const k of ['daemonReopenedTask', 'localReopen', 'daemonCommitted', 'committedTask']) {
      expect(real).not.toHaveProperty(k);
    }
  });
});

describe('a2a.task.update — pane-pinned tasks need a verified pane from external callers', () => {
  beforeEach(() => sendToRendererMock.mockReset());

  it('an external caller without senderPtyId asks the daemon to require a pane', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes([{ id: 'pane-b', surfacePtyIds: ['pty-b'] }]);
    const router = setup(async (method, params) => {
      calls.push({ method, params });
      return { ok: false, error: 'a2a.task.update: this task is pinned to a pane; only that pane can update it (no verified pane identity)' };
    });
    const res = await router.dispatch({
      id: 'r1', method: 'a2a.task.update', params: { taskId: 't1', workspaceId: 'ws-b', status: 'working' },
    });
    expect(calls[0].params.requirePaneIdentity).toBe(true);
    expect(((res as { result: { error?: string } }).result).error).toMatch(/pinned to a pane/);
    expect(rendererUpdateCalls()).toHaveLength(0);
  });

  it('the operator lane is trusted as before', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes([]);
    const router = setup(async (method, params) => {
      calls.push({ method, params });
      return { ok: true, task: { id: 't1', status: { state: 'working', timestamp: 'x' }, metadata: { updatedAt: 'x' } } };
    });
    await router.dispatch(
      { id: 'r2', method: 'a2a.task.update', params: { taskId: 't1', workspaceId: 'ws-b', status: 'working' } },
      { operator: true },
    );
    expect(calls[0].params).not.toHaveProperty('requirePaneIdentity');
    expect(rendererUpdateCalls()[0].requirePaneIdentity).toBe(false);
  });
});

describe('a2a.task.update — #1598 orphaned tasks and receiver cancel', () => {
  beforeEach(() => {
    sendToRendererMock.mockReset();
    vi.mocked(worker.cancel).mockClear();
  });

  const okDaemon = (calls: DaemonCall[]) => async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { ok: true, task: { id: 't1', status: { state: params.status, timestamp: 'x' }, metadata: { updatedAt: 'x' } } };
  };

  it('hands the daemon the live panes of the same read, never a wire-supplied list', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes([
      { id: 'pane-a', surfacePtyIds: ['pty-a'] },
      { id: 'pane-b', surfacePtyIds: ['pty-b'] },
    ]);
    const router = setup(okDaemon(calls));
    await router.dispatch({
      id: 'o1',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'working', senderPtyId: 'pty-b', livePaneIds: ['forged'] },
    });
    expect(calls[0].params.livePaneIds).toEqual(['pane-a', 'pane-b']);
    expect(rendererUpdateCalls()[0]).not.toHaveProperty('livePaneIds');
  });

  it('a pane-less caller sends no pane list, so nothing can look orphaned', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes([{ id: 'pane-b', surfacePtyIds: ['pty-b'] }]);
    const router = setup(okDaemon(calls));
    await router.dispatch({
      id: 'o2',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'working', livePaneIds: [] },
    });
    expect(calls[0].params).not.toHaveProperty('livePaneIds');
  });

  it('a committed receiver cancel stops the background worker', async () => {
    const calls: DaemonCall[] = [];
    rendererWithPanes([{ id: 'pane-b', surfacePtyIds: ['pty-b'] }]);
    const router = setup(okDaemon(calls));
    await router.dispatch({
      id: 'o3',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'canceled', evidence: { summary: 'superseded', items: [] } },
    });
    expect(calls[0].params.status).toBe('canceled');
    expect(worker.cancel).toHaveBeenCalledWith('t1');
  });

  it('a daemon-committed cancel stops the worker even when the renderer call throws', async () => {
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) => {
      if (method === 'pane.list') return [{ id: 'pane-b', surfacePtyIds: ['pty-b'] }];
      throw new Error('renderer timeout');
    });
    const router = setup(okDaemon([]));
    await router.dispatch({
      id: 'o5',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'canceled', evidence: { summary: 'superseded', items: [] } },
    });
    expect(worker.cancel).toHaveBeenCalledWith('t1');
  });

  it('in the renderer fallback only an explicit ok stops the worker', async () => {
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) =>
      (method === 'pane.list' ? [{ id: 'pane-b', surfacePtyIds: ['pty-b'] }] : undefined));
    const router = setup(async () => ({ ok: false, error: 'a2a.task.update: task log unavailable' }));
    await router.dispatch({
      id: 'o6',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'canceled', evidence: { summary: 'superseded', items: [] } },
    });
    expect(worker.cancel).not.toHaveBeenCalled();
  });

  it('a refused cancel leaves the worker running', async () => {
    rendererWithPanes([{ id: 'pane-b', surfacePtyIds: ['pty-b'] }]);
    const router = setup(async () => ({ ok: false, error: 'a2a.task.update: cancel_reason_missing: x' }));
    await router.dispatch({
      id: 'o4',
      method: 'a2a.task.update',
      params: { taskId: 't1', workspaceId: 'ws-b', status: 'canceled' },
    });
    expect(worker.cancel).not.toHaveBeenCalled();
  });
});

describe('a2a.task.update — the HQ closes a hand-off it proposed', () => {
  beforeEach(() => sendToRendererMock.mockReset());
  afterEach(() => setMoaHandoffService(null));

  function handoffs(complete = vi.fn(async () => ({ ok: true as const, result: 'done: wrote hi' }))) {
    setMoaHandoffService({
      byTask: (id: string) => (id === 't-h' ? { hqWorkspaceId: 'ws-hq' } : null),
      requesterComplete: complete,
    } as never);
    return complete;
  }

  it('a caller proving its pane in the HQ goes through the hand-off service, not the receiver rules', async () => {
    const complete = handoffs();
    const calls: DaemonCall[] = [];
    rendererWithPanes([{ id: 'pane-hq', surfacePtyIds: ['pty-hq'] }]);
    const res = await setup(pinnedTaskDaemon(calls)).dispatch({
      id: 'h1', method: 'a2a.task.update',
      params: { taskId: 't-h', workspaceId: 'ws-hq', status: 'completed', senderPtyId: 'pty-hq' },
    });
    expect((res as { result: unknown }).result).toEqual({ ok: true, taskId: 't-h', status: 'completed', result: 'done: wrote hi' });
    expect(complete).toHaveBeenCalledWith('ws-hq', 't-h');
    expect(calls).toHaveLength(0);
  });

  it('a refusal (the worker is still working) comes back as an error and moves nothing', async () => {
    handoffs(vi.fn(async () => ({ ok: false as const, code: 'target_working' as const })) as never);
    rendererWithPanes([{ id: 'pane-hq', surfacePtyIds: ['pty-hq'] }]);
    const res = await setup(pinnedTaskDaemon([])).dispatch({
      id: 'h2', method: 'a2a.task.update',
      params: { taskId: 't-h', workspaceId: 'ws-hq', status: 'completed', senderPtyId: 'pty-hq' },
    });
    expect(((res as { result: { error?: string } }).result).error).toMatch(/target_working/);
    expect(rendererUpdateCalls()).toHaveLength(0);
  });

  it('no proof of being the HQ, or another workspace, is never routed to the close', async () => {
    const complete = handoffs();
    rendererWithPanes([{ id: 'pane-hq', surfacePtyIds: ['pty-hq'] }]);
    const unproven = await setup(pinnedTaskDaemon([])).dispatch({
      id: 'h3', method: 'a2a.task.update',
      params: { taskId: 't-h', workspaceId: 'ws-hq', status: 'completed', senderPtyId: 'pty-forged' },
    });
    expect(((unproven as { result: { error?: string } }).result).error).toMatch(/only the HQ that proposed/);
    const calls: DaemonCall[] = [];
    await setup(pinnedTaskDaemon(calls)).dispatch({
      id: 'h4', method: 'a2a.task.update',
      params: { taskId: 't-h', workspaceId: 'ws-other', status: 'completed', senderPtyId: 'pty-hq' },
    });
    expect(complete).not.toHaveBeenCalled();
    // The other workspace took the ordinary receiver path.
    expect(calls.some((c) => c.method === 'a2a.task.update')).toBe(true);
  });
});
