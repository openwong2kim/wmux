import { afterEach, describe, expect, it } from 'vitest';
import {
  MOA_L0_REFUSED_METHODS,
  commanderLevelRefusal,
  commanderScopeRefusal,
  moaGoalSendScope,
  moaScopeRefusal,
  moaLevelRefusal,
  setMoaLevelGate,
  type MoaLevelGateDeps,
} from '../moaLevelGate';
import { COMMANDER_RPC_METHODS } from '../../../shared/commanderSurface';
import type { MoaLevel } from '../../../shared/moa';

const HQ = 'ws-hq';

function deps(level: MoaLevel, goal: { goalId: string; humanOnly: string[] } | null = null): MoaLevelGateDeps {
  return { hqWorkspaceId: () => HQ, level: () => level, activeGoal: () => goal };
}

afterEach(() => setMoaLevelGate(null));

describe('moa level gate', () => {
  it('every L0-refused method is a real commander method', () => {
    const surface = new Set<string>(COMMANDER_RPC_METHODS as ReadonlySet<string>);
    for (const m of MOA_L0_REFUSED_METHODS) expect(surface.has(m), m).toBe(true);
  });

  it('level 0 refuses acting methods for the HQ and leaves reads alone', () => {
    for (const m of ['input.send', 'task.fanout.start', 'deck.proposeHandoff', 'a2a.task.send', 'approval.press', 'deck.proposeGoal']) {
      expect(moaLevelRefusal(deps(0), m, HQ, {})).toMatch(/level 0/);
    }
    for (const m of ['pane.list', 'input.readScreen', 'deck.askDecision', 'deck.goal']) {
      expect(moaLevelRefusal(deps(0), m, HQ, {})).toBeNull();
    }
  });

  it('level 1 (the default) refuses nothing — today\'s behaviour', () => {
    for (const m of MOA_L0_REFUSED_METHODS) expect(moaLevelRefusal(deps(1), m, HQ, { text: 'git push' })).toBeNull();
  });

  it('a commander that is not the HQ is never touched', () => {
    expect(moaLevelRefusal(deps(0), 'input.send', 'ws-other', {})).toBeNull();
    expect(moaLevelRefusal(deps(2, { goalId: 'G-1', humanOnly: [] }), 'input.send', 'ws-other', { text: 'git push' })).toBeNull();
  });

  it('under an active goal at L2+, sent text that asks for a hard-rule step is refused', () => {
    const g = deps(2, { goalId: 'G-1', humanOnly: ['database migration'] });
    expect(moaLevelRefusal(g, 'input.send', HQ, { text: 'now git push origin main' })).toMatch(/G-1.*remote/);
    expect(moaLevelRefusal(g, 'a2a.task.send', HQ, { message: 'open a PR when done' })).toMatch(/remote/);
    expect(moaLevelRefusal(g, 'a2a.task.send', HQ, { title: 'cat ~/.ssh/id_rsa' })).toMatch(/secret/);
    expect(moaLevelRefusal(g, 'a2a.broadcast', HQ, { message: 'run the database migration' })).toMatch(/human-only/);
    expect(moaLevelRefusal(g, 'input.send', HQ, { text: 'Fix the test and commit locally; do not push.' })).toBeNull();
  });

  it('without an active goal, L2/L3 behave like L1', () => {
    expect(moaLevelRefusal(deps(3), 'input.send', HQ, { text: 'git push' })).toBeNull();
  });

  it('the router hook: uninstalled = null, a throwing gate fails closed', () => {
    expect(commanderLevelRefusal('input.send', HQ, {})).toBeNull();
    setMoaLevelGate({ hqWorkspaceId: () => { throw new Error('boom'); }, level: () => 1, activeGoal: () => null });
    expect(commanderLevelRefusal('input.send', HQ, {})).toMatch(/could not be read/);
    setMoaLevelGate(deps(0));
    expect(commanderLevelRefusal('task.fanout.start', HQ, {})).toMatch(/level 0/);
  });
});

describe('owner decision 2 — under an active goal, direct sends stay inside the contract', () => {
  const owners: Record<string, string> = { 'pty-task': 'ws-task', 'pty-ops': 'ws-ops', 'pty-named': 'ws-named' };
  const counterparts: Record<string, string> = { 'task-in': 'ws-task', 'task-out': 'ws-ops' };
  function scoped(level: MoaLevel = 2, active = true, extra: Partial<MoaLevelGateDeps> = {}): MoaLevelGateDeps {
    return {
      hqWorkspaceId: () => HQ,
      level: () => level,
      activeGoal: () => (active ? { goalId: 'G-abc123', humanOnly: [], scope: ['ws-named', 'ws-task'] } : null),
      ptyOwner: async (p) => owners[p] ?? null,
      taskCounterparty: async (_hq, t) => counterparts[t] ?? null,
      ...extra,
    };
  }

  it('keystrokes and text to the goal\'s own panes pass; another workspace\'s pane is refused', async () => {
    for (const m of ['input.send', 'input.sendKey']) {
      expect(await moaScopeRefusal(scoped(), m, HQ, { ptyId: 'pty-task', text: 'use fixture A', key: 'enter' })).toBeNull();
      expect(await moaScopeRefusal(scoped(), m, HQ, { ptyId: 'pty-named', text: 'x', key: 'enter' })).toBeNull();
      const r = await moaScopeRefusal(scoped(), m, HQ, { ptyId: 'pty-ops', text: 'use fixture A', key: 'enter' });
      expect(r).toMatch(/refused under goal G-abc123: workspace ws-ops is outside the goal's contract/);
      expect(r).toMatch(/moa_propose_handoff/);
    }
  });

  it('fails closed when the pane\'s owner or the target cannot be told', async () => {
    expect(await moaScopeRefusal(scoped(), 'input.send', HQ, { ptyId: 'pty-gone', text: 'x' })).toMatch(/could not be resolved/);
    expect(await moaScopeRefusal(scoped(), 'input.send', HQ, { text: 'x' })).toMatch(/no pane or workspace was named/);
    expect(await moaScopeRefusal(scoped(2, true, { ptyOwner: undefined }), 'input.send', HQ, { ptyId: 'pty-task', text: 'x' })).toMatch(/could not be resolved/);
    expect(await moaScopeRefusal(scoped(2, true, { ptyOwner: async () => { throw new Error('renderer gone'); } }), 'input.sendKey', HQ, { ptyId: 'pty-task', key: 'enter' })).toMatch(/could not be resolved/);
    // a named workspace with no pane: its own id decides
    expect(await moaScopeRefusal(scoped(), 'input.send', HQ, { workspaceId: 'ws-task', text: 'x' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'input.send', HQ, { workspaceId: 'ws-ops', text: 'x' })).toMatch(/ws-ops is outside/);
  });

  it('A2A replies and follow-ups go by the task\'s other side; a status move sends nothing', async () => {
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { taskId: 'task-in', message: 'ok' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { taskId: 'task-out', message: 'ok' })).toMatch(/ws-ops is outside/);
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { taskId: 'task-unknown', message: 'ok' })).toMatch(/could not be read/);
    expect(await moaScopeRefusal(scoped(), 'a2a.task.update', HQ, { taskId: 'task-out', message: 'more work' })).toMatch(/ws-ops is outside/);
    expect(await moaScopeRefusal(scoped(), 'a2a.task.update', HQ, { taskId: 'task-out', status: 'completed' })).toBeNull();
    // a new task naming a workspace id literally is checked here; names go to the renderer's narrowed list
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { to: 'ws-ops', message: 'x' })).toMatch(/ws-ops is outside/);
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { to: 'ws-task', message: 'x' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { to: 'Workspace 1', message: 'x' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'a2a.broadcast', HQ, { message: 'x' })).toMatch(/broadcast reaches workspaces outside/);
  });

  it('with no active goal, at level 1, or for another commander: today\'s lane, nothing refused', async () => {
    for (const d of [scoped(2, false), scoped(1, true), scoped(3, false)]) {
      expect(await moaScopeRefusal(d, 'input.send', HQ, { ptyId: 'pty-ops', text: 'x' })).toBeNull();
      expect(await moaScopeRefusal(d, 'a2a.broadcast', HQ, { message: 'x' })).toBeNull();
    }
    expect(await moaScopeRefusal(scoped(), 'input.send', 'ws-other', { ptyId: 'pty-ops', text: 'x' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'pane.list', HQ, {})).toBeNull();
  });

  it('the installed gate answers RpcRouter and the a2a handler; uninstalled it is silent', async () => {
    expect(await commanderScopeRefusal('input.send', HQ, { ptyId: 'pty-ops', text: 'x' })).toBeNull();
    expect(moaGoalSendScope(HQ)).toBeNull();
    setMoaLevelGate(scoped());
    expect(await commanderScopeRefusal('input.send', HQ, { ptyId: 'pty-ops', text: 'x' })).toMatch(/outside the goal's contract/);
    expect(await commanderScopeRefusal('input.send', HQ, { ptyId: 'pty-task', text: 'x' })).toBeNull();
    expect(moaGoalSendScope(HQ)).toEqual([HQ, 'ws-named', 'ws-task']);
    expect(moaGoalSendScope('ws-other')).toBeNull();
  });
});
