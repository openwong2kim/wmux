// moa_propose_goal / moa_goal: wire mapping and the commander-only placement.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MOA_GOAL_COMPLETE_TIMEOUT_MS, registerMoaGoalTools } from '../goal';
import { COMMANDER_ONLY_TOOLS, COMMANDER_RPC_METHODS } from '../../shared/commanderSurface';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function collect(token: string | undefined = 'tok-hq') {
  const callRpc = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
  const handlers = new Map<string, Handler>();
  registerMoaGoalTools(((name: string, _d: string, _s: unknown, h: Handler) => {
    handlers.set(name, h);
  }) as never, { callRpc, getCommanderToken: () => token });
  return { callRpc, handlers };
}

describe('moa goal tools', () => {
  it('moa_propose_goal maps snake_case fields onto deck.proposeGoal with the token', async () => {
    const { callRpc, handlers } = collect();
    await handlers.get('moa_propose_goal')!({
      goal: 'Fix the flaky login test', repo: '/repo', workspace_ids: ['ws-a'], level: 2,
      max_tasks: 2, max_hours: 3, max_turns: 20, human_only: ['database migration'],
    });
    expect(callRpc).toHaveBeenCalledWith('deck.proposeGoal', {
      token: 'tok-hq', goal: 'Fix the flaky login test', repo: '/repo', workspaceIds: ['ws-a'], level: 2,
      budget: { maxTasks: 2, maxHours: 3, maxTurns: 20 }, humanOnly: ['database migration'],
    });
  });

  it('sends no absent optionals', async () => {
    const { callRpc, handlers } = collect();
    await handlers.get('moa_propose_goal')!({ goal: 'g', repo: '/r' });
    expect(callRpc.mock.calls[0][1]).toEqual({ token: 'tok-hq', goal: 'g', repo: '/r' });
  });

  it('moa_goal defaults to status and forwards complete with its summary', async () => {
    const { callRpc, handlers } = collect();
    await handlers.get('moa_goal')!({});
    await handlers.get('moa_goal')!({ action: 'complete', summary: 'fixed and verified by npm test' });
    expect(callRpc.mock.calls[0]).toEqual(['deck.goal', { token: 'tok-hq', action: 'status' }]);
    // Completing runs the goal's gates, so it waits longer.
    expect(callRpc.mock.calls[1]).toEqual(['deck.goal', { token: 'tok-hq', action: 'complete', summary: 'fixed and verified by npm test' }, MOA_GOAL_COMPLETE_TIMEOUT_MS]);
  });

  it('moa_goal complete forwards the per-criterion evidence', async () => {
    const { callRpc, handlers } = collect();
    const criteria = [{ criterion: 1, artifacts: ['/repo/test-output.txt'] }];
    await handlers.get('moa_goal')!({ action: 'complete', summary: 'fixed and verified by npm test', criteria });
    expect(callRpc.mock.calls[0][1]).toMatchObject({ action: 'complete', criteria });
  });

  it('is commander-only, with its RPCs in the commander lane and the first-party set', () => {
    for (const t of ['moa_propose_goal', 'moa_goal']) expect(COMMANDER_ONLY_TOOLS).toContain(t);
    for (const m of ['deck.proposeGoal', 'deck.goal'] as const) {
      expect(COMMANDER_RPC_METHODS.has(m)).toBe(true);
      expect(FIRST_PARTY_METHODS.has(m)).toBe(true);
    }
    const baseline = JSON.parse(readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'mcp-protocol-baseline.json'), 'utf8'));
    expect(baseline.profiles.commander.toolNames).toEqual(expect.arrayContaining(['moa_propose_goal', 'moa_goal']));
    expect(baseline.profiles.full.toolNames).not.toContain('moa_goal');
    expect(baseline.profiles.core.toolNames).not.toContain('moa_goal');
  });
});
