import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '../../../shared/rpc';
import type { SessionPromptScheduleResult } from '../../../shared/sessionPromptSchedule';
import { USAGE_LIMIT_RESUME_GRACE_MS, USAGE_LIMIT_UNKNOWN_HOLD_MS } from '../../../shared/usageLimit';
import { USAGE_LIMIT_MAX_BUSY_RETRIES, UsageLimitRegistry, type UsageLimitAgentIdentity } from '../UsageLimitRegistry';

const NOW = Date.UTC(2026, 9, 3, 10, 0);
const LIMIT_TEXT = "You've hit your limit · resets 11:30pm (Asia/Seoul)"; // 14:30Z today
const RESET = Date.UTC(2026, 9, 3, 14, 30);
const PAST_RESET = RESET - NOW + USAGE_LIMIT_RESUME_GRACE_MS;

function setup(result: SessionPromptScheduleResult = 'sent', agent: UsageLimitAgentIdentity | null = { slug: 'claude', incarnationId: 'inc-1' }) {
  let now = NOW;
  let identity = agent;
  const events: DaemonEvent[] = [];
  const deliverContinue = vi.fn(async (_id: string, _expected: UsageLimitAgentIdentity, _stillWanted: () => boolean) => result);
  const registry = new UsageLimitRegistry({
    broadcast: (e) => events.push(e),
    identify: () => identity,
    deliverContinue,
    now: () => now,
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  return {
    registry, events, deliverContinue,
    advance: (ms: number) => { now += ms; },
    swapAgent: (next: UsageLimitAgentIdentity | null) => { identity = next; },
  };
}

const limitHit = { kind: 'agent.stop_failure', payload: { error: 'rate_limit', last_assistant_message: LIMIT_TEXT } };

describe('UsageLimitRegistry', () => {
  it('holds a pane from a usage-limit StopFailure until the reset, and ignores a plain 429', () => {
    const { registry, events, advance } = setup();
    registry.noteHookSignal('p1', { kind: 'agent.stop_failure', payload: { error: 'rate_limit', last_assistant_message: 'API Error: 429' } });
    expect(registry.holds('p1')).toBe(false);

    registry.noteHookSignal('p1', limitHit);
    expect(registry.get('p1')).toMatchObject({ provider: 'claude', source: 'hook', resetsAt: RESET });
    expect(registry.holds('p1')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'usage.limit.changed', sessionId: 'p1' });

    advance(PAST_RESET);
    expect(registry.holds('p1')).toBe(false);
  });

  it('never sends a continue unless armed, and sends exactly one to the agent seen at the limit', async () => {
    const { registry, deliverContinue, advance, swapAgent } = setup('sent');
    registry.noteHookSignal('p1', limitHit);
    swapAgent({ slug: 'claude', incarnationId: 'inc-2' }); // relaunched later
    advance(PAST_RESET);
    await registry.tick();
    expect(deliverContinue).not.toHaveBeenCalled();

    await registry.update('p1', { autoResume: true });
    await Promise.all([registry.tick(), registry.tick()]);
    await registry.tick();
    expect(deliverContinue).toHaveBeenCalledTimes(1);
    // The expectation is the detection-time agent, so the proof refuses the relaunch.
    expect(deliverContinue.mock.calls[0][1]).toEqual({ slug: 'claude', incarnationId: 'inc-1' });
    expect(registry.get('p1')).toBeUndefined();
  });

  it('ignores a limit that names a different agent than the pane runs', () => {
    const { registry } = setup('sent', { slug: 'codex', incarnationId: 'inc-1' });
    registry.noteHookSignal('p1', limitHit);
    expect(registry.get('p1')).toBeUndefined();
  });

  it('withdraws an in-flight continue the operator dismissed', async () => {
    const { registry, deliverContinue, advance } = setup('sent');
    let wantedAtSend: boolean | null = null;
    deliverContinue.mockImplementationOnce(async (_id, _e, stillWanted) => {
      await registry.update('p1', { dismiss: true });
      wantedAtSend = stillWanted();
      return 'error';
    });
    registry.noteHookSignal('p1', limitHit);
    await registry.update('p1', { autoResume: true });
    advance(PAST_RESET);
    await registry.tick();
    expect(wantedAtSend).toBe(false);
    expect(registry.get('p1')).toBeUndefined();
  });

  it('retries a busy pane up to a cap, disarms on error, and clears on the next submit', async () => {
    const { registry, deliverContinue, advance } = setup('busy');
    registry.noteHookSignal('p1', limitHit);
    await registry.update('p1', { autoResume: true });
    advance(PAST_RESET);
    for (let i = 0; i < USAGE_LIMIT_MAX_BUSY_RETRIES - 1; i++) await registry.tick();
    expect(registry.get('p1')?.autoResume).toBe(true);
    await registry.tick();
    expect(registry.get('p1')?.autoResume).toBe(false);

    await registry.update('p1', { autoResume: true });
    deliverContinue.mockResolvedValueOnce('error');
    await registry.tick();
    expect(registry.get('p1')?.autoResume).toBe(false);

    registry.noteSubmitted('p1');
    expect(registry.get('p1')).toBeUndefined();
  });

  it('does not move a known reset when the same screen row is redrawn, nor re-hold a dismissed one', async () => {
    const { registry, advance } = setup('sent', { slug: 'codex', incarnationId: 'inc-1' });
    const row = "■ You've hit your usage limit. Try again in 2 hours.";
    registry.noteScreenLimit('c1', 'codex', { resetsAt: NOW + 7_200_000, message: row });
    advance(600_000);
    registry.noteScreenLimit('c1', 'codex', { resetsAt: NOW + 600_000 + 7_200_000, message: row });
    expect(registry.get('c1')?.resetsAt).toBe(NOW + 7_200_000);

    await registry.update('c1', { dismiss: true });
    registry.noteScreenLimit('c1', 'codex', { resetsAt: NOW + 9_000_000, message: row });
    expect(registry.get('c1')).toBeUndefined();

    // After a submit the agent's fresh report is honoured, same words or not.
    registry.noteSubmitted('c1');
    registry.noteScreenLimit('c1', 'codex', { resetsAt: NOW + 9_000_000, message: row });
    expect(registry.holds('c1')).toBe(true);
  });

  it('holds again with a fresh sighting once a capped hold expired', () => {
    const { registry, advance } = setup('sent', { slug: 'codex', incarnationId: 'inc-1' });
    registry.noteScreenLimit('c1', 'codex', { message: 'a' });
    advance(USAGE_LIMIT_UNKNOWN_HOLD_MS + 1);
    expect(registry.holds('c1')).toBe(false);
    registry.noteScreenLimit('c1', 'codex', { message: 'b' });
    expect(registry.holds('c1')).toBe(true);
    expect(registry.get('c1')?.detectedAt).toBe(NOW + USAGE_LIMIT_UNKNOWN_HOLD_MS + 1);
  });

  it('forgets a long-ended hold that can never resume, even when armed', async () => {
    const { registry, advance } = setup('sent', { slug: 'codex', incarnationId: 'inc-1' });
    registry.noteScreenLimit('c1', 'codex', {});
    await registry.update('c1', { autoResume: true });
    advance(30 * 60 * 60 * 1000);
    await registry.tick();
    expect(registry.get('c1')).toBeUndefined();
  });

  it('keeps the hold through output while held, and lets main fill an unknown reset', async () => {
    const { registry } = setup('sent', { slug: 'codex', incarnationId: 'inc-1' });
    registry.noteScreenLimit('c1', 'codex', { message: "You've hit your usage limit." });
    registry.noteActive('c1');
    expect(registry.holds('c1')).toBe(true);
    expect(registry.get('c1')?.resetsAt).toBeUndefined();
    await registry.update('c1', { resetsAt: RESET });
    await registry.update('c1', { resetsAt: RESET + 1 });
    expect(registry.get('c1')?.resetsAt).toBe(RESET);
  });
});
