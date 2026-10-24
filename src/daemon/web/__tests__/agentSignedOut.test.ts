import { describe, expect, it, vi } from 'vitest';
import { AgentLoginGate } from '../../agentLoginGate';
import { AgentSignedOutError, refuseSignedOutAgent, SESSION_LOGIN_WAIT_MS } from '../agentSignedOut';

const bounded = (gate: AgentLoginGate) => (agent: 'claude' | 'codex', env: NodeJS.ProcessEnv, opts: { waitMs: number }) => gate.check(agent, env, opts);

describe('refuseSignedOutAgent (POST /api/sessions agentLaunch)', () => {
  it('lets the create go on within the bound when the status command hangs', async () => {
    vi.useFakeTimers();
    try {
      const gate = new AgentLoginGate(() => new Promise<boolean | null>(() => undefined));
      const onSignedOut = vi.fn();
      let settled = false;
      const run = refuseSignedOutAgent(bounded(gate), 'claude', {}, onSignedOut).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(SESSION_LOGIN_WAIT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(settled).toBe(true);
      expect(onSignedOut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a surely signed-out account and raises the notice', async () => {
    const onSignedOut = vi.fn();
    const gate = new AgentLoginGate(async () => false);
    await expect(refuseSignedOutAgent(bounded(gate), 'codex', { CODEX_HOME: '/acc/cx' }, onSignedOut))
      .rejects.toEqual(new AgentSignedOutError('codex'));
    expect(onSignedOut).toHaveBeenCalledWith('codex');
  });

  it('creates as before when the status cannot tell, or the agent has no status command', async () => {
    const probe = vi.fn(async () => null as boolean | null);
    const gate = new AgentLoginGate(probe);
    await expect(refuseSignedOutAgent(bounded(gate), 'claude', {}, vi.fn())).resolves.toBeUndefined();
    await expect(refuseSignedOutAgent(bounded(gate), 'grok', {}, vi.fn())).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('lets the spawn-time refusals answer first: they run before the 409, and theirs wins', async () => {
    const gate = new AgentLoginGate(async () => false);
    const order: string[] = [];
    const onSignedOut = vi.fn(() => { order.push('notice'); });
    await expect(refuseSignedOutAgent(bounded(gate), 'claude', {}, onSignedOut, {
      beforeRefusing: async () => { order.push('spawn-checks'); },
    })).rejects.toBeInstanceOf(AgentSignedOutError);
    expect(order).toEqual(['spawn-checks', 'notice']);
    const expired = new Error('authorization-expired');
    await expect(refuseSignedOutAgent(bounded(gate), 'claude', {}, vi.fn(), { beforeRefusing: async () => { throw expired; } }))
      .rejects.toBe(expired);
    // Not signed out: the create goes on to the spawn, where those checks run as before.
    const before = vi.fn(async () => undefined);
    await refuseSignedOutAgent(bounded(new AgentLoginGate(async () => true)), 'claude', {}, vi.fn(), { beforeRefusing: before });
    expect(before).not.toHaveBeenCalled();
  });
});

