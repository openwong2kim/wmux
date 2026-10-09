import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MoaGoalService, renderGoalBlock, type MoaGoalPorts } from '../moaGoalContract';
import type { WorkspaceDecision } from '../deckDecisionStore';
import type { MoaLevel } from '../../../shared/moa';

const HQ = 'ws-hq';
const HOUR = 3_600_000;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-goal-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface Rig {
  svc: MoaGoalService;
  slots: Map<string, WorkspaceDecision>;
  state: { level: MoaLevel; ready: boolean; now: number; hq: string | null };
  file: string;
  ports: MoaGoalPorts;
}

function rig(over: Partial<MoaGoalPorts> = {}, file = path.join(dir, 'moa-goals.json')): Rig {
  const slots = new Map<string, WorkspaceDecision>();
  const state = { level: 2 as MoaLevel, ready: true, now: 1_000, hq: HQ as string | null };
  let n = 0;
  const ports: MoaGoalPorts = {
    hqWorkspaceId: () => state.hq,
    hqLevel: () => state.level,
    moaReady: () => state.ready,
    vetRepo: async (p) => (p.startsWith('/repo') ? '/repo' : null),
    workspaceExists: (id) => id === 'ws-a' || id === HQ,
    workspaceName: (id) => (id === 'ws-a' ? 'alpha' : undefined),
    decisions: {
      raiseIfFree: async (ws, card) => {
        if (slots.has(ws)) return null;
        const d: WorkspaceDecision = { id: `d${++n}`, question: card.question, options: card.options, context: card.context, status: 'pending', raisedAt: 1, origin: card.origin, ref: card.ref };
        slots.set(ws, d);
        return d;
      },
      load: (ws) => slots.get(ws) ?? null,
      resolve: async (ws, id, res) => {
        const d = slots.get(ws);
        if (!d || d.id !== id || d.status !== 'pending') return null;
        const r = { ...d, status: 'resolved' as const, resolution: res };
        slots.set(ws, r);
        return r;
      },
      clearResolved: async (ws, id) => {
        if (slots.get(ws)?.id === id) slots.delete(ws);
      },
      clearPendingIfUnchanged: async (ws, d) => {
        if (slots.get(ws)?.id === d.id) slots.delete(ws);
        return true;
      },
    },
    now: () => state.now,
    filePath: file,
    ...over,
  };
  return { svc: new MoaGoalService(ports), slots, state, file, ports };
}

const GOAL = { goal: 'Fix the flaky login test', repo: '/repo/sub', humanOnly: ['database migration'], budget: { maxTasks: 2, maxHours: 2, maxTurns: 3 } };

async function approved(r: Rig): Promise<string> {
  const p = await r.svc.propose(HQ, GOAL);
  if (!p.ok) throw new Error(p.error);
  const d = r.slots.get(HQ)!;
  const res = await r.svc.resolveCard(HQ, d.id, 'Approve goal');
  expect(res).toEqual({ ok: true, id: p.id, status: 'active' });
  return p.id;
}

describe('moa goal — proposal refusals', () => {
  it.each([
    ['moa_off', (r: Rig) => { r.state.ready = false; }, HQ, GOAL],
    ['not_hq', () => undefined, 'ws-a', GOAL],
    ['level_too_low', (r: Rig) => { r.state.level = 1; }, HQ, GOAL],
    ['level_too_low', (r: Rig) => { r.state.level = 0; }, HQ, GOAL],
    ['repo_not_git', () => undefined, HQ, { ...GOAL, repo: '/home/me' }],
    ['workspace_unknown', () => undefined, HQ, { goal: 'g', workspaceIds: ['ws-nope'] }],
    ['workspace_unknown', () => undefined, HQ, { goal: 'g', workspaceIds: [HQ] }],
    ['goal_empty', () => undefined, HQ, { repo: '/repo' }],
  ])('%s', async (error, setup, caller, params) => {
    const r = rig();
    setup(r);
    const res = await r.svc.propose(caller, params);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe(error);
    expect(r.slots.size).toBe(0);
  });

  it('a busy slot is refused, and so is a second goal while one is open', async () => {
    const r = rig();
    r.slots.set(HQ, { id: 'other', question: 'q', options: ['a'], status: 'pending', raisedAt: 1 } as WorkspaceDecision);
    expect(await r.svc.propose(HQ, GOAL)).toMatchObject({ ok: false, error: 'busy' });
    r.slots.clear();
    const first = await r.svc.propose(HQ, GOAL);
    expect(first).toMatchObject({ ok: true, status: 'pending' });
    expect(await r.svc.propose(HQ, GOAL)).toMatchObject({ ok: false, error: 'goal_open' });
  });
});

describe('moa goal — one card, one approval', () => {
  it('raises a main-owned moa-goal card in the HQ slot with the vetted repo root', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, GOAL);
    expect(p.ok).toBe(true);
    const d = r.slots.get(HQ)!;
    expect(d.origin).toBe('moa-goal');
    expect(d.options).toEqual(['Approve goal', 'Decline']);
    expect(d.context).toContain('/repo');
    expect(r.svc.current()?.repoRoot).toBe('/repo');
    expect(r.svc.powers()).toMatchObject({ ok: false, reason: 'not-active' });
  });

  it('approve makes it active and persists across a restart', async () => {
    const r = rig();
    const id = await approved(r);
    expect(r.slots.size).toBe(0);
    expect(r.svc.powers()).toMatchObject({ ok: true, level: 2 });
    await r.svc.save();
    const again = rig({}, r.file);
    expect(again.svc.current()?.id).toBe(id);
    expect(again.svc.current()?.status).toBe('active');
  });

  it('anything but the exact approve label declines', async () => {
    const r = rig();
    await r.svc.propose(HQ, GOAL);
    const res = await r.svc.resolveCard(HQ, r.slots.get(HQ)!.id, 'approve goal please');
    expect(res).toMatchObject({ ok: true, status: 'declined' });
    expect(r.svc.current()).toBeNull();
  });

  it('a card that is not pending any more is not applied twice; unknown cards are not ours', async () => {
    const r = rig();
    await r.svc.propose(HQ, GOAL);
    const d = r.slots.get(HQ)!;
    await r.svc.resolveCard(HQ, d.id, 'Approve goal');
    // Settled: the card id no longer names a contract, so nothing re-applies.
    expect(await r.svc.resolveCard(HQ, d.id, 'Decline')).toBeNull();
    expect(r.svc.current()?.status).toBe('active');
    expect(await r.svc.resolveCard(HQ, 'nope', 'Approve goal')).toBeNull();
  });

  it('settleResolved applies a stored human answer, never a brain one', async () => {
    const r = rig();
    await r.svc.propose(HQ, GOAL);
    const d = r.slots.get(HQ)!;
    const brain = await r.svc.settleResolved(HQ, { ...d, status: 'resolved', resolution: 'Approve goal', resolvedBy: 'brain' } as WorkspaceDecision);
    expect(brain).toMatchObject({ ok: true, status: 'declined' });

    const r2 = rig();
    await r2.svc.propose(HQ, GOAL);
    const d2 = r2.slots.get(HQ)!;
    const human = await r2.svc.settleResolved(HQ, { ...d2, status: 'resolved', resolution: 'Approve goal' } as WorkspaceDecision);
    expect(human).toMatchObject({ ok: true, status: 'active' });
  });
});

describe('moa goal — budget, kill switches, coverage', () => {
  it('reserves tasks within budget and gives them back', async () => {
    const r = rig();
    const id = await approved(r);
    expect(r.svc.reserveTasks(3)).toMatchObject({ ok: false });
    expect(r.svc.reserveTasks(2)).toMatchObject({ ok: true });
    expect(r.svc.reserveTasks(1)).toMatchObject({ ok: false });
    r.svc.releaseTasks(id, 1);
    expect(r.svc.reserveTasks(1)).toMatchObject({ ok: true });
  });

  it('covers only named workspaces and the task workspaces it created', async () => {
    const r = rig();
    const id = await approved(r);
    expect(r.svc.covers('ws-task')).toBeNull();
    r.svc.attachTaskWorkspaces(id, ['ws-task']);
    expect(r.svc.covers('ws-task')).toEqual({ goalId: id, humanOnly: ['database migration'], level: 2, task: true });
    expect(r.svc.covers('ws-elsewhere')).toBeNull();
  });

  it('lowering the level below 2 makes it inert at once; raising it back restores it', async () => {
    const r = rig();
    const id = await approved(r);
    r.svc.attachTaskWorkspaces(id, ['ws-task']);
    r.state.level = 1;
    expect(r.svc.covers('ws-task')).toBeNull();
    expect(renderGoalBlock(r.svc.view())).toContain('grants nothing');
    r.state.level = 2;
    expect(r.svc.covers('ws-task')).not.toBeNull();
  });

  it('the turn budget ends it as exhausted', async () => {
    const r = rig();
    const id = await approved(r);
    r.svc.noteTurn(HQ);
    r.svc.noteTurn('ws-a'); // not the HQ: not counted
    r.svc.noteTurn(HQ);
    expect(r.svc.powers().ok).toBe(true);
    r.svc.noteTurn(HQ);
    expect(r.svc.current()).toBeNull();
    expect(r.svc.get(id)?.status).toBe('exhausted');
  });

  it('the clock ends it as expired', async () => {
    const r = rig();
    const id = await approved(r);
    r.state.now += 2 * HOUR;
    expect(r.svc.current()).toBeNull();
    expect(r.svc.get(id)?.status).toBe('expired');
  });

  it('a moved HQ takes its powers away', async () => {
    const r = rig();
    await approved(r);
    r.state.hq = 'ws-new';
    expect(r.svc.powers().ok).toBe(false);
  });

  it('the operator can end it from Settings, pending or active; a pending card is withdrawn', async () => {
    const r = rig();
    await r.svc.propose(HQ, GOAL);
    expect(r.slots.size).toBe(1);
    expect(await r.svc.end('operator', 'canceled', 'no')).toMatchObject({ ok: true });
    expect(r.slots.size).toBe(0);
    const id = await approved(r);
    expect(await r.svc.end('moa', 'completed', 'login test fixed and verified')).toEqual({ ok: true, id });
    expect(r.svc.get(id)?.endNote).toBe('Moa: login test fixed and verified');
    expect(await r.svc.end('operator', 'canceled', 'x')).toEqual({ ok: false, code: 'no_goal' });
  });

  it('an unreadable file starts empty (nothing granted)', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{not json');
    const r = rig({}, file);
    expect(r.svc.current()).toBeNull();
    expect(r.svc.powers().ok).toBe(false);
  });
});
