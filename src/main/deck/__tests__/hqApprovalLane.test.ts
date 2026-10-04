import { describe, it, expect, beforeEach } from 'vitest';
import { registerApprovalsRpc } from '../../pipe/handlers/approvals.rpc';
import { createHqAutoPress, hqResolvedBy, type HqLanePorts, type LanePendingRecord } from '../hqApprovalLane';
import type { RpcContext } from '../../../shared/rpc';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import type { AgentMode } from '../deckAutonomyStore';
import type { HqPresence } from '../deckHqStore';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;
type Row = { taskWorkspaceId: string; ownerWorkspaceId: string; status: string };

const OPEN = new Set(['working', 'input_required', 'review_requested']);

/** A ledger that honours openOnly, unlike the owner-lane fake. */
function ledger(rows: Row[]): Pick<TaskLedger, 'list'> {
  return {
    list: (f: { taskWorkspaceId?: string; openOnly?: boolean } = {}) =>
      rows.filter(
        (r) =>
          (f.taskWorkspaceId === undefined || r.taskWorkspaceId === f.taskWorkspaceId) &&
          (!f.openOnly || OPEN.has(r.status)),
      ),
  } as unknown as Pick<TaskLedger, 'list'>;
}

interface World {
  hq: string | null;
  moa: boolean;
  presence: HqPresence;
  optIn: boolean;
  rows: Row[];
  modes: Record<string, AgentMode>;
}

let world: World;
let calls: Array<{ method: string; params: Record<string, unknown> }>;
let pending: LanePendingRecord[];
let reply: unknown;

const ports = (): HqLanePorts => ({
  getHq: () => world.hq,
  isMoaEnabled: () => world.moa,
  presence: () => world.presence,
  isOptedIn: () => world.optIn,
  ledger: () => ledger(world.rows),
  modeOf: (ws) => world.modes[ws] ?? 'off',
});

const daemon = () => ({
  isConnected: true,
  rpc: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'daemon.approvals.list') return { pending };
    return reply;
  },
});

beforeEach(() => {
  world = {
    hq: 'ws-hq',
    moa: true,
    presence: 'present',
    optIn: true,
    rows: [{ taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-own', status: 'working' }],
    modes: { 'ws-own': 'danger' },
  };
  calls = [];
  pending = [{ id: 'ap-1', sessionId: 'pty-w', workspaceId: 'ws-task', kind: 'awaiting_permission' }];
  reply = { ok: true, durable: true };
});

// ── approval.press from the HQ's commander token ────────────────────────────
describe('approval.press — the HQ branch', () => {
  let press: Handler;
  beforeEach(() => {
    const handlers = new Map<string, Handler>();
    registerApprovalsRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, () => daemon() as never, {
      getLedger: () => ledger(world.rows) as TaskLedger,
      hq: { getHq: () => world.hq, isMoaEnabled: () => world.moa, presence: () => world.presence, isOptedIn: () => world.optIn, modeOf: (ws) => world.modes[ws] ?? 'off' },
    });
    press = handlers.get('approval.press')!;
  });
  const as = (ws: string) => ({ origin: 'local', commanderWorkspace: ws }) as unknown as RpcContext;
  const deny = { approvalId: 'ap-1', decision: 'deny' };
  const resolves = () => calls.filter((c) => c.method === 'daemon.approvals.resolve');

  it('lets the HQ deny a worker it does not own, audited with the owner and lane', async () => {
    expect(await press(deny, as('ws-hq'))).toMatchObject({ ok: true, decision: 'deny' });
    expect(resolves()).toEqual([
      {
        method: 'daemon.approvals.resolve',
        params: { id: 'ap-1', decision: 'deny', resolvedBy: 'hq:ws-hq;owner:ws-own;lane:hq', resolver: 'automated' },
      },
    ]);
  });

  it('never lets the HQ approve by token — approvals are pressed by rule', async () => {
    expect(await press({ approvalId: 'ap-1', decision: 'approve' }, as('ws-hq'))).toMatchObject({
      ok: false,
      reason: 'hq-approve-by-rule',
    });
    expect(resolves()).toEqual([]);
  });

  it("refuses an HQ deny when the owner's mode is off", async () => {
    world.modes['ws-own'] = 'off';
    expect(await press(deny, as('ws-hq'))).toMatchObject({ ok: false, reason: 'owner-autonomy-off' });
    expect(resolves()).toEqual([]);
  });

  it.each<[string, (w: World) => void, string]>([
    ['no HQ designated', (w) => { w.hq = null; }, 'not-your-task'],
    ['the HQ missing', (w) => { w.presence = 'missing'; }, 'hq-missing'],
    ['the HQ not yet seen', (w) => { w.presence = 'unknown'; }, 'hq-unknown'],
    ['Moa off', (w) => { w.moa = false; }, 'moa-off'],
    ['the opt-in off', (w) => { w.optIn = false; }, 'hq-press-off'],
    ['a closed task', (w) => { w.rows = [{ taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-own', status: 'completed' }]; }, 'task-closed'],
    ['several owners', (w) => { w.rows.push({ taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-two', status: 'working' }); }, 'owner-ambiguous'],
  ])('refuses with %s', async (_label, mutate, reason) => {
    mutate(world);
    expect(await press(deny, as('ws-hq'))).toMatchObject({ ok: false, reason });
    expect(resolves()).toEqual([]);
  });

  // The token outlives the designation: the HQ is re-read on every call.
  it('refuses a token minted for the previous HQ after a switch', async () => {
    world.hq = 'ws-new-hq';
    expect(await press(deny, as('ws-hq'))).toMatchObject({ ok: false, reason: 'not-your-task' });
    expect(resolves()).toEqual([]);
  });

  it('refuses a token that was never the HQ', async () => {
    expect(await press(deny, as('ws-other'))).toMatchObject({ ok: false, reason: 'not-your-task' });
    expect(resolves()).toEqual([]);
  });

  it('refuses a choiceKey from the HQ', async () => {
    expect(await press({ approvalId: 'ap-1', decision: 'approve', choiceKey: '2' }, as('ws-hq'))).toMatchObject({
      ok: false,
      reason: 'hq-choice-key',
    });
  });

  it('leaves the owner lane exactly as it was', async () => {
    expect(await press({ approvalId: 'ap-1', decision: 'approve' }, as('ws-own'))).toMatchObject({ ok: true });
    expect(resolves()[0]!.params).toMatchObject({ resolvedBy: 'brain:ws-own', decision: 'approve' });
  });

  // A critical refusal points at the existing approval, not at a new decision.
  it('does not send a critical refusal to deck_ask_decision', async () => {
    reply = { ok: false, reason: 'out-of-scope', pressRefusal: 'critical-risk' };
    const res = (await press({ approvalId: 'ap-1', decision: 'approve' }, as('ws-own'))) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: false, reason: 'critical-risk' });
    expect(res).not.toHaveProperty('escalate');
    expect(String(res['note'])).toContain('approval inbox');
  });
});

// ── The rule lane ───────────────────────────────────────────────────────────
describe('createHqAutoPress — pressing by rule', () => {
  const lane = () => createHqAutoPress({ ...ports(), getDaemonClient: () => daemon() as never, log: () => undefined, nameOf: () => 'repo A' });
  const resolves = () => calls.filter((c) => c.method === 'daemon.approvals.resolve');

  it('approves a permission gate when every condition holds, and tells Moa afterwards', async () => {
    const l = lane();
    await l.run();
    expect(resolves()).toEqual([
      {
        method: 'daemon.approvals.resolve',
        params: { id: 'ap-1', decision: 'approve', resolvedBy: hqResolvedBy('ws-hq', 'ws-own'), resolver: 'automated' },
      },
    ]);
    expect(resolves()[0]!.params).not.toHaveProperty('choiceKey');
    expect(l.takePointer()).toBe('[wmux] pressed 1 approval for "repo A" by rule');
    expect(l.takePointer()).toBeNull();
  });

  it('does not even list approvals while the lane is off', async () => {
    world.optIn = false;
    await lane().run();
    expect(calls).toEqual([]);
  });

  it.each<[string, (w: World) => void]>([
    ['the owner in assist', (w) => { w.modes['ws-own'] = 'assist'; }],
    ['Moa off', (w) => { w.moa = false; }],
    ['the HQ missing', (w) => { w.presence = 'missing'; }],
    ['a closed task', (w) => { w.rows[0]!.status = 'cancelled'; }],
    ['several owners', (w) => { w.rows.push({ taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-two', status: 'working' }); }],
  ])('presses nothing with %s', async (_label, mutate) => {
    mutate(world);
    await lane().run();
    expect(resolves()).toEqual([]);
  });

  it('never answers a question — an approve there would pick option 1', async () => {
    pending = [{ id: 'ap-q', sessionId: 'pty-w', workspaceId: 'ws-task', kind: 'awaiting_input' }];
    await lane().run();
    expect(resolves()).toEqual([]);
  });

  it('leaves a critical gate to the human and only says so to Moa', async () => {
    pending = [{ id: 'ap-c', sessionId: 'pty-w', workspaceId: 'ws-task', kind: 'awaiting_permission', risk: 'critical' }];
    const l = lane();
    await l.run();
    expect(resolves()).toEqual([]);
    expect(l.takePointer()).toContain('do not raise a decision');
  });

  it('tries each record once — a refusal is final for that id', async () => {
    reply = { ok: false, reason: 'out-of-scope', pressRefusal: 'owner-not-danger' };
    const l = lane();
    await l.run();
    await l.run();
    expect(resolves()).toHaveLength(1);
    expect(l.takePointer()).toBeNull();
  });
});
