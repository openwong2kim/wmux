import { afterEach, describe, expect, it } from 'vitest';
import {
  MOA_L0_REFUSED_METHODS,
  commanderLevelRefusal,
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
    const surface = new Set<string>(COMMANDER_RPC_METHODS as readonly string[]);
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
