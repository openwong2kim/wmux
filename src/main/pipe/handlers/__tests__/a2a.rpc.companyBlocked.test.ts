// Company mode: a new task whose brief names `blockedBy`. Main judges each
// blocker against the daemon's record before anything is stored, stores a
// task whose blockers are still open with no delivery, and keeps it only once
// the daemon holds it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc, type RemoteA2aRpcDeps } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import { COMPANY_BLOCKED_BY_REFUSAL, COMPANY_BLOCKERS_MAX, COMPANY_HOLD_KEY, companyBriefOfHistory, companyHoldAtCreate } from '../../../../shared/companyHold';
import type { Message, TaskState } from '../../../../shared/types';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const worker = { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker;
const WS = 'ws-co';
const NEW_ID = 'task-new';
const LINK = '11111111-1111-4111-8111-111111111111';

const brief = (blockedBy?: string[]) => ({
  kind: 'wmux.company.brief', v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r',
  ...(blockedBy ? { blockedBy } : {}),
});
const firstMessage = (data?: unknown): Message => ({
  kind: 'message',
  messageId: 'm1',
  role: 'user',
  parts: [{ kind: 'text', text: 'do it' }, ...(data ? [{ kind: 'data' as const, data: data as Record<string, unknown> }] : [])],
});

function task(id: string, state: TaskState, over: { to?: Record<string, unknown>; from?: Record<string, unknown>; history?: Message[] } = {}) {
  return {
    kind: 'task',
    id,
    status: { state, timestamp: 'x' },
    history: over.history ?? [firstMessage(brief())],
    artifacts: [],
    metadata: {
      title: id,
      from: over.from ?? { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' },
      to: over.to ?? { workspaceId: WS, name: 'Co', paneId: 'pane-dev' },
      createdAt: 'x',
      updatedAt: 'x',
    },
  };
}

type Daemon = {
  tasks: Map<string, ReturnType<typeof task>>;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  /**
   * What a2a.task.create answers: the real hold derivation (default; with
   * `holdForBlockers` a marker is kept even when nothing is open), one from a
   * daemon that keeps no hold, a refusal, or a throw.
   */
  create: 'derive' | 'noHold' | 'reject' | 'throw';
  /** Runs right before the create, to move a blocker in between. */
  beforeCreate?: () => void;
};

let daemon: Daemon;
let connected: boolean;
let daemonCancel: Record<string, unknown> = { ok: true };

const dc = {
  rpc: async (method: string, params: Record<string, unknown>) => {
    daemon.calls.push({ method, params });
    if (method === 'a2a.task.query') {
      const t = daemon.tasks.get(params.taskId as string);
      const visible = t && (t.metadata.from.workspaceId === params.workspaceId || t.metadata.to.workspaceId === params.workspaceId);
      return { ok: true, workspaceId: params.workspaceId, tasks: visible ? [t] : [] };
    }
    if (method === 'a2a.task.create') {
      daemon.beforeCreate?.();
      if (daemon.create === 'throw') throw new Error('daemon pipe closed');
      if (daemon.create === 'reject') return { ok: false, error: 'a2a.task.create: daemon log append failed (uncommitted)' };
      const history = params.history as Message[];
      const brief = companyBriefOfHistory(history);
      const derived = daemon.create === 'noHold' ? null : companyHoldAtCreate(brief, (id) => daemon.tasks.get(id)?.status.state);
      const hold = derived ?? (daemon.create !== 'noHold' && params.holdForBlockers === true && brief?.blockedBy?.length
        ? { blockedBy: [...new Set(brief.blockedBy)], waitingOn: [], releasedAt: 'y' }
        : null);
      const created = {
        kind: 'task',
        id: params.id,
        status: { state: 'submitted', timestamp: 'y' },
        history,
        artifacts: [],
        metadata: { title: params.title, from: params.from, to: params.to, createdAt: 'y', updatedAt: 'y', ...(hold ? { [COMPANY_HOLD_KEY]: hold } : {}) },
      };
      return { ok: true, taskId: params.id, task: created };
    }
    if (method === 'a2a.task.cancel') return daemonCancel;
    return { ok: true };
  },
} as unknown as DaemonClient;

let remote: RemoteA2aRpcDeps | undefined;
const pullNow = vi.fn();

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerA2aRpc(router, () => ({}) as BrowserWindow, worker, {
    getDaemonClient: () => (connected ? dc : null),
    companyRelease: () => ({ pullNow }),
    ...(remote ? { remote } : {}),
  });
  return router;
}

const PANES = [
  { id: 'pane-ceo', surfacePtyIds: ['pty-ceo'], companySeat: 'coordinator' },
  { id: 'pane-dev', surfacePtyIds: ['pty-dev'], companySeat: 'staff' },
  { id: 'pane-dev2', surfacePtyIds: ['pty-dev2'], companySeat: 'staff' },
];

const sendParams = (blockedBy: string[] | undefined, over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  to: WS,
  paneId: 'pane-dev2',
  senderPtyId: 'pty-ceo',
  title: 'C',
  message: 'build C',
  data: brief(blockedBy),
  ...over,
});

async function send(params: Record<string, unknown>, opts?: { operator: true }): Promise<Record<string, unknown>> {
  const res = await setup().dispatch({ id: 's', method: 'a2a.task.send', params }, opts);
  return (res as { result: Record<string, unknown> }).result;
}

const rendererCalls = (method: string): Array<Record<string, unknown>> =>
  sendToRendererMock.mock.calls.filter((c) => c[1] === method).map((c) => c[2] as Record<string, unknown>);
const daemonCalls = (method: string) => daemon.calls.filter((c) => c.method === method);

beforeEach(() => {
  sendToRendererMock.mockReset();
  pullNow.mockReset();
  connected = true;
  remote = undefined;
  daemon = { tasks: new Map(), calls: [], create: 'derive' };
  sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.task.send') {
      return {
        ok: true,
        taskId: NEW_ID,
        silent: params.silent === true,
        delivery: params.silent === true ? { stored: true, notified: false, reason: 'silent' } : { stored: true, notified: true, mode: 'nudge' },
        toWorkspaceId: WS,
        executeApproved: false,
        task: {
          id: NEW_ID,
          metadata: { title: 'C', from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' }, to: { workspaceId: WS, name: 'Co', paneId: 'pane-dev2' } },
          history: [firstMessage(params.data)],
        },
      };
    }
    if (method === 'a2a.company.discard') return { ok: true };
    if (method === 'pane.list') return PANES;
    return null;
  });
});

describe('a2a.task.send — each blocker is judged against the daemon before anything is stored', () => {
  it('refuses more blockers than a task may wait on, counting each id once', async () => {
    const ids = Array.from({ length: COMPANY_BLOCKERS_MAX + 1 }, (_, i) => `task-${i}`);
    const res = await send(sendParams([...ids, ids[0]]));
    expect(res.error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.tooMany(COMPANY_BLOCKERS_MAX + 1)}`);
    expect(daemon.calls).toEqual([]);
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('refuses a blocker that is a task with another PC, by its id or by its receiver', async () => {
    const rt = `rt-${'c'.repeat(32)}`;
    expect((await send(sendParams([rt]))).error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.remoteBlocker(rt)}`);
    daemon.tasks.set('task-a', task('task-a', 'working', { to: { workspaceId: `remote:${LINK}`, name: 'pc-b' } }));
    expect((await send(sendParams(['task-a']))).error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.remoteBlocker('task-a')}`);
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('refuses a blocker the daemon does not hold, even one only another workspace can see', async () => {
    expect((await send(sendParams(['task-gone']))).error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.unknown('task-gone')}`);
    daemon.tasks.set('task-x', task('task-x', 'working', { from: { workspaceId: 'ws-x', name: 'X' }, to: { workspaceId: 'ws-y', name: 'Y' } }));
    expect((await send(sendParams(['task-x']))).error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.unknown('task-x')}`);
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('refuses a blocker that is not a company task of this workspace', async () => {
    daemon.tasks.set('task-plain', task('task-plain', 'working', { history: [firstMessage()] }));
    expect((await send(sendParams(['task-plain']))).error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.otherCompany('task-plain')}`);
    daemon.tasks.set('task-out', task('task-out', 'working', { to: { workspaceId: 'ws-other', name: 'Other' } }));
    expect((await send(sendParams(['task-out']))).error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.otherCompany('task-out')}`);
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('refuses a blocker that failed or was canceled, naming it and how it ended', async () => {
    daemon.tasks.set('task-f', task('task-f', 'failed'));
    daemon.tasks.set('task-c', task('task-c', 'canceled'));
    expect((await send(sendParams(['task-f']))).error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.ended('task-f', 'failed')}`);
    expect((await send(sendParams(['task-c']))).error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.ended('task-c', 'canceled')}`);
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('asks the sender to retry when the daemon cannot be read, storing nothing', async () => {
    connected = false;
    expect((await send(sendParams(['task-a']))).error).toBe('a2a.task.send: wmux could not read task task-a to check blockedBy; retry');
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('a task whose blockers all completed is sent as any other, delivered now', async () => {
    daemon.tasks.set('task-a', task('task-a', 'completed'));
    const res = await send(sendParams(['task-a', 'task-a']));
    expect(daemonCalls('a2a.task.query')).toHaveLength(1);
    expect(rendererCalls('a2a.task.send')[0].silent).toBeUndefined();
    expect(res).toMatchObject({ ok: true, taskId: NEW_ID, delivery: { stored: true, notified: true, mode: 'nudge' } });
    const create = daemonCalls('a2a.task.create');
    expect(create).toHaveLength(1);
    expect(create[0].params.holdForBlockers).toBeUndefined();
  });

  it('reads each blocker as the sender\'s pane, or as the human on the operator lane', async () => {
    daemon.tasks.set('task-a', task('task-a', 'completed'));
    await send(sendParams(['task-a']));
    expect(daemonCalls('a2a.task.query')[0].params).toMatchObject({ workspaceId: WS, taskId: 'task-a', callerPaneId: 'pane-ceo' });
    expect(daemonCalls('a2a.task.query')[0].params.trustedLane).toBeUndefined();
    daemon.calls = [];
    await send(sendParams(['task-a'], { senderPtyId: undefined }), { operator: true });
    expect(daemonCalls('a2a.task.query')[0].params).toMatchObject({ taskId: 'task-a', trustedLane: true });
    expect(daemonCalls('a2a.task.query')[0].params.callerPaneId).toBeUndefined();
  });

  it('a reply carries no blockers: nothing is read for it', async () => {
    daemon.tasks.set(NEW_ID, task(NEW_ID, 'working'));
    sendToRendererMock.mockImplementation(async () => ({ ok: true, taskId: NEW_ID, preflight: { reopen: false } }));
    await send(sendParams(['task-gone'], { taskId: NEW_ID }));
    expect(daemonCalls('a2a.task.query')).toEqual([]);
  });

  it('refuses a task to another PC that names blockers, before anything is sent there', async () => {
    const sendTask = vi.fn();
    remote = {
      listTargets: async () => [{
        alias: 'pc-b/ws-b/codex', linkId: LINK, hostId: 'h', kind: 'pane',
        local: { workspaceId: WS, paneId: 'pane-ceo' }, remote: { workspaceId: 'ws-b', paneId: 'pane-b', label: 'codex' }, allowOutbound: true,
      }],
      sendTask, reply: vi.fn(), state: vi.fn(),
    } as unknown as RemoteA2aRpcDeps;
    const res = await send(sendParams(['task-a'], { to: 'pc-b/ws-b/codex', paneId: undefined }));
    expect(res.error).toBe(`a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.remoteTask}`);
    expect(sendTask).not.toHaveBeenCalled();
  });
});

describe('a2a.task.send — a task with an open blocker is held, durably', () => {
  beforeEach(() => {
    daemon.tasks.set('task-a', task('task-a', 'completed'));
    daemon.tasks.set('task-b', task('task-b', 'working'));
  });

  it('stores it with no delivery, has the daemon hold it, and says what it waits on', async () => {
    const res = await send(sendParams(['task-a', 'task-b']));
    expect(rendererCalls('a2a.task.send')[0].silent).toBe(true);
    const create = daemonCalls('a2a.task.create');
    expect(create).toHaveLength(1);
    expect(create[0].params).toMatchObject({ id: NEW_ID, holdForBlockers: true });
    expect(res).toMatchObject({
      ok: true,
      taskId: NEW_ID,
      // The caller did not ask for silent.
      silent: false,
      delivery: { stored: true, notified: false, reason: 'blocked', waitingOn: ['task-b'] },
    });
    expect((res.delivery as { hint: string }).hint).toContain('Waiting on task-b');
    expect(res.task).toBeUndefined();
    expect(rendererCalls('a2a.company.deliver')).toEqual([]);
  });

  it('refuses a held task that asks for a background worker, storing nothing', async () => {
    const res = await send(sendParams(['task-b'], { execute: true }));
    expect(res.error).toMatch(/^a2a\.task\.send: a task that waits on blockedBy goes to its pane/);
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('fails the send and drops the renderer\'s copy when the daemon refuses the create', async () => {
    daemon.create = 'reject';
    const res = await send(sendParams(['task-b']));
    expect(res.error).toBe(
      'a2a.task.send: the task waits on blockedBy, and wmux could not keep it on hold (a2a.task.create: daemon log append failed (uncommitted)); nothing was stored, send it again',
    );
    expect(rendererCalls('a2a.company.discard')).toEqual([{ taskId: NEW_ID }]);
  });

  it('fails the send and drops the renderer\'s copy when the daemon does not answer the create', async () => {
    daemon.create = 'throw';
    const res = await send(sendParams(['task-b']));
    expect(res.error).toContain('could not keep it on hold (the wmux daemon did not answer)');
    expect(rendererCalls('a2a.company.discard')).toEqual([{ taskId: NEW_ID }]);
  });

  it('leaves a task whose last blocker completed before the daemon created it to the bridge, never writing it here', async () => {
    daemon.beforeCreate = () => { daemon.tasks.set('task-b', task('task-b', 'completed')); };
    const res = await send(sendParams(['task-b']));
    expect(daemonCalls('a2a.task.create')[0].params.holdForBlockers).toBe(true);
    expect(res).toMatchObject({ ok: true, taskId: NEW_ID, silent: false, delivery: { stored: true, notified: false, reason: 'released' } });
    expect(pullNow).toHaveBeenCalledTimes(1);
    expect(rendererCalls('a2a.company.deliver')).toEqual([]);
  });

  it('fails the send when the daemon kept no hold for it', async () => {
    daemon.create = 'noHold';
    const res = await send(sendParams(['task-b']));
    expect(res.error).toContain('could not keep it on hold (the wmux daemon did not record the hold)');
    expect(rendererCalls('a2a.company.discard')).toEqual([{ taskId: NEW_ID }]);
  });
});

describe('a2a.task.update / a2a.task.cancel — a task that ends pulls the company release bridge', () => {
  it('pulls after a committed completed, failed or canceled, and not after working', async () => {
    const router = setup();
    for (const status of ['working', 'completed', 'failed']) {
      // eslint-disable-next-line no-await-in-loop -- one commit at a time
      await router.dispatch({ id: status, method: 'a2a.task.update', params: { taskId: 'task-a', workspaceId: WS, status } }, { operator: true });
    }
    expect(pullNow).toHaveBeenCalledTimes(2);
    daemonCancel = { ok: true, task: { id: 'task-a', status: { state: 'canceled' }, metadata: { updatedAt: 'z' } } };
    await router.dispatch({ id: 'c', method: 'a2a.task.cancel', params: { taskId: 'task-a', workspaceId: WS } }, { operator: true });
    expect(pullNow).toHaveBeenCalledTimes(3);
  });
});
