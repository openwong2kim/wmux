import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../pipe/RpcRouter';
import { registerDeckRpc } from '../../pipe/handlers/deck.rpc';
import { mintCommanderToken, __resetCommanderTrustForTesting } from '../../deck/commanderTrust';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { WorkLinkStore } from '../workLinkStore';
import { attachDecisionToTask, carryDecision } from '../decisionLink';

type Decision = import('../../deck/deckDecisionStore').WorkspaceDecision;
const h = vi.hoisted(() => ({
  store: null as unknown,
  current: null as Decision | null,
  raise: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../workLinkStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workLinkStore')>()),
  getWorkLinkStore: () => h.store,
}));
vi.mock('../../deck/deckHeartbeatStore', () => ({
  loadDeckHeartbeat: () => ({ enabled: true, intervalMs: 180_000, decisionTtlMs: 60_000 }),
}));
vi.mock('../../deck/deckDecisionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../deck/deckDecisionStore')>()),
  loadWorkspaceDecision: () => h.current,
  raiseDecision: (...args: unknown[]) => h.raise(...args),
  replaceStaleDecision: (...args: unknown[]) => h.replace(...args),
}));

let dir: string;
let store: WorkLinkStore;
let pending: Set<string>;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-worklink-dec-'));
  pending = new Set();
  store = new WorkLinkStore({ dir, pendingDecisionIds: () => pending });
  h.store = store;
  h.current = null;
  h.raise.mockReset();
  h.replace.mockReset();
  __resetCommanderTrustForTesting();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const seed = () =>
  store.upsert({
    origin: 'moa',
    a2aTaskId: 'task-1',
    a2aState: 'working',
    owner: { workspaceId: 'ws-1' },
    requester: { workspaceId: 'ws-hq' },
  });

const decision = (id: string, raisedAt = Date.now()): Decision => ({
  id, question: 'A or B?', options: [], context: '', status: 'pending', raisedAt,
});

describe('decisionLink', () => {
  it('attaches for the requester or the owner, not a stranger', async () => {
    await seed();
    pending.add('d1');
    expect(await attachDecisionToTask('ws-hq', 'task-1', 'd1', store)).toMatchObject({ linked: true });
    expect(store.getByTaskId('task-1')).toMatchObject({ state: 'needs-you', reason: 'decision', decisionIds: ['d1'] });
    expect(await attachDecisionToTask('ws-1', 'task-1', 'd2', store)).toMatchObject({ linked: true });
    expect(await attachDecisionToTask('ws-9', 'task-1', 'd3', store)).toEqual({ linked: false, linkError: 'not_your_task' });
    expect(await attachDecisionToTask('ws-hq', 'task-404', 'd4', store)).toEqual({ linked: false, linkError: 'unknown_task' });
    expect(store.getByTaskId('task-1')?.decisionIds).toEqual(['d1', 'd2']);
  });

  it('carries a replaced decision to its successor and settles on answer', async () => {
    const link = (await seed())!;
    pending.add('d1');
    await store.attachDecision(link.id, 'd1');
    pending.delete('d1');
    pending.add('d1b');
    await carryDecision('d1', 'd1b', store);
    expect(store.get(link.id)).toMatchObject({ state: 'needs-you', decisionIds: ['d1', 'd1b'] });
    pending.clear();
    await store.reconcileDecisions();
    expect(store.get(link.id)?.state).toBe('running');
  });

  it('a stale decision replaced onto another task frees the old task\'s link', async () => {
    const old = (await seed())!;
    const other = (await store.upsert({ origin: 'moa', a2aTaskId: 'task-2', a2aState: 'working', owner: { workspaceId: 'ws-2' }, requester: { workspaceId: 'ws-hq' } }))!;
    pending.add('d0');
    await store.attachDecision(old.id, 'd0');
    h.current = decision('d0', 1);
    h.replace.mockResolvedValue(decision('d1'));
    pending.clear();
    pending.add('d1');
    const r = new RpcRouter();
    registerDeckRpc(r, () => ({}) as BrowserWindow, { getLedger: () => ({ list: () => [] }) as unknown as TaskLedger });
    await r.dispatch({ id: '1', method: 'deck.requestDecision', params: { token: mintCommanderToken('ws-hq'), question: 'Sharper?', taskId: 'task-2' } });
    await store.reconcileDecisions(); // what the decision-store hook runs after the replace's write
    expect(store.get(other.id)).toMatchObject({ state: 'needs-you', decisionIds: ['d1'] });
    expect(store.get(old.id)).toMatchObject({ state: 'running', decisionIds: ['d0'] });
  });
});

describe('deck.requestDecision task_id', () => {
  const router = () => {
    const r = new RpcRouter();
    registerDeckRpc(r, () => ({}) as BrowserWindow, { getLedger: () => ({ list: () => [] }) as unknown as TaskLedger });
    return r;
  };
  const ask = async (params: Record<string, unknown>) =>
    ((await router().dispatch({ id: '1', method: 'deck.requestDecision', params })) as { result: Record<string, unknown> }).result;

  it('raises the decision and attaches it to the task link', async () => {
    await seed();
    h.raise.mockResolvedValue(decision('d1'));
    pending.add('d1');
    const res = await ask({ token: mintCommanderToken('ws-hq'), question: 'A or B?', taskId: 'task-1' });
    expect(res).toMatchObject({ ok: true, id: 'd1', linked: true });
    expect(store.getByTaskId('task-1')).toMatchObject({ state: 'needs-you', decisionIds: ['d1'] });
  });

  it('still raises when the task is unknown or not the brain\'s', async () => {
    await seed();
    h.raise.mockResolvedValue(decision('d1'));
    expect(await ask({ token: mintCommanderToken('ws-9'), question: 'A or B?', taskId: 'task-1' }))
      .toEqual({ ok: true, id: 'd1', linked: false, linkError: 'not_your_task' });
    expect(await ask({ token: mintCommanderToken('ws-hq'), question: 'A or B?', taskId: 'nope' }))
      .toEqual({ ok: true, id: 'd1', linked: false, linkError: 'unknown_task' });
    expect(store.getByTaskId('task-1')?.decisionIds).toEqual([]);
  });

  it('without task_id answers exactly as before', async () => {
    h.raise.mockResolvedValue(decision('d1'));
    expect(await ask({ token: mintCommanderToken('ws-hq'), question: 'A or B?' })).toEqual({ ok: true, id: 'd1' });
  });

  it('a refused raise attaches nothing', async () => {
    await seed();
    h.current = decision('d0');
    expect(await ask({ token: mintCommanderToken('ws-hq'), question: 'A or B?', taskId: 'task-1' }))
      .toEqual({ ok: false, error: 'decision_pending', id: 'd0' });
    expect(store.getByTaskId('task-1')?.decisionIds).toEqual([]);
  });

  it('a stale replace keeps the new id on the old one\'s link', async () => {
    const link = (await seed())!;
    await store.attachDecision(link.id, 'd0');
    h.current = decision('d0', 1);
    h.replace.mockResolvedValue(decision('d0b'));
    pending.add('d0b');
    expect(await ask({ token: mintCommanderToken('ws-hq'), question: 'Sharper?' })).toEqual({ ok: true, id: 'd0b' });
    expect(store.get(link.id)).toMatchObject({ state: 'needs-you', decisionIds: ['d0', 'd0b'] });
  });
});
