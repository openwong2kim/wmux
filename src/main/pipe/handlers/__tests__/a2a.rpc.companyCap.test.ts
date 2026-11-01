// Company mode: the per-PC cap on working staff seats at send. A new brief
// that would make one more seat work while every slot is taken is held like
// a task waiting on its blockers (stored silently, a released marker in the
// daemon) and its receipt names the cap and the seats holding the slots.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import { CompanySlotGate, type CompanyWorkingCount, type CompanyWorkingSeat } from '../../../a2a/CompanyReleaseBridge';
import { COMPANY_HOLD_KEY, companyCapHint } from '../../../../shared/companyHold';
import type { Message } from '../../../../shared/types';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const worker = { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker;
const WS = 'ws-co';

const BRIEF = { kind: 'wmux.company.brief', v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' };
const seat = (paneId: string, name = `#${paneId}`): CompanyWorkingSeat => ({ workspaceId: WS, paneId, name });

/** The staff seats of the company, and which of them work (what the count read answers). */
let staff: string[];
let working: CompanyWorkingSeat[];
let cap: number;
let readable: boolean;
let reads: number;
let createHold: boolean;
const pullNow = vi.fn();
let created: Array<Record<string, unknown>>;
let taskSeq: number;
/** Every renderer send waits on this when set. */
let rendererGate: Promise<void> | null;

function count(): CompanyWorkingCount | null {
  reads += 1;
  if (!readable) return null;
  return {
    staff: new Map(staff.map((id) => [id, { workspaceId: WS, name: `#${id}`, alive: true }])),
    working: [...working],
  };
}

const dc = {
  rpc: async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.task.create') {
      created.push(params);
      const hold = params.holdForBlockers === true
        ? { blockedBy: ['task-a'], waitingOn: ['task-a'] }
        : createHold && params.holdForSlot === true ? { blockedBy: [], waitingOn: [], releasedAt: 'y' } : null;
      return {
        ok: true,
        taskId: params.id,
        task: {
          kind: 'task',
          id: params.id,
          status: { state: 'submitted', timestamp: 'y' },
          history: params.history,
          artifacts: [],
          metadata: { title: params.title, from: params.from, to: params.to, createdAt: 'y', updatedAt: 'y', ...(hold ? { [COMPANY_HOLD_KEY]: hold } : {}) },
        },
      };
    }
    if (method === 'a2a.task.query') {
      // task-a: an open company task of this workspace, which a brief may wait on.
      const blocker = {
        kind: 'task',
        id: 'task-a',
        status: { state: 'working', timestamp: 'x' },
        history: [{ kind: 'message', messageId: 'm-a', role: 'user', parts: [{ kind: 'text', text: 'a' }, { kind: 'data', data: BRIEF }] }],
        artifacts: [],
        metadata: { title: 'A', from: { workspaceId: WS, name: 'Co', paneId: 'ceo' }, to: { workspaceId: WS, name: 'Co', paneId: 'dev-1' }, createdAt: 'x', updatedAt: 'x' },
      };
      return { ok: true, workspaceId: params.workspaceId, tasks: params.taskId === 'task-a' ? [blocker] : [] };
    }
    return { ok: true };
  },
} as unknown as DaemonClient;

function setup(gate: CompanySlotGate = new CompanySlotGate({ read: async () => count(), cap: () => cap })): RpcRouter {
  const router = new RpcRouter();
  registerA2aRpc(router, () => ({}) as BrowserWindow, worker, {
    getDaemonClient: () => dc,
    companyRelease: () => ({ pullNow }),
    companySlots: gate,
  });
  return router;
}

const sendParams = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  to: WS,
  paneId: 'dev-2',
  senderPtyId: 'pty-ceo',
  title: 'C',
  message: 'build C',
  data: BRIEF,
  ...over,
});

async function send(router: RpcRouter, params: Record<string, unknown>, opts?: { operator: true }): Promise<Record<string, unknown>> {
  const res = await router.dispatch({ id: 's', method: 'a2a.task.send', params }, opts);
  return (res as { result: Record<string, unknown> }).result;
}

const rendererSends = (): Array<Record<string, unknown>> =>
  sendToRendererMock.mock.calls.filter((c) => c[1] === 'a2a.task.send').map((c) => c[2] as Record<string, unknown>);

beforeEach(() => {
  sendToRendererMock.mockReset();
  pullNow.mockReset();
  staff = ['dev-1', 'dev-2', 'dev-3'];
  working = [seat('dev-1')];
  cap = 1;
  readable = true;
  reads = 0;
  createHold = true;
  created = [];
  taskSeq = 0;
  rendererGate = null;
  sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.task.send') {
      if (rendererGate) await rendererGate;
      taskSeq += 1;
      const id = `task-${taskSeq}`;
      const paneId = typeof params.paneId === 'string' ? params.paneId : 'dev-2';
      return {
        ok: true,
        taskId: id,
        silent: params.silent === true,
        delivery: params.silent === true ? { stored: true, notified: false, reason: 'silent' } : { stored: true, notified: true, mode: 'nudge' },
        toWorkspaceId: WS,
        executeApproved: false,
        task: {
          id,
          metadata: { title: 'C', from: { workspaceId: WS, name: 'Co', paneId: 'ceo' }, to: { workspaceId: WS, name: 'Co', paneId } },
          history: [{ kind: 'message', messageId: `m-${id}`, role: 'user', parts: [{ kind: 'text', text: 'build C' }, { kind: 'data', data: params.data }] }] as Message[],
        },
      };
    }
    if (method === 'surface.list') return [{ id: 'surf-dev-2', paneId: 'dev-2' }, { id: 'surf-ceo', paneId: 'ceo' }];
    if (method === 'a2a.company.discard') return { ok: true };
    return null;
  });
});

describe('a2a.task.send — the cap on working seats', () => {
  it('holds a brief to an idle seat while every slot is taken, and says why', async () => {
    const res = await send(setup(), sendParams());
    expect(rendererSends()[0]).toMatchObject({ silent: true, heldForBlockers: true });
    expect(created).toHaveLength(1);
    expect(created[0].holdForSlot).toBe(true);
    expect(created[0].holdForBlockers).toBeUndefined();
    expect(res).toMatchObject({
      ok: true,
      taskId: 'task-1',
      silent: false,
      delivery: { stored: true, notified: false, reason: 'cap', cap: 1, working: 1, holders: ['#dev-1'], hint: companyCapHint(1, ['#dev-1']) },
    });
    expect(String((res.delivery as { hint: string }).hint)).toContain('a seat on another PC');
    expect(pullNow).toHaveBeenCalledTimes(1);
    expect(res.task).toBeUndefined();
  });

  it('sends at once a brief to a seat that works already, or while a slot is free', async () => {
    const router = setup();
    const toWorking = await send(router, sendParams({ paneId: 'dev-1' }));
    expect(toWorking).toMatchObject({ ok: true, delivery: { notified: true } });
    cap = 2;
    const free = await send(router, sendParams());
    expect(free).toMatchObject({ ok: true, delivery: { notified: true } });
    expect(rendererSends().every((p) => p.silent === undefined && p.heldForBlockers === undefined)).toBe(true);
    expect(created.every((p) => p.holdForSlot === undefined)).toBe(true);
    expect(pullNow).not.toHaveBeenCalled();
  });

  it('holds a brief from another staff seat the same way: the cap counts seats, not senders', async () => {
    const res = await send(setup(), sendParams({ senderPtyId: 'pty-dev-3' }));
    expect(res).toMatchObject({ ok: true, delivery: { reason: 'cap' } });
  });

  it('never holds the owner\'s own send, nor reads the count for it', async () => {
    const res = await send(setup(), sendParams(), { operator: true });
    expect(res).toMatchObject({ ok: true, delivery: { notified: true } });
    expect(reads).toBe(0);
    expect(created[0].holdForSlot).toBeUndefined();
  });

  it('finds the seat a surface_id names', async () => {
    const res = await send(setup(), sendParams({ paneId: undefined, surfaceId: 'surf-dev-2' }));
    expect(res).toMatchObject({ ok: true, delivery: { reason: 'cap' } });
  });

  it('counts no pane that is not a staff seat, no reply and no send without a brief', async () => {
    const router = setup();
    expect(await send(router, sendParams({ paneId: 'ceo' }))).toMatchObject({ ok: true, delivery: { notified: true } });
    expect(await send(router, sendParams({ data: { kind: 'other' } }))).toMatchObject({ ok: true, delivery: { notified: true } });
    expect(reads).toBe(1);
  });

  it('sends as a plain send when the count cannot be read', async () => {
    readable = false;
    const res = await send(setup(), sendParams());
    expect(res).toMatchObject({ ok: true, delivery: { notified: true } });
    expect(created[0].holdForSlot).toBeUndefined();
  });

  it('fails the send and drops the renderer\'s copy when the daemon keeps no hold', async () => {
    createHold = false;
    const res = await send(setup(), sendParams());
    expect(String(res.error)).toContain('every working seat slot on this PC is taken, and wmux could not keep the task waiting for one');
    expect(sendToRendererMock.mock.calls.filter((c) => c[1] === 'a2a.company.discard').map((c) => c[2])).toEqual([{ taskId: 'task-1' }]);
  });

  it('leaves a send with blockers to its blocker hold: it waits for a slot at its release', async () => {
    const res = await send(setup(), sendParams({ data: { ...BRIEF, blockedBy: ['task-a'] } }));
    expect(res).toMatchObject({ ok: true, delivery: { reason: 'blocked', waitingOn: ['task-a'] } });
    expect(created[0]).toMatchObject({ holdForBlockers: true });
    expect(created[0].holdForSlot).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('decides two sends one at a time: with one slot left, one goes and the other is held', async () => {
    cap = 2;
    const router = setup();
    // Neither send gets past its renderer call until both have been decided.
    let open = (): void => undefined;
    rendererGate = new Promise<void>((resolve) => { open = resolve; });
    const both = Promise.all([send(router, sendParams({ paneId: 'dev-2' })), send(router, sendParams({ paneId: 'dev-3' }))]);
    await vi.waitFor(() => expect(reads).toBe(2), { timeout: 5_000 });
    open();
    const [a, b] = await both;
    const reasons = [a, b].map((r) => (r.delivery as { reason?: string }).reason);
    expect(reasons.filter((r) => r === 'cap')).toHaveLength(1);
    expect([a, b].filter((r) => (r.delivery as { notified?: boolean }).notified === true)).toHaveLength(1);
    const held = [a, b].find((r) => (r.delivery as { reason?: string }).reason === 'cap');
    expect((held?.delivery as { holders: string[] }).holders).toHaveLength(2);
  });

  it('gives the slot back once the send is over', async () => {
    const router = setup();
    cap = 2;
    // dev-2 takes the free slot; the count still shows only dev-1 working (the
    // task is not in the daemon's record here), so a reservation left behind
    // would hold dev-3's brief.
    expect(await send(router, sendParams({ paneId: 'dev-2' }))).toMatchObject({ delivery: { notified: true } });
    expect(await send(router, sendParams({ paneId: 'dev-3' }))).toMatchObject({ delivery: { notified: true } });
  });
});

describe('a2a.task.update — a report frees a working slot', () => {
  it('pulls the release bridge after a committed input-required, as after a task ends', async () => {
    const router = setup();
    await router.dispatch({ id: 'w', method: 'a2a.task.update', params: { taskId: 'task-1', workspaceId: WS, status: 'working' } }, { operator: true });
    expect(pullNow).not.toHaveBeenCalled();
    await router.dispatch({ id: 'r', method: 'a2a.task.update', params: { taskId: 'task-1', workspaceId: WS, status: 'input-required' } }, { operator: true });
    expect(pullNow).toHaveBeenCalledTimes(1);
  });
});
