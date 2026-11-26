// #3068: a bulk a2a.task.cancel acts only for the caller's workspace, one
// task at a time through the single-task path, with a dry run that writes nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import { registerA2aRpc } from '../a2a.rpc';

const OWNERS: Record<string, string> = { 'pty-a': 'ws-a', 'pty-b': 'ws-b' };

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const win = () => ({}) as BrowserWindow;
const wire: RpcContext = { origin: 'local' };
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** The daemon's tasks: ws-a sent t-old and t-new, received t-in; t-foreign is ws-b's and ws-c's. */
const TASKS = [
  { id: 't-old', from: 'ws-a', to: 'ws-b', state: 'submitted', updatedAt: ago(10) },
  { id: 't-new', from: 'ws-a', to: 'ws-b', state: 'submitted', updatedAt: ago(1) },
  { id: 't-in', from: 'ws-b', to: 'ws-a', state: 'submitted', updatedAt: ago(20) },
  { id: 't-done', from: 'ws-a', to: 'ws-b', state: 'completed', updatedAt: ago(30) },
  { id: 't-foreign', from: 'ws-b', to: 'ws-c', state: 'submitted', updatedAt: ago(40) },
];

const daemonCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
const daemon = {
  rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
    daemonCalls.push({ method, params });
    const ws = params.workspaceId;
    if (method === 'a2a.task.query') {
      const mine = TASKS.filter((t) => (t.from === ws || t.to === ws) && (!params.status || t.state === params.status));
      return { ok: true, tasks: mine.map((t) => ({ id: t.id, status: { state: t.state }, metadata: { updatedAt: t.updatedAt } })) };
    }
    if (method === 'a2a.task.cancel') {
      const t = TASKS.find((x) => x.id === params.taskId);
      if (!t) return { ok: false, error: `a2a.task.cancel: task not found: ${String(params.taskId)}` };
      if (t.from !== ws && t.to !== ws) return { ok: false, error: `a2a.task.cancel: caller ${String(ws)} is not sender or receiver` };
      return params.dryRun === true
        ? { ok: true, dryRun: true, task: { id: t.id, status: { state: t.state } } }
        : { ok: true, task: { id: t.id, status: { state: 'canceled' } } };
    }
    return { ok: true };
  }),
} as unknown as DaemonClient;

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;
const handlers = new Map<string, Handler>();
registerA2aRpc(
  { register: (method: string, fn: Handler) => handlers.set(method, fn) } as unknown as RpcRouter,
  win,
  { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker,
  { getDaemonClient: () => daemon },
);
const cancel = (params: Record<string, unknown>) => (handlers.get('a2a.task.cancel') as Handler)(params, wire);
const realCancels = () => daemonCalls.filter((c) => c.method === 'a2a.task.cancel' && c.params.dryRun !== true);

beforeEach(() => {
  daemonCalls.length = 0;
  sendToRendererMock.mockReset();
  sendToRendererMock.mockImplementation(async (_win: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'input.findOwnerWorkspace') return { workspaceId: OWNERS[params.ptyId as string] ?? null };
    if (method === 'pane.list') return [];
    return { ok: true, taskId: params.taskId };
  });
});

describe('a2a.task.cancel in bulk', () => {
  it('an id list: another workspace\'s task is refused with today\'s message, the rest are canceled as the caller', async () => {
    const res = await cancel({ workspaceId: 'ws-a', senderPtyId: 'pty-a', taskIds: ['t-old', 't-foreign', 't-done', 't-in'] });
    expect(res).toEqual({
      ok: true,
      dryRun: false,
      canceled: ['t-old', 't-in'],
      refused: [{ taskId: 't-foreign', error: 'a2a.task.cancel: caller ws-a is not sender or receiver' }],
      unchanged: [{ taskId: 't-done', state: 'completed' }],
    });
    expect(realCancels().map((c) => [c.params.taskId, c.params.workspaceId])).toEqual([
      ['t-old', 'ws-a'], ['t-foreign', 'ws-a'], ['t-in', 'ws-a'],
    ]);
  });

  it('a state filter selects only the caller\'s own tasks past the age', async () => {
    const res = await cancel({ workspaceId: 'ws-a', senderPtyId: 'pty-a', state: 'submitted', olderThanDays: 7 });
    expect(res).toMatchObject({ ok: true, canceled: ['t-in', 't-old'], refused: [] });
    const query = daemonCalls.find((c) => c.method === 'a2a.task.query');
    expect(query?.params).toMatchObject({ workspaceId: 'ws-a', view: 'state', allTasks: true, status: 'submitted' });
  });

  it('a dry run lists the tasks and makes no change', async () => {
    const res = await cancel({ workspaceId: 'ws-a', senderPtyId: 'pty-a', state: 'submitted', olderThanDays: 7, dryRun: true });
    expect(res).toMatchObject({ ok: true, dryRun: true, wouldCancel: ['t-in', 't-old'], refused: [] });
    expect(realCancels()).toHaveLength(0);
    expect(sendToRendererMock.mock.calls.some(([, m]) => m === 'a2a.task.cancel')).toBe(false);
  });

  it('acts as the calling pane\'s workspace, never the one it names', async () => {
    const res = await cancel({ workspaceId: 'ws-c', senderPtyId: 'pty-a', state: 'submitted', olderThanDays: 0 });
    expect(res).toMatchObject({ error: expect.stringMatching(/not owned by workspace ws-c/) });
    expect(daemonCalls).toHaveLength(0);
  });

  it('refuses a mixed or incomplete selection', async () => {
    expect(await cancel({ workspaceId: 'ws-a', senderPtyId: 'pty-a', taskId: 't-old', taskIds: ['t-new'] })).toMatchObject({ error: expect.any(String) });
    expect(await cancel({ workspaceId: 'ws-a', senderPtyId: 'pty-a', state: 'completed', olderThanDays: 1 })).toMatchObject({ error: expect.stringMatching(/state must be one of/) });
    expect(await cancel({ workspaceId: 'ws-a', senderPtyId: 'pty-a', state: 'submitted' })).toMatchObject({ error: expect.stringMatching(/olderThanDays/) });
    expect(realCancels()).toHaveLength(0);
  });

  it('a single taskId cancel is unchanged', async () => {
    const res = await cancel({ workspaceId: 'ws-a', senderPtyId: 'pty-a', taskId: 't-old' });
    expect(res).toMatchObject({ ok: true });
    expect(daemonCalls.map((c) => c.method)).toEqual(['a2a.task.cancel']);
  });
});
