import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../../pipe/RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { DaemonClient } from '../../DaemonClient';
import { WorkLinkStore } from '../workLinkStore';
import { workLinkFromSentTask } from '../a2aProducer';
import { registerA2aRpc } from '../../pipe/handlers/a2a.rpc';
import { ClaudeWorker, type DaemonRpcLike } from '../../a2a/ClaudeWorker';

const h = vi.hoisted(() => ({
  sendToRenderer: vi.fn(),
  store: null as unknown,
}));

vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: h.sendToRenderer }));
vi.mock('../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));
vi.mock('../workLinkStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workLinkStore')>()),
  getWorkLinkStore: () => h.store,
}));


type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const local = { origin: 'local' } as RpcContext;
const worker = { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker;

function handlers(daemonRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  const router = { register: (method: string, fn: Handler) => { out[method] = fn; } } as unknown as RpcRouter;
  const dc = { rpc: daemonRpc } as unknown as DaemonClient;
  registerA2aRpc(router, () => ({}) as BrowserWindow, worker, { getDaemonClient: () => dc });
  return out;
}

const createdTask = {
  id: 'task-1',
  status: { state: 'submitted', timestamp: 'x' },
  metadata: {
    title: 'Fix the crash',
    from: { workspaceId: 'ws-hq', name: 'HQ', paneId: 'pane-hq' },
    to: { workspaceId: 'ws-1', name: 'One', paneId: 'pane-1' },
  },
  history: [],
};
const sendReply = () => ({ ok: true, taskId: 'task-1', toWorkspaceId: 'ws-1', delivery: { stored: true }, task: { ...createdTask } });

let dir: string;
let store: WorkLinkStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-worklink-a2a-'));
  store = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set() });
  h.store = store;
  h.sendToRenderer.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const settle = () => store.flush();

describe('workLinkFromSentTask', () => {
  it('maps a new task: receiver owns it, sender requested it', () => {
    expect(workLinkFromSentTask(sendReply(), { fromCommander: false })).toEqual({
      origin: 'manual',
      a2aTaskId: 'task-1',
      a2aState: 'submitted',
      owner: { workspaceId: 'ws-1', paneId: 'pane-1' },
      requester: { workspaceId: 'ws-hq', paneId: 'pane-hq' },
      title: 'Fix the crash',
    });
    expect(workLinkFromSentTask(sendReply(), { fromCommander: true })?.origin).toBe('moa');
  });

  it('is null for anything but a created task', () => {
    expect(workLinkFromSentTask({ ok: false, error: 'x' }, { fromCommander: false })).toBeNull();
    expect(workLinkFromSentTask({ ok: true, taskId: 'task-1' }, { fromCommander: false })).toBeNull();
    expect(workLinkFromSentTask({ ...sendReply(), toWorkspaceId: undefined, task: { id: 'task-1', metadata: {} } }, { fromCommander: false })).toBeNull();
  });
});

describe('a2a.rpc → work links', () => {
  const daemonOk = (state: string) => async (method: string) =>
    method === 'a2a.task.create'
      ? { ok: true, task: createdTask }
      : { ok: true, task: { id: 'task-1', status: { state, timestamp: 'x' }, metadata: {} } };

  it('a send creates the link and the caller still gets its reply without the task', async () => {
    h.sendToRenderer.mockResolvedValueOnce(sendReply());
    const res = await handlers(daemonOk('submitted'))['a2a.task.send']({ to: '1', message: 'go', workspaceId: 'ws-hq' }, local);
    expect(res).toMatchObject({ ok: true, taskId: 'task-1' });
    expect(res).not.toHaveProperty('task');
    await settle();
    expect(store.getByTaskId('task-1')).toMatchObject({ origin: 'manual', state: 'queued', owner: { workspaceId: 'ws-1' } });
  });

  it('a commander brain send is a Moa delegation', async () => {
    h.sendToRenderer.mockResolvedValueOnce(sendReply());
    await handlers(daemonOk('submitted'))['a2a.task.send']({ to: '1', message: 'go' }, { ...local, commanderWorkspace: 'ws-hq' });
    await settle();
    expect(store.getByTaskId('task-1')?.origin).toBe('moa');
  });

  it('a reply to an existing task creates nothing', async () => {
    h.sendToRenderer.mockResolvedValueOnce({ ok: true, taskId: 'task-1' });
    await handlers(daemonOk('submitted'))['a2a.task.send']({ to: '1', message: 'more', taskId: 'task-1' }, local);
    await settle();
    expect(store.list()).toEqual([]);
  });

  it('a store failure never fails the send', async () => {
    vi.spyOn(store, 'upsert').mockRejectedValue(new Error('disk full'));
    h.sendToRenderer.mockResolvedValueOnce(sendReply());
    const res = await handlers(daemonOk('submitted'))['a2a.task.send']({ to: '1', message: 'go' }, local);
    expect(res).toMatchObject({ ok: true, taskId: 'task-1' });
  });

  it('follows the task through the daemon-committed states to done', async () => {
    h.sendToRenderer.mockResolvedValueOnce(sendReply());
    await handlers(daemonOk('submitted'))['a2a.task.send']({ to: '1', message: 'go' }, local);
    for (const [state, expected] of [['working', 'running'], ['input-required', 'needs-you'], ['working', 'running'], ['completed', 'done']]) {
      h.sendToRenderer.mockResolvedValue({ ok: true, taskId: 'task-1' });
      await handlers(daemonOk(state))['a2a.task.update']({ taskId: 'task-1', workspaceId: 'ws-1', status: state }, local);
      await settle();
      expect(store.getByTaskId('task-1')?.state).toBe(expected);
    }
  });

  it('records a renderer-fallback update only when the renderer accepted it', async () => {
    await store.upsert(workLinkFromSentTask(sendReply(), { fromCommander: false })!);
    const unavailable = async () => ({ ok: false, error: 'task log unavailable' });
    h.sendToRenderer.mockResolvedValueOnce({ error: 'invalid transition' });
    await handlers(unavailable)['a2a.task.update']({ taskId: 'task-1', workspaceId: 'ws-1', status: 'failed' }, local);
    await settle();
    expect(store.getByTaskId('task-1')?.state).toBe('queued');
    h.sendToRenderer.mockResolvedValueOnce({ ok: true });
    await handlers(unavailable)['a2a.task.update']({ taskId: 'task-1', workspaceId: 'ws-1', status: 'failed' }, local);
    await settle();
    expect(store.getByTaskId('task-1')).toMatchObject({ state: 'blocked', reason: 'task-failed' });
  });

  it('leaves the link alone when the daemon refuses the transition', async () => {
    await store.upsert(workLinkFromSentTask(sendReply(), { fromCommander: false })!);
    const refuse = async () => ({ ok: false, error: 'invalid transition submitted->completed' });
    await handlers(refuse)['a2a.task.update']({ taskId: 'task-1', workspaceId: 'ws-1', status: 'completed' }, local);
    await settle();
    expect(store.getByTaskId('task-1')?.state).toBe('queued');
  });

  it('a cancel abandons the link, an already-ended no-op does not', async () => {
    await store.upsert(workLinkFromSentTask(sendReply(), { fromCommander: false })!);
    await handlers(daemonOk('completed'))['a2a.task.cancel']({ taskId: 'task-1', workspaceId: 'ws-hq' }, local);
    await settle();
    expect(store.getByTaskId('task-1')?.state).toBe('queued');
    h.sendToRenderer.mockResolvedValueOnce({ ok: true });
    await handlers(daemonOk('canceled'))['a2a.task.cancel']({ taskId: 'task-1', workspaceId: 'ws-hq' }, local);
    await settle();
    expect(store.getByTaskId('task-1')?.state).toBe('abandoned');
  });

  const issue = { host: 'github.com', owner: 'acme', repo: 'widget', number: 42, title: 'Crash on save', url: 'https://github.com/acme/widget/issues/42' };
  const issueLink = () => store.upsert({ origin: 'issue', issue, owner: { workspaceId: 'ws-1' }, title: 'Crash on save' });
  const operator = { ...local, operator: true } as RpcContext;

  it('a trusted send naming a work link joins it instead of making a twin', async () => {
    const link = (await issueLink())!;
    h.sendToRenderer.mockResolvedValueOnce(sendReply());
    await handlers(daemonOk('submitted'))['a2a.task.send']({ to: '1', message: 'go', workLinkId: link.id }, operator);
    await settle();
    expect(store.list()).toHaveLength(1);
    expect(store.get(link.id)).toMatchObject({ origin: 'issue', a2aTaskId: 'task-1', title: 'Crash on save', requester: { workspaceId: 'ws-hq' } });
    // The renderer never sees the main-only field.
    expect(h.sendToRenderer.mock.calls[0][2]).not.toHaveProperty('workLinkId');
  });

  it.each([
    ['an external caller', local, undefined],
    ['a link owned by another workspace', operator, { workspaceId: 'ws-2' }],
  ])('a named link is ignored for %s', async (_label, ctx, owner) => {
    const link = (await store.upsert({ origin: 'issue', issue, owner: owner ?? { workspaceId: 'ws-1' } }))!;
    h.sendToRenderer.mockResolvedValueOnce(sendReply());
    await handlers(daemonOk('submitted'))['a2a.task.send']({ to: '1', message: 'go', workLinkId: link.id }, ctx as RpcContext);
    await settle();
    expect(store.get(link.id)?.a2aTaskId).toBeUndefined();
    expect(store.getByTaskId('task-1')).toMatchObject({ origin: 'manual' });
  });

  it('a link that already carries another task is not joined', async () => {
    const link = (await store.upsert({ origin: 'issue', issue, owner: { workspaceId: 'ws-1' }, a2aTaskId: 'task-0' }))!;
    h.sendToRenderer.mockResolvedValueOnce(sendReply());
    await handlers(daemonOk('submitted'))['a2a.task.send']({ to: '1', message: 'go', workLinkId: link.id }, operator);
    await settle();
    expect(store.get(link.id)?.a2aTaskId).toBe('task-0');
    expect(store.getByTaskId('task-1')?.id).not.toBe(link.id);
  });

  it('a cache-only reopen (no daemon) moves the link back to queued', async () => {
    await store.upsert({ ...workLinkFromSentTask(sendReply(), { fromCommander: false })!, a2aState: 'canceled' });
    expect(store.getByTaskId('task-1')?.state).toBe('abandoned');
    h.sendToRenderer.mockImplementation(async (_w: unknown, _m: string, p: Record<string, unknown>) =>
      p.reopenPreflight ? { preflight: { reopen: true } } : { ok: true });
    const out: Record<string, Handler> = {};
    registerA2aRpc({ register: (m: string, fn: Handler) => { out[m] = fn; } } as unknown as RpcRouter, () => ({}) as BrowserWindow, worker, {});
    await out['a2a.task.update']({ taskId: 'task-1', workspaceId: 'ws-hq', message: 'one more thing' }, local);
    await settle();
    expect(store.getByTaskId('task-1')?.state).toBe('queued');
  });
});

describe('ClaudeWorker → work links', () => {
  const drive = async (rpc: () => Promise<unknown>, rendererReply: unknown) => {
    h.sendToRenderer.mockResolvedValue(rendererReply);
    await store.upsert(workLinkFromSentTask(sendReply(), { fromCommander: false })!);
    await store.upsert({ a2aTaskId: 'task-1', a2aState: 'working' });
    const w = new ClaudeWorker(() => ({}) as BrowserWindow, () => ({ rpc }) as DaemonRpcLike);
    const session = { proc: {} as never, taskId: 'task-1', lineBuffer: '', sessionId: 's' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).processLine(session, 'ws-1', JSON.stringify({ type: 'result', result: 'done', is_error: false, total_cost_usd: 0 }));
    await vi.waitFor(() => expect(h.sendToRenderer).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    return store.getByTaskId('task-1')?.state;
  };

  it('records the daemon-committed state', async () => {
    expect(await drive(async () => ({ ok: true, task: { id: 'task-1', status: { state: 'completed' } } }), { ok: true })).toBe('done');
  });

  it('records nothing when neither the daemon nor the renderer committed', async () => {
    expect(await drive(async () => ({ ok: false, error: 'invalid transition' }), { error: 'refused' })).toBe('running');
  });

  it('records the requested state once the renderer fallback accepted it', async () => {
    expect(await drive(async () => { throw new Error('daemon down'); }, { ok: true })).toBe('done');
  });
});
