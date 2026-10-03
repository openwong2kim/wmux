// The main bot's master switch (isEnabled) and the handling of a turn the
// caller refused with `rate_limited` (the HQ's hourly turn cap), both added for
// the HQ main bot (deckHqStore.ts).

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

function mk(opts: { enabled?: () => boolean } = {}) {
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

describe('CommanderEventCoalescer — a capped turn (rate_limited)', () => {
  it('keeps the buffer and retries once the cap lifts, instead of consuming the events', async () => {
    let capped = true;
    const prompts: string[] = [];
    const c = new CommanderEventCoalescer({
      runTurn: async (_ws, prompt) => {
        if (capped) return { ok: false, code: 'rate_limited', retryAfterMs: 10 * 60_000 };
        prompts.push(prompt);
        return { ok: true };
      },
      isBusy: () => false,
      getAutonomy: () => ({ ...AUTO_AUTONOMY }),
      debounceMs: 50,
      wakeBudget: 1000,
      maxWakesPerMin: 1000,
    });
    c.push(stop(1));
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(c.getPhase('ws-1')).toBe('rate-limited');
    expect(c.getWatermark('ws-1')).toBe(0); // not consumed
    // No retry spin while capped: one belt timer, at the retry time.
    expect(vi.getTimerCount()).toBe(1);
    capped = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('seq=1');
  });
});
