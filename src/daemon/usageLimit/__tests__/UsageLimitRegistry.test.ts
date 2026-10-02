import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '../../../shared/rpc';
import type { SessionPromptScheduleResult } from '../../../shared/sessionPromptSchedule';
import { USAGE_LIMIT_RESUME_GRACE_MS } from '../../../shared/usageLimit';
import { UsageLimitRegistry } from '../UsageLimitRegistry';

const NOW = Date.UTC(2026, 9, 3, 10, 0);
const LIMIT_TEXT = "You've hit your limit · resets 11:30pm (Asia/Seoul)"; // 14:30Z today
const RESET = Date.UTC(2026, 9, 3, 14, 30);

function setup(result: SessionPromptScheduleResult = 'sent') {
  let now = NOW;
  const events: DaemonEvent[] = [];
  const deliverContinue = vi.fn(async () => result);
  const registry = new UsageLimitRegistry({
    broadcast: (e) => events.push(e),
    deliverContinue,
    now: () => now,
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  return { registry, events, deliverContinue, advance: (ms: number) => { now += ms; } };
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

    advance(RESET - NOW + USAGE_LIMIT_RESUME_GRACE_MS);
    expect(registry.holds('p1')).toBe(false);
  });

  it('never sends a continue unless armed, and sends exactly one when armed', async () => {
    const { registry, deliverContinue, advance } = setup('sent');
    registry.noteHookSignal('p1', limitHit);
    advance(RESET - NOW + USAGE_LIMIT_RESUME_GRACE_MS);
    await registry.tick();
    expect(deliverContinue).not.toHaveBeenCalled();

    await registry.update('p1', { autoResume: true });
    await registry.tick();
    await registry.tick();
    expect(deliverContinue).toHaveBeenCalledTimes(1);
    expect(registry.get('p1')).toBeUndefined();
  });

  it('retries a busy pane, disarms on error, and clears on the next prompt', async () => {
    const { registry, deliverContinue, advance } = setup('busy');
    registry.noteHookSignal('p1', limitHit);
    await registry.update('p1', { autoResume: true });
    advance(RESET - NOW + USAGE_LIMIT_RESUME_GRACE_MS);
    await registry.tick();
    expect(registry.get('p1')?.autoResume).toBe(true);

    deliverContinue.mockResolvedValueOnce('error');
    await registry.tick();
    expect(registry.get('p1')?.autoResume).toBe(false);

    registry.noteHookSignal('p1', { kind: 'agent.user_prompt_submit' });
    expect(registry.get('p1')).toBeUndefined();
  });

  it('keeps the hold through output while held, and lets main fill an unknown reset', async () => {
    const { registry } = setup();
    registry.noteScreenLimit('c1', 'codex', { message: "You've hit your usage limit." });
    registry.noteActive('c1');
    expect(registry.holds('c1')).toBe(true);
    expect(registry.get('c1')?.resetsAt).toBeUndefined();
    await registry.update('c1', { resetsAt: RESET });
    await registry.update('c1', { resetsAt: RESET + 1 });
    expect(registry.get('c1')?.resetsAt).toBe(RESET);
  });
});
