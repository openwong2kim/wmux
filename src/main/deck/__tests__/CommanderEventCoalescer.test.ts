// Unit tests for the event-push coalescer state machine + the pure untrusted
// prompt builder. Covers the plan's COALESCER / LOOP-BUDGET / AUTONOMY test
// matrix. Fake timers drive the debounce deterministically.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CommanderEventCoalescer,
  buildEventPrompt,
  type CoalescerInput,
  type BufferedEvent,
} from '../CommanderEventCoalescer';
import { DEFAULT_AUTONOMY, type WorkspaceAutonomy } from '../deckAutonomyStore';

/** Wake-on-everything autonomy (mode=auto) — the harness default so the
 *  plumbing tests aren't affected by the assist value filter. */
const AUTO_AUTONOMY: WorkspaceAutonomy = {
  mode: 'auto',
  summarize: true,
  continueInstruction: true,
  approvalPress: true,
};

// Two microtask flushes: enough to settle a runTurn().then() chain.
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

interface Harness {
  c: CommanderEventCoalescer;
  prompts: { ws: string; prompt: string }[];
  setBusy: (b: boolean) => void;
  setRunResult: (r: { ok: boolean; code?: string }) => void;
  setLoop: (l: { running: boolean; iterations: number } | null) => void;
}

function makeHarness(over: Partial<Parameters<typeof mk>[0]> = {}): Harness {
  return mk(over);
}

function mk(opts: {
  wakeBudget?: number;
  debounceMs?: number;
  autonomy?: WorkspaceAutonomy;
  loop?: { running: boolean; iterations: number } | null;
  /** Global auto-wake switch dep — omitted = enabled (shipped behavior). */
  isAutoWakeEnabled?: () => boolean;
}): Harness {
  let busy = false;
  let runResult: { ok: boolean; code?: string } = { ok: true };
  let loop: { running: boolean; iterations: number } | null = opts.loop ?? null;
  const prompts: { ws: string; prompt: string }[] = [];
  const c = new CommanderEventCoalescer({
    runTurn: async (ws, prompt) => {
      prompts.push({ ws, prompt });
      return runResult;
    },
    isBusy: () => busy,
    // Default to AUTO (wake on every event) so the plumbing tests below
    // — coalescing, budget, watermark — exercise the wake path regardless of
    // the new mode value filter. The value-filter behavior gets its own block.
    getAutonomy: () => opts.autonomy ?? { ...AUTO_AUTONOMY },
    getLoop: () => loop,
    ...(opts.isAutoWakeEnabled ? { isAutoWakeEnabled: opts.isAutoWakeEnabled } : {}),
    debounceMs: opts.debounceMs ?? 1_000,
    wakeBudget: opts.wakeBudget ?? 5,
  });
  return {
    c,
    prompts,
    setBusy: (b) => {
      busy = b;
    },
    setRunResult: (r) => {
      runResult = r;
    },
    setLoop: (l) => {
      loop = l;
    },
  };
}

const stop = (seq: number, ptyId = 'ptyA', ws = 'ws-1'): CoalescerInput => ({
  workspaceId: ws,
  ptyId,
  kind: 'agent.stop',
  source: 'hook',
  agent: 'claude',
  seq,
  ts: seq * 1000,
});

const awaiting = (
  seq: number,
  o: { ptyId?: string; ws?: string; source?: 'hook' | 'detector' } = {},
): CoalescerInput => ({
  workspaceId: o.ws ?? 'ws-1',
  ptyId: o.ptyId ?? 'ptyA',
  kind: 'agent.awaiting_input',
  source: o.source ?? 'detector',
  agent: 'codex',
  seq,
  ts: seq * 1000,
});

const buf = (over: Partial<BufferedEvent> = {}): BufferedEvent => ({
  ptyId: 'ptyA',
  kind: 'agent.awaiting_input',
  source: 'detector',
  agent: 'codex',
  seq: 1,
  ts: 1000,
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CommanderEventCoalescer — state machine', () => {
  it('busy → buffer → idle flush emits exactly ONE turn', async () => {
    const h = makeHarness({});
    h.setBusy(true);
    h.c.push(stop(1, 'ptyA'));
    h.c.push(stop(2, 'ptyB'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.prompts).toHaveLength(0); // nothing fires while busy
    expect(h.c.getPhase('ws-1')).toBe('buffering');

    h.setBusy(false);
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(1);
    // both panes in the single flush
    expect(h.prompts[0].prompt).toContain('pane=ptyA');
    expect(h.prompts[0].prompt).toContain('pane=ptyB');
  });

  it('stop THEN awaiting_input for the same pane → both survive the flush', async () => {
    const h = makeHarness({ debounceMs: 1_000 });
    h.c.push(stop(1, 'ptyA'));
    await vi.advanceTimersByTimeAsync(400);
    h.c.push(awaiting(2, { ptyId: 'ptyA' })); // restarts debounce; both buffered
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].prompt).toContain('kind=stop');
    expect(h.prompts[0].prompt).toContain('kind=awaiting');
    expect(h.prompts[0].prompt).toContain('seq=1');
    expect(h.prompts[0].prompt).toContain('seq=2');
  });

  it('debounce holds a stop until the awaiting_input lag window', async () => {
    const h = makeHarness({ debounceMs: 1_000 });
    h.c.push(stop(1, 'ptyA'));
    await vi.advanceTimersByTimeAsync(500);
    h.c.push(awaiting(2, { ptyId: 'ptyA' }));
    await vi.advanceTimersByTimeAsync(999); // still inside the restarted window
    expect(h.prompts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(h.prompts).toHaveLength(1);
  });

  it('seq watermark: an event already flushed is not re-sent', async () => {
    const h = makeHarness({});
    h.c.push(stop(5, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.c.getWatermark('ws-1')).toBe(5);

    // Re-push the SAME seq (a duplicate emit or a poll/push overlap) → dropped.
    h.c.push(stop(5, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(1);

    // A higher seq flushes normally.
    h.c.push(stop(6, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(2);
  });
});

describe('CommanderEventCoalescer — loop budget', () => {
  it('budget decrements per auto-wake and blocks when exhausted', async () => {
    const h = makeHarness({ wakeBudget: 2 });
    for (const seq of [1, 2]) {
      h.c.push(stop(seq, 'ptyA'));
      h.c.notifyIdle('ws-1');
      await settle();
    }
    expect(h.prompts).toHaveLength(2);
    expect(h.c.getWakeBudgetRemaining('ws-1')).toBe(0);

    // Third distinct event: budget exhausted → no wake.
    h.c.push(stop(3, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(2);
    expect(h.c.getPhase('ws-1')).toBe('budget-blocked');
  });

  it('a human send resets the budget and subsumes buffered events', async () => {
    const h = makeHarness({ wakeBudget: 1 });
    h.c.push(stop(1, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.c.getWakeBudgetRemaining('ws-1')).toBe(0);

    // Exhausted; a new event blocks.
    h.c.push(stop(2, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(1);

    // Human types → budget reset, buffer dropped, watermark advanced past buffered.
    h.c.notifyHumanSend('ws-1');
    expect(h.c.getWakeBudgetRemaining('ws-1')).toBe(1);
    expect(h.c.getWatermark('ws-1')).toBe(2);

    // A fresh event now wakes again.
    h.c.push(stop(3, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(2);
  });
});

describe('CommanderEventCoalescer — loop iteration budget (Ralph max-iterations)', () => {
  it('a RUNNING loop\'s iterations replace the ambient wake budget', async () => {
    const h = makeHarness({ wakeBudget: 2, loop: { running: true, iterations: 4 } });
    for (const seq of [1, 2, 3, 4]) {
      h.c.push(stop(seq, 'ptyA'));
      h.c.notifyIdle('ws-1');
      await settle();
    }
    // Ambient budget (2) would have blocked after two — the loop allows 4.
    expect(h.prompts).toHaveLength(4);
    // Fifth is blocked: loop budget exhausted.
    h.c.push(stop(5, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(4);
    expect(h.c.getPhase('ws-1')).toBe('budget-blocked');
  });

  it('a paused/absent loop falls back to the ambient budget IMMEDIATELY (dynamic read)', async () => {
    const h = makeHarness({ wakeBudget: 1, loop: { running: true, iterations: 10 } });
    // Two wakes pass under the loop budget…
    for (const seq of [1, 2]) {
      h.c.push(stop(seq, 'ptyA'));
      h.c.notifyIdle('ws-1');
      await settle();
    }
    expect(h.prompts).toHaveLength(2);
    // …loop stops (human clicked [stop]) → ambient budget 1 already consumed →
    // the very next event is blocked, no restart needed.
    h.setLoop(null);
    h.c.push(stop(3, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(2);
    expect(h.c.getPhase('ws-1')).toBe('budget-blocked');
  });

  it('human send resets the used counter under a loop budget too', async () => {
    const h = makeHarness({ loop: { running: true, iterations: 2 } });
    for (const seq of [1, 2]) {
      h.c.push(stop(seq, 'ptyA'));
      h.c.notifyIdle('ws-1');
      await settle();
    }
    expect(h.c.getWakeBudgetRemaining('ws-1')).toBe(0);
    h.c.notifyHumanSend('ws-1');
    expect(h.c.getWakeBudgetRemaining('ws-1')).toBe(2);
  });

  it('running loop + continue → loop-runner framing; report-only → assess framing; none without a loop', async () => {
    // continue tier
    const drive = makeHarness({
      loop: { running: true, iterations: 10 },
      autonomy: { mode: 'auto', summarize: true, continueInstruction: true, approvalPress: false },
    });
    drive.c.push(stop(1, 'ptyA'));
    drive.c.notifyIdle('ws-1');
    await settle();
    expect(drive.prompts[0].prompt).toContain('loop-mode: ACTIVE —');
    expect(drive.prompts[0].prompt).toContain('NEXT CONCRETE STEP');
    // Autonomous done-detection: a driving loop is told to PROPOSE completion via
    // the decision gate (which halts the wake-burn) instead of idling to budget.
    expect(drive.prompts[0].prompt).toContain('COMPLETION');
    expect(drive.prompts[0].prompt).toContain('deck_ask_decision');

    // report tier — a running loop with continueInstruction OFF (report-only).
    const report = makeHarness({
      loop: { running: true, iterations: 10 },
      autonomy: { mode: 'off', summarize: false, continueInstruction: false, approvalPress: false },
    });
    report.c.push(stop(1, 'ptyA'));
    report.c.notifyIdle('ws-1');
    await settle();
    expect(report.prompts[0].prompt).toContain('loop-mode: ACTIVE (report-only)');

    // no loop
    const none = makeHarness({});
    none.c.push(stop(1, 'ptyA'));
    none.c.notifyIdle('ws-1');
    await settle();
    expect(none.prompts[0].prompt).not.toContain('loop-mode');
  });

  it('the last in-budget wake carries the exhaustion notice', async () => {
    const h = makeHarness({ loop: { running: true, iterations: 2 } });
    h.c.push(stop(1, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts[0].prompt).not.toContain('LAST auto-wake');
    h.c.push(stop(2, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts[1].prompt).toContain('LAST auto-wake');
  });
});

describe('CommanderEventCoalescer — scheduler/human race', () => {
  it('a busy reject requeues (buffer retained), then flushes when idle', async () => {
    const h = makeHarness({});
    h.setRunResult({ ok: false, code: 'busy' });
    h.c.push(stop(1, 'ptyA'));
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(1); // attempted once
    expect(h.c.getPhase('ws-1')).toBe('buffering');
    expect(h.c.getWatermark('ws-1')).toBe(0); // NOT advanced — event not consumed

    // Racer finishes; retry succeeds.
    h.setRunResult({ ok: true });
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(2);
    expect(h.c.getWatermark('ws-1')).toBe(1);
  });
});

describe('buildEventPrompt — untrusted structured block + fail-closed approval', () => {
  const budget = { remaining: 3, total: 5 };

  it('always fences the block as untrusted and tags every line with its seq', () => {
    const p = buildEventPrompt([buf({ seq: 42 })], { ...DEFAULT_AUTONOMY }, budget);
    expect(p).toContain('[pane-events]');
    expect(p).toContain('UNTRUSTED');
    expect(p).toContain('seq=42');
    expect(p).toContain('wake-budget: 3/5');
  });

  it('detector-source awaiting_input + approvalPress on → VERIFY THEN PRESS (never a blind press)', () => {
    const p = buildEventPrompt(
      [buf({ source: 'detector', kind: 'agent.awaiting_input' })],
      { mode: 'auto', summarize: true, continueInstruction: true, approvalPress: true },
      budget,
    );
    expect(p).toContain('VERIFY THEN PRESS');
    expect(p).toContain('terminal_read');
    // The direct (hook-only) authorization phrasing must not leak in.
    expect(p).not.toContain('MAY press the approval per policy');
  });

  it('detector-source awaiting_input + approvalPress OFF → NOTIFY ONLY', () => {
    const p = buildEventPrompt(
      [buf({ source: 'detector', kind: 'agent.awaiting_input' })],
      { mode: 'assist', summarize: true, continueInstruction: true, approvalPress: false },
      budget,
    );
    expect(p).toContain('NOTIFY ONLY');
    expect(p).not.toContain('VERIFY THEN PRESS');
  });

  it('approvalPress off → a hook awaiting_input is NOTIFY ONLY', () => {
    const off = buildEventPrompt(
      [buf({ source: 'hook', kind: 'agent.awaiting_input' })],
      { mode: 'auto', summarize: true, continueInstruction: false, approvalPress: false },
      budget,
    );
    expect(off).toContain('NOTIFY ONLY');
    expect(off).not.toContain('MAY press the approval');
  });

  it('approvalPress on + hook source → the press is authorized', () => {
    const on = buildEventPrompt(
      [buf({ source: 'hook', kind: 'agent.awaiting_input' })],
      { mode: 'auto', summarize: true, continueInstruction: false, approvalPress: true },
      budget,
    );
    expect(on).toContain('MAY press the approval');
  });

  it('a stop is summarize-only unless continueInstruction is on', () => {
    const off = buildEventPrompt(
      [buf({ source: 'hook', kind: 'agent.stop' })],
      { mode: 'auto', summarize: true, continueInstruction: false, approvalPress: false },
      budget,
    );
    expect(off).toContain('summarize only');

    const on = buildEventPrompt(
      [buf({ source: 'hook', kind: 'agent.stop' })],
      { mode: 'auto', summarize: true, continueInstruction: true, approvalPress: false },
      budget,
    );
    expect(on).toContain('follow-up instruction');
  });
});

describe('CommanderEventCoalescer — global auto-wake switch', () => {
  it('switch OFF (no loop) → no wake; events are CONSUMED (watermark advanced)', async () => {
    const h = makeHarness({ isAutoWakeEnabled: () => false });
    h.c.push(stop(7, 'ptyA'));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(0);
    expect(h.c.getPhase('ws-1')).toBe('idle');
    // Consumed, not held: re-enabling must not replay a stale backlog.
    expect(h.c.getWatermark('ws-1')).toBe(7);
  });

  it('switch OFF but a loop is RUNNING → the wake still fires (explicit opt-in)', async () => {
    const h = makeHarness({
      isAutoWakeEnabled: () => false,
      loop: { running: true, iterations: 10 },
    });
    h.c.push(stop(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].prompt).toContain('loop-mode: ACTIVE');
  });

  it('switch OFF with a PAUSED loop → suppressed like ambient', async () => {
    const h = makeHarness({
      isAutoWakeEnabled: () => false,
      loop: { running: false, iterations: 10 },
    });
    h.c.push(stop(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(0);
  });

  it('a THROWING switch read resolves to enabled (shipped behavior)', async () => {
    const h = makeHarness({
      isAutoWakeEnabled: () => {
        throw new Error('torn read');
      },
    });
    h.c.push(stop(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(1);
  });

  it('turning the switch back ON wakes only for NEW events', async () => {
    let enabled = false;
    const h = makeHarness({ isAutoWakeEnabled: () => enabled });
    h.c.push(stop(3));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(0);

    enabled = true;
    h.c.push(stop(3)); // same seq — at/below watermark, dropped
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(0);

    h.c.push(stop(4));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].prompt).toContain('seq=4');
  });
});

describe('CommanderEventCoalescer — mode wake policy (value filter)', () => {
  const assist: WorkspaceAutonomy = {
    mode: 'assist', summarize: true, continueInstruction: true, approvalPress: false,
  };
  const offMode: WorkspaceAutonomy = {
    mode: 'off', summarize: false, continueInstruction: false, approvalPress: false,
  };

  it('assist DROPS a plain stop (consumed, no turn) — the summary-spam fix', async () => {
    const h = makeHarness({ autonomy: assist });
    h.c.push(stop(3));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(0);
    expect(h.c.getPhase('ws-1')).toBe('idle');
    // consumed, not held — re-enabling must not replay it.
    expect(h.c.getWatermark('ws-1')).toBe(3);
  });

  it('assist WAKES on awaiting_input (a pane blocked on input)', async () => {
    const h = makeHarness({ autonomy: assist });
    h.c.push(awaiting(4));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].prompt).toContain('kind=awaiting');
  });

  it('assist flushes awaiting_input but consumes a co-buffered stop', async () => {
    const h = makeHarness({ autonomy: assist, debounceMs: 1_000 });
    h.c.push(stop(5, 'ptyA'));
    await vi.advanceTimersByTimeAsync(400);
    h.c.push(awaiting(6, { ptyId: 'ptyB' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(h.prompts).toHaveLength(1);
    // Only the worthy awaiting event is surfaced; the stop is not.
    expect(h.prompts[0].prompt).toContain('seq=6');
    expect(h.prompts[0].prompt).not.toContain('seq=5');
    // But the stop was consumed (watermark past it), not left to re-fire.
    expect(h.c.getWatermark('ws-1')).toBe(6);
  });

  it('assist + a RUNNING loop wakes on a plain stop (override to all)', async () => {
    const h = makeHarness({ autonomy: assist, loop: { running: true, iterations: 10 } });
    h.c.push(stop(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].prompt).toContain('loop-mode: ACTIVE');
  });

  it('off-mode consumes EVERYTHING (stop AND awaiting), no turn', async () => {
    const h = makeHarness({ autonomy: offMode });
    h.c.push(stop(1));
    h.c.push(awaiting(2, { ptyId: 'ptyB' }));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(0);
    expect(h.c.getWatermark('ws-1')).toBe(2);
  });

  it('off-mode + a RUNNING loop still wakes (explicit opt-in override)', async () => {
    const h = makeHarness({ autonomy: offMode, loop: { running: true, iterations: 5 } });
    h.c.push(stop(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(1);
  });

  it('global auto-wake OFF overrides even mode=auto', async () => {
    const h = makeHarness({ autonomy: AUTO_AUTONOMY, isAutoWakeEnabled: () => false });
    h.c.push(awaiting(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(h.prompts).toHaveLength(0);
  });
});
