import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CompletionEvidence, Task } from '../../../shared/types';

// _bridge 는 electron(ipcMain)을 끌어오므로 vitest 에서 mock(기존 ClaudeWorker.test.ts 동형).
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

/** result 라인으로 completed 전이를 구동(실제 증거 생산 경로 경유). */
async function driveCompleted(worker: ClaudeWorker): Promise<void> {
  const session = { proc: {} as never, taskId: 'task-1', lineBuffer: '', sessionId: 'sess-1' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (worker as any).processLine(
    session,
    'ws-receiver',
    JSON.stringify({ type: 'result', result: 'done', is_error: false, total_cost_usd: 0.01 }),
  );
  // fire-and-forget updateTaskStatus: 데몬 rpc(await) → sendToRenderer 순 마이크로태스크 플러시
  await vi.waitFor(() => expect(sendToRendererMock).toHaveBeenCalled(), { timeout: 5_000 });
}

describe('ClaudeWorker — C12 데몬 정본 재배선 (envelope PR4)', () => {
  beforeEach(() => sendToRendererMock.mockClear());

  it('전이가 데몬 a2a.task.update로 커밋되고(evidence·멱등키 동반) 렌더러엔 verbatim 마커가 실린다', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ ok: true, verifiedItemCount: 0, task: committedTaskFixture('completed') });
    const dc: DaemonRpcLike = { rpc: rpcMock };
    const worker = new ClaudeWorker(() => fakeWindow, () => dc);

    await driveCompleted(worker);

    // 1) 데몬 커밋 도달(C12): domain:'a2a' append는 데몬측 A2aTaskService 계약
    //    (A2aTaskService.test.ts)이고, 여기서는 워커→데몬 RPC 배선을 고정한다.
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [method, params] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe('a2a.task.update');
    expect(params.taskId).toBe('task-1');
    expect(params.workspaceId).toBe('ws-receiver');
    expect(params.status).toBe('completed');
    // evidence 동반 유지(§6.M PR-D′ 배선 보존) — 정직 unverified 자기보고 그대로.
    const ev = params.evidence as CompletionEvidence;
    expect(ev.summary).toBe('done');
    expect(ev.items[0].kind).toBe('inspection');
    expect(ev.items[0].status).toBe('unverified');
    // 멱등키(§4): 재시도가 로그를 이중 커밋하지 않게.
    expect(params.idempotencyKey).toBe('claude-worker:task-1:completed');

    // 2) 렌더러 캐시 갱신: daemonCommitted 마커 + committedTask(verbatim 적용 지시).
    //    데몬 커밋이 렌더러 호출보다 선행한다(invocationCallOrder).
    const rendererCall = sendToRendererMock.mock.calls.at(-1);
    expect(rendererCall?.[1]).toBe('a2a.task.update');
    const payload = rendererCall?.[2] as Record<string, unknown>;
    expect(payload.daemonCommitted).toBe(true);
    expect((payload.committedTask as Task).status.state).toBe('completed');
    expect(rpcMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendToRendererMock.mock.invocationCallOrder[0],
    );
  });

  it('데몬 거부 시 마커 없이 렌더러 현행 경로로 폴백(조용한 성공 위장 없음)', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ ok: false, error: 'a2a.task.update: invalid transition' });
    const worker = new ClaudeWorker(() => fakeWindow, () => ({ rpc: rpcMock }));

    await driveCompleted(worker);

    const payload = sendToRendererMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(payload.daemonCommitted).toBeUndefined();
    expect(payload.committedTask).toBeUndefined();
    expect(payload.status).toBe('completed'); // 렌더러 검증 writer가 재판정(동형 게이트)
  });

  it('데몬 미가용(rpc throw)도 렌더러 폴백 — 전이 유실 없음', async () => {
    const rpcMock = vi.fn().mockRejectedValue(new Error('pipe closed'));
    const worker = new ClaudeWorker(() => fakeWindow, () => ({ rpc: rpcMock }));

    await driveCompleted(worker);

    const payload = sendToRendererMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(payload.daemonCommitted).toBeUndefined();
    expect(payload.status).toBe('completed');
  });

  it('게터 미주입(구 배선)이면 데몬 경유 없이 현행 렌더러 직행 그대로', async () => {
    const worker = new ClaudeWorker(() => fakeWindow);
    await driveCompleted(worker);
    const payload = sendToRendererMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(payload.daemonCommitted).toBeUndefined();
    expect(payload.status).toBe('completed');
  });
});
