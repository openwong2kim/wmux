// Company mode: a2a.task.query and a task held on its blockers. The daemon
// keeps a waiting task from its receiving side, so main tells it who reads
// (the caller's pane, or the human), drops the renderer's copies of what it
// kept, checks those copies itself when the daemon is away, and shows the
// caller why a task waits.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import { applyTaskQueryView, summarizeTask } from '../../../../shared/a2aTaskQueryView';
import { COMPANY_HOLD_KEY, type CompanyHoldMarker } from '../../../../shared/companyHold';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const WS = 'ws-co';
const PANES = [
  { id: 'pane-ceo', surfacePtyIds: ['pty-ceo'], companySeat: 'coordinator' },
  { id: 'pane-dev', surfacePtyIds: ['pty-dev'], companySeat: 'staff' },
];

function task(id: string, hold?: Partial<CompanyHoldMarker>): Rec {
  return {
    kind: 'task',
    id,
    status: { state: 'submitted', timestamp: '2026-11-01T00:00:00.000Z' },
    history: [{ kind: 'message', messageId: `m-${id}`, role: 'user', parts: [{ kind: 'text', text: 'build' }] }],
    artifacts: [],
    metadata: {
      title: id,
      from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' },
      to: { workspaceId: WS, name: 'Co', paneId: 'pane-dev' },
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      ...(hold ? { [COMPANY_HOLD_KEY]: { blockedBy: ['task-a'], waitingOn: ['task-a'], ...hold } } : {}),
    },
  };
}

/** The renderer's copy of a held task: stored by a silent send, it has no marker. */
const rendererCopy = (id: string): Rec => task(id);

let daemonCalls: Rec[];
let daemonUp: boolean;
let daemonRows: Rec[];
let rendererRows: Rec[];

/** As the daemon answers: a waiting task is kept from anyone but its sender's pane and the human. */
function daemonQuery(params: Rec): Rec {
  const withheld = daemonRows.filter((t) => {
    const hold = t.metadata[COMPANY_HOLD_KEY];
    return hold?.waitingOn.length > 0 && params.trustedLane !== true && params.callerPaneId !== t.metadata.from.paneId;
  }).map((t) => t.id as string);
  const rows = daemonRows.filter((t) => !withheld.includes(t.id));
  return { ok: true, workspaceId: WS, tasks: applyTaskQueryView(rows, params), ...(withheld.length ? { withheld } : {}) };
}

function setup(): RpcRouter {
  const dc = {
    rpc: async (method: string, params: Rec) => {
      daemonCalls.push({ method, params });
      if (!daemonUp) throw new Error('daemon pipe closed');
      if (method === 'a2a.task.query') return daemonQuery(params);
      if (method === 'a2a.task.update') return { ok: true, task: { id: params.taskId, status: { state: params.status, timestamp: 'z' }, metadata: { updatedAt: 'z' } } };
      return { ok: true };
    },
  } as unknown as DaemonClient;
  const router = new RpcRouter();
  registerA2aRpc(router, () => ({}) as BrowserWindow, { cancel: vi.fn() } as unknown as ClaudeWorker, { getDaemonClient: () => dc });
  return router;
}

async function query(params: Rec, envelope: Rec = {}, opts?: { operator: true }): Promise<Rec> {
  const res = await setup().dispatch({ id: 'q', method: 'a2a.task.query', params: { workspaceId: WS, ...params }, ...envelope }, opts);
  return (res as unknown as { result: Rec }).result;
}

const daemonQueries = () => daemonCalls.filter((c) => c.method === 'a2a.task.query').map((c) => c.params);
const ids = (res: Rec): string[] => (res.tasks as Rec[]).map((t) => t.id);

beforeEach(() => {
  sendToRendererMock.mockReset();
  daemonCalls = [];
  daemonUp = true;
  daemonRows = [task('task-c', {}), task('task-plain')];
  rendererRows = [rendererCopy('task-c'), rendererCopy('task-plain')];
  sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Rec) => {
    if (method === 'pane.list') return PANES;
    if (method === 'a2a.task.query') return { workspaceId: WS, tasks: applyTaskQueryView(rendererRows, params) };
    return { ok: true };
  });
});

describe('a2a.task.query — the daemon is told who reads', () => {
  it('passes the caller\'s pane, found from its envelope pty, on a paged and a full read', async () => {
    await query({ view: 'page' }, { callerPtyId: 'pty-dev' });
    await query({}, { callerPtyId: 'pty-ceo' });
    expect(daemonQueries()[0]).toMatchObject({ callerPaneId: 'pane-dev' });
    expect(daemonQueries()[1]).toMatchObject({ callerPaneId: 'pane-ceo' });
    expect(daemonQueries().every((p) => p.trustedLane === undefined)).toBe(true);
  });

  it('passes no pane for a pty outside the workspace, and the human\'s lane as trusted', async () => {
    await query({ view: 'page' }, { callerPtyId: 'pty-elsewhere' });
    expect(daemonQueries()[0].callerPaneId).toBeUndefined();
    await query({ view: 'page' }, {}, { operator: true });
    expect(daemonQueries()[1]).toMatchObject({ trustedLane: true });
    expect(daemonQueries()[1].callerPaneId).toBeUndefined();
    await query({ view: 'state', taskId: 'task-c' }, {}, { operator: true });
    expect(daemonQueries()[2]).toMatchObject({ view: 'state', trustedLane: true });
  });

  it('passes the caller\'s pane on the done check\'s own read of the task', async () => {
    daemonRows = [task('task-plain')];
    await setup().dispatch({
      id: 'u',
      method: 'a2a.task.update',
      params: { taskId: 'task-plain', workspaceId: WS, status: 'completed', senderPtyId: 'pty-ceo', evidence: { summary: 'ok', items: [] } },
    });
    expect(daemonQueries()[0]).toMatchObject({ taskId: 'task-plain', callerPaneId: 'pane-ceo' });
  });
});

describe('a2a.task.query — what the daemon kept from the caller stays out', () => {
  it('drops the renderer\'s copy of a withheld task, and never names it to the caller', async () => {
    const res = await query({ view: 'page' }, { callerPtyId: 'pty-dev' });
    expect(ids(res)).toEqual(['task-plain']);
    expect(res).not.toHaveProperty('withheld');
    const full = await query({}, { callerPtyId: 'pty-dev' });
    expect(ids(full)).toEqual(['task-plain']);
    expect(full).not.toHaveProperty('withheld');
  });

  it('shows the sender\'s pane and the human the task with what it waits on', async () => {
    const sender = await query({ view: 'page' }, { callerPtyId: 'pty-ceo' });
    expect((sender.tasks as Rec[]).find((t) => t.id === 'task-c')).toMatchObject({ waitingOn: ['task-a'] });
    const human = await query({}, {}, { operator: true });
    const c = (human.tasks as Rec[]).find((t) => t.id === 'task-c');
    expect(c?.metadata?.[COMPANY_HOLD_KEY]).toMatchObject({ waitingOn: ['task-a'] });
  });

  it('with the daemon away, checks the renderer\'s full copies that carry the marker', async () => {
    daemonUp = false;
    rendererRows = [task('task-c', {}), task('task-plain')];
    expect(ids(await query({}, { callerPtyId: 'pty-dev' }))).toEqual(['task-plain']);
    expect(ids(await query({}, { callerPtyId: 'pty-ceo' }))).toEqual(['task-c', 'task-plain']);
    expect(ids(await query({}, {}, { operator: true }))).toEqual(['task-c', 'task-plain']);
    // A released task is the receiver's.
    rendererRows = [task('task-c', { waitingOn: [], releasedAt: 'r' })];
    expect(ids(await query({}, { callerPtyId: 'pty-dev' }))).toEqual(['task-c']);
  });
});

describe('summarizeTask — why a company task waits', () => {
  it('names the open blockers, or the hold reason once released, and nothing otherwise', () => {
    expect(summarizeTask(task('t1', {}))).toMatchObject({ waitingOn: ['task-a'] });
    expect(summarizeTask(task('t2', { waitingOn: [], held: 'no-agent' }))).toMatchObject({ held: 'no-agent' });
    expect(summarizeTask(task('t2', { waitingOn: [], held: 'no-agent' }))).not.toHaveProperty('waitingOn');
    for (const row of [task('t3', { waitingOn: [] }), task('t4', { waitingOn: [], delivered: true }), task('t5')]) {
      const summary = summarizeTask(row);
      expect(summary).not.toHaveProperty('waitingOn');
      expect(summary).not.toHaveProperty('held');
    }
  });
});
