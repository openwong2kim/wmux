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

// Spread the real module: replacing it wholesale makes this test break the
// moment anything in the import graph reaches for another export (IPC, and
// friends). Only getPidMapDir needs redirecting.
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
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

// ── 패널 D: task.query 병합 — 데몬 정본이 더 최신이면 status/updatedAt 우선 ──

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

describe('a2a.task.query 병합 (패널 D)', () => {
  it('같은 id에서 데몬이 더 최신이면 status/updatedAt은 데몬 값, history는 렌더러 보존', async () => {
    const worker = makeWorker();
    // 렌더러 캐시: stale working(+ 증분 history 2건). 데몬 정본: completed(더 최신).
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
    expect((t.status as { state: string }).state).toBe('completed'); // 데몬 정본 우선
    expect((t.metadata as { updatedAt: string }).updatedAt).toBe('2026-07-07T00:05:00.000Z');
    expect(t.history).toEqual(['h1', 'h2']); // 렌더러 증분 보존
  });

  it('렌더러가 더 최신이면(증분 히스토리로 앞섬) 렌더러 유지 — 데몬-only id는 추가', async () => {
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
    expect((byId.get('t1')!.status as { state: string }).state).toBe('input-required'); // 렌더러가 최신 → 유지
    expect(byId.get('t2-restart-survivor')).toBeDefined(); // 데몬-only(재시작 생존분) 추가
  });
});

describe('a2a.task.query 델타: status 필터는 병합 후 적용(D override 보존)', () => {
  it('필터=working인데 데몬 정본=completed(더 최신)면 stale working이 결과에서 빠진다', async () => {
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
    // 데몬 override로 t1이 completed가 됐고 필터=working이라 결과에서 제외돼야 한다.
    expect(tasks).toHaveLength(0);
    // 데몬 조회는 status 무필터로 나갔다(정본을 필터로 숨기지 않기 위해).
    expect(daemonCalls[0]).not.toHaveProperty('status');
  });
});

describe('a2a.task.cancel 델타: terminal no-op은 거짓 cancelled 이벤트를 방출하지 않는다', () => {
  it('데몬이 completed(멱등 no-op) 반환 → 렌더러 cancel 라운드트립 없이 ok만', async () => {
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
    expect(worker.cancel).toHaveBeenCalledWith('t1'); // 워커는 여전히 취소
    // 종단 no-op → 렌더러 a2a.task.cancel(daemonCommitted) 미발행(거짓 이벤트 없음).
    const cancelSends = sendToRendererMock.mock.calls.filter((c) => c[1] === 'a2a.task.cancel');
    expect(cancelSends).toHaveLength(0);
  });

  it('데몬이 canceled(실취소) 반환 → 렌더러 daemonCommitted 발행', async () => {
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

// The brain owns no pane, so the renderer's reply-delivery guards suppressed
// every brain→worker nudge as an unverifiable sender. Main is the only place
// that knows the caller is a validated commander, so it must forward that
// binding — and only ever its own, never one the caller typed.
describe('a2a.task.send — commander binding is stamped, never trusted from the wire', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the validated commander workspace to the renderer', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true });
    const send = captureTaskSend(makeWorker());

    await send(
      { workspaceId: 'ws-brain', to: 'ws-brain', message: 'status?' },
      { origin: 'local', commanderWorkspace: 'ws-brain' } as unknown as RpcContext,
    );

    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'a2a.task.send',
      expect.objectContaining({ commanderWorkspaceId: 'ws-brain' }),
    );
  });

  // The relaxation is keyed on the binding naming the caller's OWN workspace,
  // so a brain that could still name a different `workspaceId` on the wire
  // would carry its privilege into someone else's.
  it('pins workspaceId to the validated binding, overriding what the caller named', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true });
    const send = captureTaskSend(makeWorker());

    await send(
      { workspaceId: 'ws-victim', to: 'ws-victim', message: 'do this' },
      { origin: 'local', commanderWorkspace: 'ws-brain' } as unknown as RpcContext,
    );

    const forwarded = sendToRendererMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(forwarded.workspaceId).toBe('ws-brain');
    expect(forwarded.commanderWorkspaceId).toBe('ws-brain');
  });

  it('leaves workspaceId alone for an ordinary caller', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true });
    const send = captureTaskSend(makeWorker());

    await send(
      { workspaceId: 'ws-a', to: 'ws-b', message: 'hi' },
      { origin: 'local' } as unknown as RpcContext,
    );

    const forwarded = sendToRendererMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(forwarded.workspaceId).toBe('ws-a');
  });

  it('drops a caller-supplied commanderWorkspaceId when there is no validated token', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true });
    const send = captureTaskSend(makeWorker());

    await send(
      { workspaceId: 'ws-a', to: 'ws-b', message: 'hi', commanderWorkspaceId: 'ws-victim' },
      { origin: 'local' } as unknown as RpcContext,
    );

    const forwarded = sendToRendererMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty('commanderWorkspaceId');
  });

  it('a validated token overrides a forged claim rather than merging with it', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true });
    const send = captureTaskSend(makeWorker());

    await send(
      { workspaceId: 'ws-brain', to: 'ws-b', message: 'hi', commanderWorkspaceId: 'ws-victim' },
      { origin: 'local', commanderWorkspace: 'ws-brain' } as unknown as RpcContext,
    );

    const forwarded = sendToRendererMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(forwarded.commanderWorkspaceId).toBe('ws-brain');
  });
});
