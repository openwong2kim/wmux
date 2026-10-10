import type { MoaGoalContract as _C, MoaGoalDelivery } from '../../../shared/moaGoal';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoaGoalService, renderGoalBlock, type MoaGoalPorts } from '../moaGoalContract';
import type { WorkspaceDecision } from '../deckDecisionStore';
import type { MoaLevel } from '../../../shared/moa';
import type { FanoutWorkerPermissionMode } from '../../../shared/workerLaunch';
import type { MoaGoalVerification } from '../../../shared/moaGoal';

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
  state: { level: MoaLevel; ready: boolean; now: number; hq: string | null; mode: FanoutWorkerPermissionMode; remote: boolean };
  file: string;
  ports: MoaGoalPorts;
}

function rig(over: Partial<MoaGoalPorts> = {}, file = path.join(dir, 'moa-goals.json')): Rig {
  const slots = new Map<string, WorkspaceDecision>();
  const state = {
    level: 2 as MoaLevel,
    ready: true,
    now: 1_000,
    hq: HQ as string | null,
    mode: 'auto' as FanoutWorkerPermissionMode,
    remote: false,
  };
  let n = 0;
  const ports: MoaGoalPorts = {
    hqWorkspaceId: () => state.hq,
    hqLevel: () => state.level,
    workerPermissionMode: () => state.mode,
    turnWokenByRemoteMoa: () => state.remote,
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

const VERIFIED: MoaGoalVerification = {
  at: 1,
  gates: [{ taskId: 't1', workspaceId: 'ws-task', headSha: 'a'.repeat(40), command: 'npm test', exitCode: 0, at: 1, logPath: '/e/t1.log', logSha256: 'b'.repeat(64) }],
  criteria: [],
};
const passingVerify: NonNullable<MoaGoalPorts['verify']> = async () => ({ ok: true, verification: VERIFIED });

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

describe('moa goal — the worker permission mode is pinned (W1/W8)', () => {
  it('the card shows the mode and the contract records it', async () => {
    const r = rig();
    r.state.mode = 'acceptEdits';
    await r.svc.propose(HQ, GOAL);
    expect(r.slots.get(HQ)!.context).toContain('permission mode acceptEdits');
    expect(r.svc.current()?.workerPermissionMode).toBe('acceptEdits');
  });

  it('a mode changed between the card and the click grants nothing', async () => {
    const r = rig();
    await r.svc.propose(HQ, GOAL);
    r.state.mode = 'bypassPermissions';
    const res = await r.svc.resolveCard(HQ, r.slots.get(HQ)!.id, 'Approve goal');
    expect(res).toMatchObject({ ok: true, status: 'declined' });
    expect(res && res.ok && res.note).toMatch(/bypassPermissions now, but the card showed auto/);
    expect(r.svc.powers().ok).toBe(false);
    expect(r.svc.latest()?.endNote).toMatch(/not approved/);
  });

  it('an unreadable mode at approval grants nothing', async () => {
    const r = rig();
    await r.svc.propose(HQ, GOAL);
    r.ports.workerPermissionMode = () => {
      throw new Error('settings gone');
    };
    const res = await r.svc.resolveCard(HQ, r.slots.get(HQ)!.id, 'Approve goal');
    expect(res).toMatchObject({ ok: true, status: 'declined' });
  });

  it('reports the HQ turn a remote Moa woke, failing closed when unreadable', () => {
    const r = rig();
    expect(r.svc.turnWokenByRemoteMoa(HQ)).toBe(false);
    r.state.remote = true;
    expect(r.svc.turnWokenByRemoteMoa(HQ)).toBe(true);
    r.ports.turnWokenByRemoteMoa = () => {
      throw new Error('x');
    };
    expect(r.svc.turnWokenByRemoteMoa(HQ)).toBe(true);
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

  it('the turn budget ends it as exhausted once the last allowed turn has finished', async () => {
    const r = rig();
    const id = await approved(r);
    r.svc.noteTurn(HQ);
    r.svc.finishTurn(HQ);
    r.svc.noteTurn('ws-a'); // not the HQ: not counted
    r.svc.noteTurn(HQ);
    r.svc.finishTurn(HQ);
    expect(r.svc.powers().ok).toBe(true);
    r.svc.noteTurn(HQ);
    // The third (last) turn runs under the goal...
    expect(r.svc.powers()).toMatchObject({ ok: true });
    expect(r.svc.get(id)?.turnsUsed).toBe(3);
    // ...and the goal ends when it does.
    r.svc.finishTurn(HQ);
    expect(r.svc.current()).toBeNull();
    expect(r.svc.get(id)?.status).toBe('exhausted');
  });

  // dot review P1-1: maxTurns=1, the turn is counted when it starts, and the
  // goal used to end right then, so that turn's fan-out ran without it.
  it('maxTurns=1: the one allowed turn keeps the goal until it finishes', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, { ...GOAL, budget: { maxTasks: 2, maxHours: 2, maxTurns: 1 } });
    if (!p.ok) throw new Error(p.error);
    await r.svc.resolveCard(HQ, r.slots.get(HQ)!.id, 'Approve goal');
    r.svc.noteTurn(HQ);
    expect(r.svc.powers()).toMatchObject({ ok: true, contract: { id: p.id } });
    expect(r.svc.turnGoalRefusal(HQ)).toBeNull();
    expect(r.svc.reserveTasks(1)).toMatchObject({ ok: true });
    r.svc.finishTurn(HQ);
    expect(r.svc.powers().ok).toBe(false);
    expect(r.svc.get(p.id)?.status).toBe('exhausted');
    // The next automatic turn is not counted and gets nothing.
    r.svc.noteTurn(HQ);
    expect(r.svc.powers().ok).toBe(false);
    expect(r.svc.turnGoalRefusal(HQ)).toBeNull();
  });

  it('a goal ended while its turn runs is refused to that turn, not dropped silently', async () => {
    const r = rig();
    const id = await approved(r);
    r.svc.noteTurn(HQ);
    expect(r.svc.turnGoalRefusal(HQ)).toBeNull();
    await r.svc.end('operator', 'canceled', 'stop');
    expect(r.svc.turnGoalRefusal(HQ)).toEqual({ goalId: id, reason: 'canceled' });
    expect(r.svc.turnGoalRefusal('ws-a')).toBeNull();
    r.svc.finishTurn(HQ);
    expect(r.svc.turnGoalRefusal(HQ)).toBeNull();
  });

  it('a goal that goes inert while its turn runs is refused to that turn too', async () => {
    const r = rig();
    const id = await approved(r);
    r.svc.noteTurn(HQ);
    r.state.level = 1;
    expect(r.svc.turnGoalRefusal(HQ)).toEqual({ goalId: id, reason: 'level' });
    r.state.level = 2;
    r.state.now += 2 * HOUR;
    expect(r.svc.turnGoalRefusal(HQ)).toEqual({ goalId: id, reason: 'expired' });
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
    r.ports.verify = passingVerify;
    expect(await r.svc.end('moa', 'completed', 'login test fixed and verified')).toEqual({ ok: true, id });
    expect(r.svc.get(id)?.endNote).toBe('Moa: login test fixed and verified');
    expect(r.svc.get(id)?.verification).toEqual(VERIFIED);
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

describe('moa goal — approval and end are one at a time (dot review P1-3)', () => {
  function gate(): { wait: Promise<void>; open: () => void } {
    let open = (): void => undefined;
    const wait = new Promise<void>((res) => {
      open = res;
    });
    return { wait, open };
  }

  it('an End that lands while an approval awaits the card store is not undone by it', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, GOAL);
    if (!p.ok) throw new Error(p.error);
    const d = r.slots.get(HQ)!;
    const g = gate();
    const resolve = r.ports.decisions.resolve;
    r.ports.decisions.resolve = async (ws, id, res) => {
      const out = await resolve(ws, id, res);
      await g.wait;
      return out;
    };
    const approving = r.svc.resolveCard(HQ, d.id, 'Approve goal');
    const ending = r.svc.end('operator', 'canceled', 'changed my mind');
    await new Promise((res) => setTimeout(res, 0));
    g.open();
    await approving;
    expect(await ending).toEqual({ ok: true, id: p.id });
    expect(r.svc.get(p.id)?.status).toBe('canceled');
    expect(r.svc.powers().ok).toBe(false);
    expect(r.slots.size).toBe(0);
  });

  it('an approval that runs after an End finds nothing to approve', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, GOAL);
    if (!p.ok) throw new Error(p.error);
    const d = r.slots.get(HQ)!;
    // The End cannot clear the card (store failure): the card stays up.
    r.ports.decisions.clearPendingIfUnchanged = async () => false;
    expect(await r.svc.end('operator', 'canceled', 'no')).toMatchObject({ ok: true });
    r.ports.decisions.clearPendingIfUnchanged = async (ws, x) => {
      if (r.slots.get(ws)?.id === x.id) r.slots.delete(ws);
      return true;
    };
    expect(await r.svc.resolveCard(HQ, d.id, 'Approve goal')).toEqual({ ok: false, code: 'not_pending' });
    expect(r.svc.get(p.id)?.status).toBe('canceled');
    expect(r.svc.powers().ok).toBe(false);
    // ...and the dead card is taken down.
    expect(r.slots.size).toBe(0);
  });
});

describe('moa goal — a stop between the card and the answer (dot review P2-6)', () => {
  it('the answer is recorded before the card is cleared', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, GOAL);
    if (!p.ok) throw new Error(p.error);
    const d = r.slots.get(HQ)!;
    // wmux stops while the card is being cleared: the card is gone and
    // nothing after this point runs.
    r.ports.decisions.clearResolved = async (ws) => {
      r.slots.delete(ws);
      await new Promise(() => undefined);
    };
    void r.svc.resolveCard(HQ, d.id, 'Approve goal');
    await vi.waitFor(() => expect(r.slots.size).toBe(0));
    // What the next start reads: the answer is on disk.
    const again = rig({}, r.file);
    expect(again.svc.current()).toMatchObject({ id: p.id, status: 'active' });
    // Stopped one step earlier instead (card resolved, not cleared): the
    // next start settles the card without applying anything twice.
    again.slots.set(HQ, { ...d, status: 'resolved', resolution: 'Approve goal' });
    // The leftover resolved card is settled without re-applying anything.
    expect(await again.svc.settleResolved(HQ, again.slots.get(HQ)!)).toBeNull();
    expect(again.slots.size).toBe(0);
    expect(again.svc.current()).toMatchObject({ id: p.id, status: 'active' });
  });

  it('a pending goal whose card is gone is declined, and a new goal can be proposed', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, GOAL);
    if (!p.ok) throw new Error(p.error);
    await r.svc.save();
    // What an older build left behind: the card cleared, the contract pending.
    const again = rig({}, r.file);
    expect(again.svc.get(p.id)?.status).toBe('pending');
    expect(again.svc.current()).toBeNull();
    expect(again.svc.get(p.id)).toMatchObject({ status: 'declined', endNote: expect.stringMatching(/approval card is gone/) });
    const next = await again.svc.propose(HQ, GOAL);
    expect(next).toMatchObject({ ok: true, status: 'pending' });
  });

  it('a card store that cannot be read declines nothing', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, GOAL);
    if (!p.ok) throw new Error(p.error);
    r.ports.decisions.load = () => {
      throw new Error('unreadable');
    };
    expect(r.svc.current()).toMatchObject({ id: p.id, status: 'pending' });
  });

  it('an answer that cannot be saved grants nothing and stays to be settled', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, GOAL);
    if (!p.ok) throw new Error(p.error);
    const d = r.slots.get(HQ)!;
    // Saving fails from here on (the file's directory becomes a file).
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'x');
    try {
      expect(await r.svc.resolveCard(HQ, d.id, 'Approve goal')).toEqual({ ok: false, code: 'error' });
      expect(r.svc.get(p.id)?.status).toBe('pending');
      expect(r.svc.powers().ok).toBe(false);
      // The resolved card stays, for settleResolved on the next start.
      expect(r.slots.get(HQ)?.status).toBe('resolved');
    } finally {
      fs.rmSync(dir, { force: true });
      fs.mkdirSync(dir);
    }
  });
});

describe('moa goal — an end whose save fails stays ended across a restart', () => {
  const failingWrite = async (): Promise<void> => {
    throw new Error('disk says no');
  };

  it('end, a failed save, then a reload: the goal is not active', async () => {
    const r = rig();
    const id = await approved(r);
    await r.svc.save();
    r.ports.writeJSON = failingWrite;
    expect(await r.svc.end('operator', 'canceled', 'stop it')).toEqual({ ok: true, id });
    // The store on disk still says active: its save never landed.
    expect(JSON.parse(fs.readFileSync(r.file, 'utf8')).items[id].status).toBe('active');
    const again = rig({}, r.file);
    expect(again.svc.current()).toBeNull();
    expect(again.svc.powers().ok).toBe(false);
    expect(again.svc.get(id)).toMatchObject({ status: 'canceled', endNote: 'operator: stop it' });
  });

  it('a completed goal whose save failed comes back completed, not active', async () => {
    const r = rig();
    const id = await approved(r);
    await r.svc.save();
    r.ports.writeJSON = failingWrite;
    r.ports.verify = passingVerify;
    await r.svc.end('moa', 'completed', 'done and verified');
    expect(rig({}, r.file).svc.get(id)?.status).toBe('completed');
  });

  it('when the end log cannot be written either, the end reports an error and a reload still grants nothing', async () => {
    const r = rig();
    const id = await approved(r);
    await r.svc.save();
    r.ports.writeJSON = failingWrite;
    fs.mkdirSync(`${r.file}.ended`); // appending to it fails
    expect(await r.svc.end('operator', 'canceled', 'x')).toEqual({ ok: false, code: 'error' });
    expect(r.svc.powers().ok).toBe(false);
    // An end log that exists but cannot be read ends every open goal.
    const again = rig({}, r.file);
    expect(again.svc.powers().ok).toBe(false);
    expect(again.svc.get(id)).toMatchObject({ status: 'canceled', endNote: 'the goal end log could not be read' });
  });

  it('the log only ends the goal it names, and goes once nothing is left to apply', async () => {
    const r = rig();
    const id = await approved(r);
    await r.svc.end('operator', 'canceled', 'x'); // both writes land
    const log = `${r.file}.ended`;
    expect(fs.existsSync(log)).toBe(true);
    // The store already says canceled: nothing to apply, so the log is removed.
    expect(rig({}, r.file).svc.get(id)?.status).toBe('canceled');
    expect(fs.existsSync(log)).toBe(false);
    // A line for the same id but another goal (different createdAt) ends nothing.
    const s = rig();
    const next = await approved(s);
    await s.svc.save();
    fs.writeFileSync(`${s.file}.ended`, `${JSON.stringify({ id: next, createdAt: -1, status: 'canceled', endedAt: 1, endNote: 'old' })}\n{torn`);
    expect(rig({}, s.file).svc.current()).toMatchObject({ id: next, status: 'active' });
  });
});

describe('moa goal — done criteria, evidence and constraints', () => {
  const TERMS = { doneCriteria: ['npm test passes'], evidence: ['vitest output'], constraints: ['no new dependencies'] };

  it('a proposal with terms shows them on the card, stores them and survives a restart', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, { ...GOAL, ...TERMS });
    if (!p.ok) throw new Error(p.error);
    const card = r.slots.get(HQ)!;
    expect(card.context).toContain('Done when:\n  (1) npm test passes');
    await r.svc.resolveCard(HQ, card.id, 'Approve goal');
    expect(r.svc.get(p.id)).toMatchObject(TERMS);
    expect(new MoaGoalService(r.ports).get(p.id)).toMatchObject(TERMS);
    expect(r.svc.view()).toMatchObject(TERMS);
  });

  it('the [goal] block carries the terms', async () => {
    const r = rig();
    const p = await r.svc.propose(HQ, { ...GOAL, ...TERMS });
    if (!p.ok) throw new Error(p.error);
    await r.svc.resolveCard(HQ, r.slots.get(HQ)!.id, 'Approve goal');
    const block = renderGoalBlock(r.svc.view())!;
    expect(block).toContain('Done when: (1) npm test passes');
    expect(block).toContain('Evidence: vitest output');
    expect(block).toContain('Constraints: no new dependencies');
  });

  it('a goal without terms says no criteria were stated', async () => {
    const r = rig();
    await approved(r);
    expect(r.svc.view()).toMatchObject({ doneCriteria: [], evidence: [], constraints: [] });
    expect(renderGoalBlock(r.svc.view())).toContain('Done when: (no criteria stated');
  });

  it('bad terms are refused before any card is raised', async () => {
    const r = rig();
    expect(await r.svc.propose(HQ, { ...GOAL, doneCriteria: 'npm test' })).toMatchObject({ ok: false, error: 'done_criteria_invalid' });
    expect(r.slots.get(HQ)).toBeUndefined();
  });
});

describe('moa goal — completion needs proof, never a memo', () => {
  it('without a verifier Moa cannot complete; the goal stays active', async () => {
    const r = rig();
    const id = await approved(r);
    const res = await r.svc.end('moa', 'completed', 'fixed it, trust me');
    expect(res).toMatchObject({ ok: false, code: 'unverified' });
    expect(res.problems?.[0]).toMatch(/no goal verifier/);
    expect(r.svc.get(id)?.status).toBe('active');
  });

  it('a failing verification keeps it active and returns every problem', async () => {
    const r = rig();
    const id = await approved(r);
    r.ports.verify = async () => ({ ok: false, code: 'unverified', problems: ['task t1: the gate failed', 'criterion 1: no evidence named'] });
    expect(await r.svc.end('moa', 'completed', 'done')).toEqual({ ok: false, code: 'unverified', problems: ['task t1: the gate failed', 'criterion 1: no evidence named'] });
    expect(r.svc.get(id)).toMatchObject({ status: 'active' });
    expect(r.svc.get(id)?.verification).toBeUndefined();
  });

  it('the verifier gets the contract and the claims; a pass stores the verification and survives a restart', async () => {
    const r = rig();
    const id = await approved(r);
    const verify = vi.fn(passingVerify);
    r.ports.verify = verify;
    const claims = [{ criterion: 1, artifacts: ['/repo/sub/out.log'] }];
    expect(await r.svc.end('moa', 'completed', 'done', claims)).toEqual({ ok: true, id });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ id }), claims);
    expect(rig({}, r.file).svc.get(id)).toMatchObject({ status: 'completed', verification: VERIFIED });
  });

  it('a verifier that throws is a refusal, not a completion', async () => {
    const r = rig();
    const id = await approved(r);
    r.ports.verify = async () => {
      throw new Error('boom');
    };
    expect(await r.svc.end('moa', 'completed', 'done')).toMatchObject({ ok: false, code: 'unverified', problems: ['the verifier failed: boom'] });
    expect(r.svc.get(id)?.status).toBe('active');
  });

  it('a pending goal cannot be completed by Moa', async () => {
    const r = rig();
    await r.svc.propose(HQ, GOAL);
    r.ports.verify = passingVerify;
    expect(await r.svc.end('moa', 'completed', 'done')).toMatchObject({ ok: false, code: 'unverified' });
  });

  it('a goal cancelled while it was being verified is not completed', async () => {
    const r = rig();
    const id = await approved(r);
    r.ports.verify = async () => {
      await r.svc.end('operator', 'canceled', 'stop');
      return { ok: true, verification: VERIFIED };
    };
    expect(await r.svc.end('moa', 'completed', 'done')).toMatchObject({ ok: false, code: 'no_goal' });
    expect(r.svc.get(id)?.status).toBe('canceled');
  });

  it('cancel and the operator end need no verification', async () => {
    const r = rig();
    const verify = vi.fn(passingVerify);
    r.ports.verify = verify;
    await approved(r);
    expect(await r.svc.end('moa', 'canceled', 'not needed')).toMatchObject({ ok: true });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('moa goal — delivery and revert', () => {
  const DELIVERY = { at: 5, items: [{ taskId: 't1', branch: 'wtask/x', headSha: 'a'.repeat(40), base: 'main', pushed: true, prUrl: 'https://github.com/o/r/pull/7', prNumber: 7 }], revertRecipe: ['gh pr close 7'] };

  it('a verified completion is delivered, stored and reported', async () => {
    const r = rig();
    const id = await approved(r);
    r.ports.verify = passingVerify;
    const deliver = vi.fn(async () => DELIVERY);
    r.ports.deliver = deliver;
    const res = await r.svc.end('moa', 'completed', 'done');
    expect(res).toEqual({ ok: true, id, delivered: [{ branch: 'wtask/x', pushed: true, prUrl: 'https://github.com/o/r/pull/7' }] });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id }), VERIFIED);
    expect(rig({}, r.file).svc.get(id)?.delivery).toEqual(DELIVERY);
  });

  it('nothing is delivered for a refused completion; the refusal is kept for Settings', async () => {
    const r = rig();
    const id = await approved(r);
    r.ports.verify = async () => ({ ok: false, code: 'unverified', problems: ['task t1: the gate failed'] });
    const deliver = vi.fn(async () => DELIVERY);
    r.ports.deliver = deliver;
    await r.svc.end('moa', 'completed', 'done');
    expect(deliver).not.toHaveBeenCalled();
    expect(r.svc.get(id)?.lastCheck?.problems).toEqual(['task t1: the gate failed']);
    r.ports.verify = passingVerify;
    await r.svc.end('moa', 'completed', 'done');
    expect(r.svc.get(id)?.lastCheck).toBeUndefined();
  });

  it('a delivery that throws still completes the verified goal', async () => {
    const r = rig();
    const id = await approved(r);
    r.ports.verify = passingVerify;
    r.ports.deliver = async () => {
      throw new Error('gh exploded');
    };
    expect(await r.svc.end('moa', 'completed', 'done')).toMatchObject({ ok: true, id });
    expect(r.svc.get(id)?.status).toBe('completed');
  });

  it('revert closes what was delivered once, and refuses goals with nothing delivered', async () => {
    const r = rig();
    const id = await approved(r);
    expect(await r.svc.revert(id)).toEqual({ ok: false, code: 'not_completed' });
    r.ports.verify = passingVerify;
    r.ports.deliver = async () => DELIVERY;
    await r.svc.end('moa', 'completed', 'done');
    const revertDelivery = vi.fn(async (_c: _C, d: MoaGoalDelivery) => ({ ok: true, delivery: { ...d, reverted: { at: 9, by: 'operator' as const, notes: ['closed PR #7'] } }, notes: ['closed PR #7'] }));
    r.ports.revertDelivery = revertDelivery;
    expect(await r.svc.revert(id)).toEqual({ ok: true, notes: ['closed PR #7'] });
    expect(r.svc.get(id)?.delivery?.reverted?.notes).toEqual(['closed PR #7']);
    expect(await r.svc.revert(id)).toEqual({ ok: true, notes: ['closed PR #7'] });
    expect(revertDelivery).toHaveBeenCalledTimes(1);
  });
});

