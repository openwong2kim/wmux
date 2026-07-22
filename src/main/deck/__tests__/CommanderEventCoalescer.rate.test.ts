// Rule 7 — the UNCONDITIONAL sliding-window wake ceiling. Distinct from the
// consecutive budget (which a running loop lifts and a human send resets): the
// rate ceiling applies loop-or-not, is never reset by a human, and self-heals
// via a belt timer when the window next slides. Fake timers drive both the belt
// timer and Date.now together (vitest mocks Date), so the window advances in
// lockstep with the scheduled retry.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CommanderEventCoalescer,
  type CoalescerInput,
} from '../CommanderEventCoalescer';
import { type WorkspaceAutonomy } from '../deckAutonomyStore';

const AUTO_AUTONOMY: WorkspaceAutonomy = {
  mode: 'auto',
  summarize: true,
  continueInstruction: true,
  approvalPress: true,
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

interface Harness {
  c: CommanderEventCoalescer;
  prompts: { ws: string; prompt: string }[];
  setBusy: (b: boolean) => void;
}

function mk(opts: {
  maxWakesPerMin?: number;
  wakeBudget?: number;
  loop?: { running: boolean; iterations: number } | null;
} = {}): Harness {
  let busy = false;
  const prompts: { ws: string; prompt: string }[] = [];
  const c = new CommanderEventCoalescer({
    runTurn: async (ws, prompt) => {
      prompts.push({ ws, prompt });
      return { ok: true };
    },
    isBusy: () => busy,
    getAutonomy: () => ({ ...AUTO_AUTONOMY }),
    getLoop: () => opts.loop ?? null,
    debounceMs: 50,
    wakeBudget: opts.wakeBudget ?? 100,
    maxWakesPerMin: opts.maxWakesPerMin ?? 6,
  });
  return { c, prompts, setBusy: (b) => { busy = b; } };
}

const stop = (seq: number, ptyId = 'ptyA'): CoalescerInput => ({
  workspaceId: 'ws-1',
  ptyId,
  kind: 'agent.stop',
  source: 'hook',
  agent: 'claude',
  seq,
  ts: seq * 1000,
});

/** Push a distinct-seq event and drive its idle flush to completion. */
async function fire(h: Harness, seq: number): Promise<void> {
  h.c.push(stop(seq));
  h.c.notifyIdle('ws-1');
  await settle();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CommanderEventCoalescer — sliding-window rate ceiling (rule 7)', () => {
  it('caps ACCEPTED wakes at maxWakesPerMin, then rate-limits (no loop)', async () => {
    const h = mk({ maxWakesPerMin: 6, wakeBudget: 100 });
    for (const seq of [1, 2, 3, 4, 5, 6]) await fire(h, seq);
    expect(h.prompts).toHaveLength(6);

    // 7th within the same 60s window → over the ceiling, buffer retained.
    await fire(h, 7);
    expect(h.prompts).toHaveLength(6);
    expect(h.c.getPhase('ws-1')).toBe('rate-limited');
    expect(h.c.getWatermark('ws-1')).toBe(6); // 7 not consumed — it must still land
  });

  it('a running loop with a huge iteration budget CANNOT exceed the ceiling', async () => {
    // The loop lifts the CONSECUTIVE budget (iterations=999) but NOT the raw
    // rate ceiling — a firehose of events still tops out at 6/min.
    const h = mk({ maxWakesPerMin: 6, loop: { running: true, iterations: 999 } });
    for (const seq of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) await fire(h, seq);
    expect(h.prompts).toHaveLength(6);
    expect(h.c.getPhase('ws-1')).toBe('rate-limited');
    // The loop framing is still present — the cap is a frequency guard, not a
    // mode change.
    expect(h.prompts[0].prompt).toContain('loop-mode: ACTIVE');
  });

  it('the belt timer reopens the window when it slides (self-healing, no new event)', async () => {
    const h = mk({ maxWakesPerMin: 6, loop: { running: true, iterations: 999 } });
    for (const seq of [1, 2, 3, 4, 5, 6]) await fire(h, seq);
    expect(h.prompts).toHaveLength(6);

    // 7th is buffered under the ceiling; a belt timer is armed for the slide.
    await fire(h, 7);
    expect(h.prompts).toHaveLength(6);
    expect(h.c.getPhase('ws-1')).toBe('rate-limited');

    // Advance past the 60s window — the belt timer alone (no fresh event) drains
    // the buffered 7th.
    await vi.advanceTimersByTimeAsync(60_001);
    await settle();
    expect(h.prompts).toHaveLength(7);
    expect(h.prompts[6].prompt).toContain('seq=7');
    expect(h.c.getWatermark('ws-1')).toBe(7);
  });

  it('a human send resets the consecutive budget but NOT the rate ceiling', async () => {
    const h = mk({ maxWakesPerMin: 6, wakeBudget: 100 });
    for (const seq of [1, 2, 3, 4, 5, 6]) await fire(h, seq);
    expect(h.prompts).toHaveLength(6);

    // Human types: budget counter resets, buffer drops — but the timestamps that
    // fill the window are a raw-frequency guard and survive.
    h.c.notifyHumanSend('ws-1');
    await fire(h, 7);
    expect(h.prompts).toHaveLength(6);
    expect(h.c.getPhase('ws-1')).toBe('rate-limited');

    // Once the window slides, wakes resume.
    await vi.advanceTimersByTimeAsync(60_001);
    await settle();
    expect(h.prompts).toHaveLength(7);
  });

  it('a partial slide admits exactly the freed slots', async () => {
    const h = mk({ maxWakesPerMin: 3, loop: { running: true, iterations: 999 } });
    // Three wakes at t=0.
    for (const seq of [1, 2, 3]) await fire(h, seq);
    expect(h.prompts).toHaveLength(3);
    // t=30s: a fourth is over the ceiling (all three still in the 60s window).
    await vi.advanceTimersByTimeAsync(30_000);
    await fire(h, 4);
    expect(h.prompts).toHaveLength(3);
    expect(h.c.getPhase('ws-1')).toBe('rate-limited');
    // t=60.001s: the three t=0 stamps age out — the buffered 4th drains.
    await vi.advanceTimersByTimeAsync(30_001);
    await settle();
    expect(h.prompts).toHaveLength(4);
  });
});
