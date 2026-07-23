import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CompletionEvidence, Task } from '../../../shared/types';

// _bridge pulls in electron (ipcMain) so vitest must mock (same as ClaudeWorker.test.ts).
const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: sendToRendererMock }));

import { ClaudeWorker, type DaemonRpcLike } from '../ClaudeWorker';

const fakeWindow = {} as BrowserWindow;

function committedTaskFixture(state: string): Task {
  return {
    kind: 'task',
    id: 'task-1',
    status: { state: state as Task['status']['state'], timestamp: '2026-07-07T00:00:00.000Z' },
    history: [],
    artifacts: [],
    metadata: {
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
    },
  };
}

/** Drive completed transition via result line (through real evidence production path). */
async function driveCompleted(worker: ClaudeWorker): Promise<void> {
  const session = { proc: {} as never, taskId: 'task-1', lineBuffer: '', sessionId: 'sess-1' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (worker as any).processLine(
    session,
    'ws-receiver',
    JSON.stringify({ type: 'result', result: 'done', is_error: false, total_cost_usd: 0.01 }),
  );
  // fire-and-forget updateTaskStatus: flush microtasks for daemon rpc(await) → sendToRenderer order
  await vi.waitFor(() => expect(sendToRendererMock).toHaveBeenCalled());
}

describe('ClaudeWorker — C12 daemon canonical reroute (envelope PR4)', () => {
  beforeEach(() => sendToRendererMock.mockClear());

  it('transition commits via daemon a2a.task.update (with evidence·idempotency key) and renderer gets verbatim marker', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ ok: true, verifiedItemCount: 0, task: committedTaskFixture('completed') });
    const dc: DaemonRpcLike = { rpc: rpcMock };
    const worker = new ClaudeWorker(() => fakeWindow, () => dc);

    await driveCompleted(worker);

    // 1) Daemon commit reached (C12): domain:'a2a' append is A2aTaskService contract on daemon side
    //    (A2aTaskService.test.ts); here we pin worker→daemon RPC wiring.
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [method, params] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe('a2a.task.update');
    expect(params.taskId).toBe('task-1');
    expect(params.workspaceId).toBe('ws-receiver');
    expect(params.status).toBe('completed');
    // evidence preserved (§6.M PR-D′ wiring) — honest unverified self-report unchanged.
    const ev = params.evidence as CompletionEvidence;
    expect(ev.summary).toBe('done');
    expect(ev.items[0].kind).toBe('inspection');
    expect(ev.items[0].status).toBe('unverified');
    // Idempotency key (§4): retries must not double-commit the log.
    expect(params.idempotencyKey).toBe('claude-worker:task-1:completed');

    // 2) Renderer cache update: daemonCommitted marker + committedTask (verbatim apply instruction).
    //    Daemon commit precedes renderer call (invocationCallOrder).
    const rendererCall = sendToRendererMock.mock.calls.at(-1);
    expect(rendererCall?.[1]).toBe('a2a.task.update');
    const payload = rendererCall?.[2] as Record<string, unknown>;
    expect(payload.daemonCommitted).toBe(true);
    expect((payload.committedTask as Task).status.state).toBe('completed');
    expect(rpcMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendToRendererMock.mock.invocationCallOrder[0],
    );
  });

  it('falls back to renderer current path without marker on daemon reject (no silent success)', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ ok: false, error: 'a2a.task.update: invalid transition' });
    const worker = new ClaudeWorker(() => fakeWindow, () => ({ rpc: rpcMock }));

    await driveCompleted(worker);

    const payload = sendToRendererMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(payload.daemonCommitted).toBeUndefined();
    expect(payload.committedTask).toBeUndefined();
    expect(payload.status).toBe('completed'); // renderer validation writer rejudges (homomorphic gate)
  });

  it('renderer fallback even when daemon unavailable (rpc throw) — no transition loss', async () => {
    const rpcMock = vi.fn().mockRejectedValue(new Error('pipe closed'));
    const worker = new ClaudeWorker(() => fakeWindow, () => ({ rpc: rpcMock }));

    await driveCompleted(worker);

    const payload = sendToRendererMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(payload.daemonCommitted).toBeUndefined();
    expect(payload.status).toBe('completed');
  });

  it('without injected getter (legacy wiring) goes straight to renderer with no daemon hop', async () => {
    const worker = new ClaudeWorker(() => fakeWindow);
    await driveCompleted(worker);
    const payload = sendToRendererMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(payload.daemonCommitted).toBeUndefined();
    expect(payload.status).toBe('completed');
  });
});
