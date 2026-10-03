// The main bot's master switch (isEnabled) and the HQ's optional hourly wake
// cap (getMaxWakesPerHour), both added for the HQ main bot (deckHqStore.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommanderEventCoalescer, type CoalescerInput } from '../CommanderEventCoalescer';
import { type WorkspaceAutonomy } from '../deckAutonomyStore';

const AUTO_AUTONOMY: WorkspaceAutonomy = {
  mode: 'danger', wakePolicy: 'all',
  summarize: true,
  continueInstruction: true,
  approvalPress: true,
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function mk(opts: { enabled?: () => boolean; hourCap?: number | null } = {}) {
  const prompts: string[] = [];
  const c = new CommanderEventCoalescer({
    runTurn: async (_ws, prompt) => {
      prompts.push(prompt);
      return { ok: true };
    },
    isBusy: () => false,
    getAutonomy: () => ({ ...AUTO_AUTONOMY }),
    debounceMs: 50,
    wakeBudget: 1000,
    maxWakesPerMin: 1000,
    ...(opts.enabled ? { isEnabled: opts.enabled } : {}),
    ...(opts.hourCap !== undefined ? { getMaxWakesPerHour: () => opts.hourCap ?? null } : {}),
  });
  return { c, prompts };
}

const stop = (seq: number, workspaceId = 'ws-1'): CoalescerInput => ({
  workspaceId,
  ptyId: 'ptyA',
  kind: 'agent.stop',
  source: 'hook',
  agent: 'claude',
  seq,
  ts: seq,
});

const stateCount = (c: CommanderEventCoalescer): number =>
  (c as unknown as { states: Map<string, unknown> }).states.size;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CommanderEventCoalescer — master switch', () => {
  it('drops every push at the entry while off: no per-workspace state, no timer, no turn', async () => {
    const h = mk({ enabled: () => false });
    for (let i = 1; i <= 500; i++) h.c.push(stop(i, `ws-${i % 50}`));
    expect(stateCount(h.c)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.prompts).toHaveLength(0);
  });

  it('suspend cancels a pending flush, and pushes resume once the switch is back on', async () => {
    let on = true;
    const h = mk({ enabled: () => on });
    h.c.push(stop(1));
    expect(vi.getTimerCount()).toBe(1);
    on = false;
    h.c.suspend();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.prompts).toHaveLength(0);

    on = true;
    h.c.push(stop(2));
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(h.prompts).toHaveLength(1);
  });
});

describe('CommanderEventCoalescer — optional hourly cap', () => {
  async function fire(h: ReturnType<typeof mk>, seq: number): Promise<void> {
    h.c.push(stop(seq));
    h.c.notifyIdle('ws-1');
    await settle();
    // Space wakes past the per-minute window so only the hourly cap binds.
    await vi.advanceTimersByTimeAsync(61_000);
  }

  it('caps accepted wakes per trailing hour, then resumes when the hour slides', async () => {
    const h = mk({ hourCap: 3 });
    for (const seq of [1, 2, 3]) await fire(h, seq);
    expect(h.prompts).toHaveLength(3);
    await fire(h, 4);
    expect(h.prompts).toHaveLength(3);
    expect(h.c.getPhase('ws-1')).toBe('rate-limited');
    // The belt timer retries once the oldest wake leaves the hour window.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await settle();
    expect(h.prompts).toHaveLength(4);
  });

  it('applies no hourly cap when none is configured (today)', async () => {
    for (const h of [mk(), mk({ hourCap: null })]) {
      for (let seq = 1; seq <= 15; seq++) await fire(h, seq);
      expect(h.prompts).toHaveLength(15);
    }
  });
});
