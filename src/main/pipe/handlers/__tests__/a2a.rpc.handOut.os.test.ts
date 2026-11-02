// An agent pane picks a To hand out item by sending it: a2a.task.send with a
// `handOutId`. Only an agent in a pane on this PC may; the item must be open;
// nothing is stored for a refused pick; and the send's link is the item's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import type { DaemonClient } from '../../../DaemonClient';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import { registerA2aRpc } from '../a2a.rpc';
import { WorkLinkStore } from '../../../workLink/workLinkStore';
import { workLinkFromRemoteSend, workLinkFromSentTask } from '../../../workLink/a2aProducer';
import { HandOutStore } from '../../../handOut/handOutStore';
import { CompanySlotGate, type CompanyWorkingCount } from '../../../a2a/CompanyReleaseBridge';
import { COMPANY_HOLD_KEY } from '../../../../shared/companyHold';

const h = vi.hoisted(() => ({ sendToRenderer: vi.fn(), store: null as unknown }));
vi.mock('../_bridge', () => ({ sendToRenderer: h.sendToRenderer }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));
vi.mock('../../../workLink/workLinkStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../workLink/workLinkStore')>()),
  getWorkLinkStore: () => h.store,
}));

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const WS = 'ws-co';
const BRIEF = { kind: 'wmux.company.brief', v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' };
const local = { origin: 'local' } as RpcContext;
const worker = { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker;
const pullNow = vi.fn();

let dir: string;
let links: WorkLinkStore;
let handOuts: HandOutStore;
let itemId: string;
let created: Array<Record<string, unknown>>;

const dc = {
  rpc: async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.task.cancel') return { ok: true, task: { id: params.taskId, status: { state: 'canceled', timestamp: 'z' } } };
    if (method !== 'a2a.task.create') return { ok: true };
    created.push(params);
    const hold = params.holdForSlot === true ? { blockedBy: [], waitingOn: [], releasedAt: 'y' } : null;
    return {
      ok: true,
      taskId: params.id,
      task: {
        kind: 'task', id: params.id, status: { state: 'submitted', timestamp: 'y' }, history: params.history, artifacts: [],
        metadata: { title: params.title, from: params.from, to: params.to, createdAt: 'y', updatedAt: 'y', ...(hold ? { [COMPANY_HOLD_KEY]: hold } : {}) },
      },
    };
  },
} as unknown as DaemonClient;

function handlers(companySlots?: CompanySlotGate): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  const router = { register: (method: string, fn: Handler) => { out[method] = fn; } } as unknown as RpcRouter;
  registerA2aRpc(router, () => ({}) as BrowserWindow, worker, {
    getDaemonClient: () => dc,
    handOuts,
    ...(companySlots ? { companySlots, companyRelease: () => ({ pullNow }) } : {}),
  });
  return out;
}
const send = (params: Record<string, unknown>, ctx: RpcContext = local, slots?: CompanySlotGate) =>
  handlers(slots)['a2a.task.send'](params, ctx) as Promise<Record<string, unknown>>;

/** A new task from #dev-1 (pty-dev-1) to the seat #dev-2, picking the item. */
const pick = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS, to: WS, paneId: 'dev-2', senderPtyId: 'pty-dev-1', title: 'Fix the crash', message: 'Fix it', handOutId: itemId, ...over,
});
const rendererSends = () => h.sendToRenderer.mock.calls.filter((c) => c[1] === 'a2a.task.send').map((c) => c[2] as Record<string, unknown>);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-a2a-hand-out-'));
  links = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set() });
  h.store = links;
  handOuts = new HandOutStore({ dir, links });
  const added = handOuts.add({ title: 'Fix the crash', folder: '/repo' }, { kind: 'owner' });
  itemId = added.ok ? added.item.id : '';
  created = [];
  pullNow.mockReset();
  h.sendToRenderer.mockReset();
  let seq = 0;
  h.sendToRenderer.mockImplementation(async (_w: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'pane.list') {
      return params.workspaceId === WS
        ? [{ id: 'dev-1', surfacePtyIds: ['pty-dev-1'] }, { id: 'dev-2', surfacePtyIds: ['pty-dev-2'] }, { id: 'dev-3', surfacePtyIds: ['pty-dev-3'] }]
        : [];
    }
    if (method === 'a2a.task.cancel') return { ok: true, taskId: params.taskId };
    if (method === 'a2a.task.send') {
      seq += 1;
      const id = `task-${seq}`;
      return {
        ok: true,
        taskId: id,
        toWorkspaceId: WS,
        // #dev-3 runs no agent: the task is stored and nothing is written.
        delivery: params.paneId === 'dev-3' ? { stored: true, notified: false, reason: 'no_agent_pane' } : { stored: true, notified: true },
        task: {
          id,
          status: { state: 'submitted', timestamp: 'x' },
          metadata: { title: 'Fix the crash', from: { workspaceId: WS, paneId: 'dev-1' }, to: { workspaceId: WS, paneId: params.paneId } },
          history: [],
        },
      };
    }
    return null;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Nothing reached the renderer's send or the daemon, and no link was made. */
function nothingCreated(): void {
  expect(rendererSends()).toEqual([]);
  expect(created).toEqual([]);
  expect(links.list()).toEqual([]);
}

describe('a2a.task.send with handOutId', () => {
  it('the send\'s link is the item\'s, and the item is out', async () => {
    const res = await send(pick());
    expect(res).toMatchObject({ ok: true, taskId: 'task-1' });
    await links.flush();
    expect(links.getByTaskId('task-1')).toMatchObject({
      origin: 'hand-out', handOutId: itemId, owner: { workspaceId: WS, paneId: 'dev-2' }, requester: { workspaceId: WS, paneId: 'dev-1' },
    });
    expect(handOuts.get(itemId)).toMatchObject({ state: 'out' });
    // Main-only: the renderer never sees it.
    expect(rendererSends()[0]).not.toHaveProperty('handOutId');
  });

  it('a pick that reached no agent is cancelled, and the item is open again', async () => {
    const res = await send(pick({ paneId: 'dev-3' }));
    expect(res).toMatchObject({ ok: true, taskId: 'task-1', handOut: expect.stringContaining('item is open again') });
    const cancels = h.sendToRenderer.mock.calls.filter((c) => c[1] === 'a2a.task.cancel').map((c) => c[2] as Record<string, unknown>);
    expect(cancels).toEqual([expect.objectContaining({ taskId: 'task-1', workspaceId: WS, daemonCommitted: true })]);
    await vi.waitFor(() => expect(links.getByTaskId('task-1')?.state).toBe('abandoned'), { timeout: 5_000 });
    expect(handOuts.get(itemId)?.state).toBe('open');
    expect(handOuts.reserve(itemId)).toBe(true);
  });

  it('a pick whose task cannot be cancelled says so, and the item stays out', async () => {
    const rpc = dc.rpc.bind(dc);
    vi.spyOn(dc, 'rpc').mockImplementation(async (method: string, params?: Record<string, unknown>) =>
      method === 'a2a.task.cancel' ? { ok: false, error: 'a2a.task.cancel: not allowed' } : rpc(method, params ?? {}));
    const res = await send(pick({ paneId: 'dev-3' }));
    expect(res).toMatchObject({ ok: true, handOut: expect.stringContaining('could not be cancelled') });
    await links.flush();
    expect(handOuts.get(itemId)?.state).toBe('out');
  });

  it('a send the renderer refuses links nothing, and the item can be picked again', async () => {
    h.sendToRenderer.mockImplementation(async (_w: unknown, method: string) =>
      method === 'pane.list' ? [{ id: 'dev-1', surfacePtyIds: ['pty-dev-1'] }] : { error: 'no such pane' });
    expect(await send(pick())).toEqual({ error: 'no such pane' });
    expect(links.list()).toEqual([]);
    expect(handOuts.get(itemId)?.state).toBe('open');
    expect(handOuts.reserve(itemId)).toBe(true);
  });

  it('a company brief held for a working slot still links the item at send time', async () => {
    const count: CompanyWorkingCount = {
      staff: new Map(['dev-1', 'dev-2', 'dev-3'].map((id) => [id, { workspaceId: WS, name: `#${id}`, alive: true }])),
      working: [{ workspaceId: WS, paneId: 'dev-3', name: '#dev-3' }],
    };
    const gate = new CompanySlotGate({ read: async () => count, cap: () => 1 });
    const res = await send(pick({ data: BRIEF }), local, gate);
    expect(res).toMatchObject({ ok: true, delivery: { reason: 'cap' } });
    expect(created[0]).toMatchObject({ holdForSlot: true });
    await links.flush();
    expect(links.getByTaskId('task-1')).toMatchObject({ origin: 'hand-out', handOutId: itemId });
    expect(handOuts.get(itemId)?.state).toBe('out');
  });
});

describe('what a pick by send refuses, before anything is stored', () => {
  it('an item that is out, or being picked, is taken', async () => {
    await links.upsert({ origin: 'hand-out', handOutId: itemId, owner: { workspaceId: 'ws-other' } });
    expect(await send(pick())).toMatchObject({ code: 'hand_out_taken', error: expect.stringContaining('already handed out') });
    expect(rendererSends()).toEqual([]);
    expect(created).toEqual([]);

    const other = handOuts.add({ title: 'Other', folder: '/repo' }, { kind: 'owner' });
    const otherId = other.ok ? other.item.id : '';
    expect(handOuts.reserve(otherId)).toBe(true);
    expect(await send(pick({ handOutId: otherId }))).toMatchObject({ code: 'hand_out_taken' });
    expect(rendererSends()).toEqual([]);
  });

  it('an item not on the list is unknown; a malformed id is invalid', async () => {
    expect(await send(pick({ handOutId: `ho-${randomUUID()}` }))).toMatchObject({ code: 'hand_out_unknown' });
    expect(await send(pick({ handOutId: 'item-1' }))).toMatchObject({ code: 'hand_out_invalid' });
    expect(await send(pick({ handOutId: null }))).toMatchObject({ code: 'hand_out_invalid' });
    nothingCreated();
  });

  it('a pick that joins a named link, replies on a task, or is silent or executed, is invalid', async () => {
    expect(await send(pick({ workLinkId: 'link-1' }))).toMatchObject({ code: 'hand_out_invalid' });
    expect(await send(pick({ taskId: 'task-0' }))).toMatchObject({ code: 'hand_out_invalid' });
    expect(await send(pick({ silent: true }))).toMatchObject({ code: 'hand_out_invalid' });
    expect(await send(pick({ execute: true }))).toMatchObject({ code: 'hand_out_invalid' });
    nothingCreated();
    expect(handOuts.get(itemId)?.state).toBe('open');
  });

  it.each([
    ['another PC', { origin: 'remote' }],
    ['a bot', { origin: 'local', bot: { botId: 'bot-1' } }],
    ['a commander brain', { origin: 'local', commanderWorkspace: WS }],
    ['the operator lane (the app picks over IPC)', { origin: 'local', operator: true, firstParty: true }],
    ['a plugin', { origin: 'local', firstParty: true, hostedWorkspace: WS }],
    ['a fenced worker', { origin: 'local', fencedWorker: true }],
  ])('%s is refused', async (_label, ctx) => {
    expect(await send(pick(), ctx as unknown as RpcContext)).toMatchObject({ code: 'hand_out_refused' });
    nothingCreated();
    expect(handOuts.reserve(itemId)).toBe(true);
  });

  it('a caller whose pane does not resolve on this PC is refused', async () => {
    expect(await send(pick({ senderPtyId: 'pty-elsewhere' }))).toMatchObject({ code: 'hand_out_refused' });
    expect(await send(pick({ senderPtyId: undefined }))).toMatchObject({ code: 'hand_out_refused' });
    nothingCreated();
  });
});

describe('the producers name the item', () => {
  const reply = {
    ok: true, taskId: 'task-1', toWorkspaceId: 'ws-1',
    task: { id: 'task-1', status: { state: 'submitted' }, metadata: { to: { workspaceId: 'ws-1' }, from: { workspaceId: 'ws-2' } } },
  };

  it('a local send', () => {
    expect(workLinkFromSentTask(reply, { fromCommander: false, handOutId: 'ho-x' })).toMatchObject({ origin: 'hand-out', handOutId: 'ho-x' });
    expect(workLinkFromSentTask(reply, { fromCommander: false })).not.toHaveProperty('handOutId');
  });

  it('a send to a pane on another PC', () => {
    const base = { taskId: 'rt-1', linkId: 'link-1', alias: 'PC/ws/pane', requester: { workspaceId: 'ws-2', paneId: 'p' }, title: 't', message: 'm', fromCommander: false };
    expect(workLinkFromRemoteSend({ ...base, handOutId: 'ho-x' })).toMatchObject({ origin: 'hand-out', handOutId: 'ho-x', owner: { workspaceId: 'remote:link-1' } });
    expect(workLinkFromRemoteSend(base)).toMatchObject({ origin: 'manual' });
  });
});
