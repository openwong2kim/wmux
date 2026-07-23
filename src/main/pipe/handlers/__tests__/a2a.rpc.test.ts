import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { RpcContext } from '../../../../shared/rpc';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../../shared/constants', () => ({
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const fakeWindow = {} as BrowserWindow;

function makeWorker(): ClaudeWorker & { execute: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(true),
    isFull: false,
    stop: vi.fn(),
  } as unknown as ClaudeWorker & { execute: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
}

function setupRouter(worker: ClaudeWorker): RpcRouter {
  const router = new RpcRouter();
  registerA2aRpc(router, () => fakeWindow, worker);
  return router;
}

// remote/undefined-origin cases can't go through router.dispatch (it hard-codes
// origin:'local' at RpcRouter), so capture the registered a2a.task.send handler
// and invoke it directly with a synthetic context.
type TaskSendHandler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

function captureTaskSend(worker: ClaudeWorker): TaskSendHandler {
  let handler: TaskSendHandler | undefined;
  const capturing = {
    register: (method: string, fn: TaskSendHandler) => {
      if (method === 'a2a.task.send') handler = fn;
    },
  };
  registerA2aRpc(capturing as unknown as RpcRouter, () => fakeWindow, worker);
  if (!handler) throw new Error('a2a.task.send handler was not registered');
  return handler;
}

describe('a2a.rpc — execute confirmation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT spawn worker when execute is false', async () => {
    sendToRendererMock.mockResolvedValueOnce({ taskId: 'task-1' });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-1',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'hi' },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    // Only the initial a2a.task.send passthrough — no confirmExecute, no cancel
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send']);
  });

  it('spawns worker when renderer reports pre-create execute approval', async () => {
    sendToRendererMock.mockResolvedValueOnce({
      ok: true,
      taskId: 'task-2',
      toWorkspaceId: 'ws-to-resolved',
      executeApproved: true,
    });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-2',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'run this', execute: true, cwd: '/tmp/foo' },
    });

    expect(worker.execute).toHaveBeenCalledWith('task-2', 'ws-to-resolved', 'run this', '/tmp/foo');
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send']);
  });

  it('skips worker and does not cancel when renderer denies before task creation', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: false, error: 'a2a.task.send: execute approval denied' });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-3',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'do bad things', execute: true },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    const calls = sendToRendererMock.mock.calls.map((c) => ({ method: c[1], params: c[2] }));
    expect(calls.map((c) => c.method)).toEqual(['a2a.task.send']);
  });

  it('does not spawn when executeApproved is absent', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true, taskId: 'task-4', toWorkspaceId: 'ws-to' });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-4',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'no answer', execute: true },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send']);
  });

  it('does not spawn for replies even if execute:true is present', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: false, error: 'a2a.task.send: execute is only supported for new tasks' });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-5',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', taskId: 'existing-task', message: 'reply', execute: true },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send']);
  });

  it('ignores truthy non-boolean execute values', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true, taskId: 'task-6', toWorkspaceId: 'ws-to', executeApproved: true });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-6',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'do not execute', execute: 'true' },
    });

    expect(worker.execute).not.toHaveBeenCalled();
  });

  it('does NOT spawn for a remote-origin call even when approved (LanLink PR-1)', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true, taskId: 'task-remote', toWorkspaceId: 'ws-to', executeApproved: true });
    const worker = makeWorker();
    const handler = captureTaskSend(worker);

    await handler(
      { workspaceId: 'ws-from', to: 'ws-to', message: 'remote run', execute: true },
      { origin: 'remote' },
    );

    expect(worker.execute).not.toHaveBeenCalled();
  });

  it('does NOT spawn when the origin context is absent (fail-closed)', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true, taskId: 'task-noctx', toWorkspaceId: 'ws-to', executeApproved: true });
    const worker = makeWorker();
    const handler = captureTaskSend(worker);

    await handler(
      { workspaceId: 'ws-from', to: 'ws-to', message: 'no ctx', execute: true },
      undefined,
    );

    expect(worker.execute).not.toHaveBeenCalled();
  });
});

// ── Panel D: task.query merge — daemon source wins status/updatedAt when newer ──

import type { DaemonClient } from '../../../DaemonClient';

function setupRouterWithDaemon(
  worker: ClaudeWorker,
  daemonRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): RpcRouter {
  const router = new RpcRouter();
  const dc = { rpc: daemonRpc } as unknown as DaemonClient;
  registerA2aRpc(router, () => fakeWindow, worker, { getDaemonClient: () => dc });
  return router;
}

describe('a2a.task.query merge (panel D)', () => {
  it('when daemon is newer for same id, status/updatedAt from daemon, history preserved from renderer', async () => {
    const worker = makeWorker();
    // Renderer cache: stale working (+ 2 incremental history). Daemon source: completed (newer).
    sendToRendererMock.mockResolvedValueOnce({
      workspaceId: 'ws-r',
      tasks: [{
        id: 't1',
        status: { state: 'working', timestamp: '2026-07-07T00:00:00.000Z' },
        history: ['h1', 'h2'],
        metadata: { updatedAt: '2026-07-07T00:00:00.000Z', to: { workspaceId: 'ws-r' } },
      }],
    });
    const router = setupRouterWithDaemon(worker, async (method) => {
      if (method === 'a2a.task.query') {
        return { ok: true, tasks: [{
          id: 't1',
          status: { state: 'completed', timestamp: '2026-07-07T00:05:00.000Z' },
          history: [],
          metadata: { updatedAt: '2026-07-07T00:05:00.000Z', to: { workspaceId: 'ws-r' } },
        }] };
      }
      return { ok: false, error: 'unexpected' };
    });

    const res = await router.dispatch({ id: 'q1', method: 'a2a.task.query', params: { workspaceId: 'ws-r' } });
    expect(res.ok).toBe(true);
    const tasks = ((res as { result: unknown }).result as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect((t.status as { state: string }).state).toBe('completed'); // daemon source wins
    expect((t.metadata as { updatedAt: string }).updatedAt).toBe('2026-07-07T00:05:00.000Z');
    expect(t.history).toEqual(['h1', 'h2']); // renderer increment preserved
  });

  it('when renderer is newer (ahead via incremental history) keep renderer — append daemon-only ids', async () => {
    const worker = makeWorker();
    sendToRendererMock.mockResolvedValueOnce({
      workspaceId: 'ws-r',
      tasks: [{
        id: 't1',
        status: { state: 'input-required', timestamp: '2026-07-07T01:00:00.000Z' },
        metadata: { updatedAt: '2026-07-07T01:00:00.000Z', to: { workspaceId: 'ws-r' } },
      }],
    });
    const router = setupRouterWithDaemon(worker, async (method) => {
      if (method === 'a2a.task.query') {
        return { ok: true, tasks: [
          { id: 't1', status: { state: 'working', timestamp: '2026-07-07T00:30:00.000Z' }, metadata: { updatedAt: '2026-07-07T00:30:00.000Z', to: { workspaceId: 'ws-r' } } },
          { id: 't2-restart-survivor', status: { state: 'working', timestamp: '2026-07-07T00:00:00.000Z' }, metadata: { updatedAt: '2026-07-07T00:00:00.000Z', to: { workspaceId: 'ws-r' } } },
        ] };
      }
      return { ok: false, error: 'unexpected' };
    });

    const res = await router.dispatch({ id: 'q2', method: 'a2a.task.query', params: { workspaceId: 'ws-r' } });
    const tasks = ((res as { result: unknown }).result as { tasks: Array<Record<string, unknown>> }).tasks;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect((byId.get('t1')!.status as { state: string }).state).toBe('input-required'); // renderer newer → keep
    expect(byId.get('t2-restart-survivor')).toBeDefined(); // daemon-only (restart survivor) appended
  });
});

describe('a2a.task.query delta: status filter applied after merge (preserves D override)', () => {
  it('filter=working but daemon canonical=completed (newer) drops stale working from results', async () => {
    const worker = makeWorker();
    sendToRendererMock.mockResolvedValueOnce({
      workspaceId: 'ws-r',
      tasks: [{ id: 't1', status: { state: 'working', timestamp: '2026-07-07T00:00:00.000Z' },
        metadata: { updatedAt: '2026-07-07T00:00:00.000Z', to: { workspaceId: 'ws-r' } } }],
    });
    const daemonCalls: Array<Record<string, unknown>> = [];
    const router = setupRouterWithDaemon(worker, async (method, params) => {
      if (method === 'a2a.task.query') {
        daemonCalls.push(params);
        return { ok: true, tasks: [{ id: 't1', status: { state: 'completed', timestamp: '2026-07-07T00:05:00.000Z' },
          metadata: { updatedAt: '2026-07-07T00:05:00.000Z', to: { workspaceId: 'ws-r' } } }] };
      }
      return { ok: false, error: 'unexpected' };
    });

    const res = await router.dispatch({ id: 'q1', method: 'a2a.task.query', params: { workspaceId: 'ws-r', status: 'working' } });
    const tasks = ((res as { result: unknown }).result as { tasks: Array<Record<string, unknown>> }).tasks;
    // Daemon override made t1 completed; filter=working so excluded from results.
    expect(tasks).toHaveLength(0);
    // Daemon query went out without status filter (don't hide source behind filter).
    expect(daemonCalls[0]).not.toHaveProperty('status');
  });
});

describe('a2a.task.cancel delta: terminal no-op does not emit false cancelled event', () => {
  it('daemon returns completed (idempotent no-op) → ok only without renderer cancel round-trip', async () => {
    sendToRendererMock.mockClear();
    const worker = makeWorker();
    const router = setupRouterWithDaemon(worker, async (method) => {
      if (method === 'a2a.task.cancel') {
        return { ok: true, task: { id: 't1', status: { state: 'completed', timestamp: 'x' } } };
      }
      return { ok: false, error: 'unexpected' };
    });
    const res = await router.dispatch({ id: 'c1', method: 'a2a.task.cancel', params: { taskId: 't1', workspaceId: 'ws-r' } });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(worker.cancel).toHaveBeenCalledWith('t1'); // worker still cancelled
    // terminal no-op → no renderer a2a.task.cancel(daemonCommitted) (no false event).
    const cancelSends = sendToRendererMock.mock.calls.filter((c) => c[1] === 'a2a.task.cancel');
    expect(cancelSends).toHaveLength(0);
  });

  it('daemon returns canceled (real cancel) → renderer daemonCommitted published', async () => {
    sendToRendererMock.mockClear();
    sendToRendererMock.mockResolvedValue({ ok: true, taskId: 't2' });
    const worker = makeWorker();
    const router = setupRouterWithDaemon(worker, async (method) => {
      if (method === 'a2a.task.cancel') {
        return { ok: true, task: { id: 't2', status: { state: 'canceled', timestamp: 'x' } } };
      }
      return { ok: false, error: 'unexpected' };
    });
    await router.dispatch({ id: 'c2', method: 'a2a.task.cancel', params: { taskId: 't2', workspaceId: 'ws-r' } });
    const cancelSends = sendToRendererMock.mock.calls.filter((c) => c[1] === 'a2a.task.cancel');
    expect(cancelSends).toHaveLength(1);
    expect((cancelSends[0][2] as { daemonCommitted?: boolean }).daemonCommitted).toBe(true);
  });
});
