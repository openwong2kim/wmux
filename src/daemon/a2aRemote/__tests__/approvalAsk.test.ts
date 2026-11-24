// The asking PC's checks before an approval leaves it: the offer in the task's
// latest status, and the pace per receiving PC.
import { describe, expect, it } from 'vitest';
import { A2A_APPROVALS_RECEIVED_WINDOW_MS, A2A_APPROVALS_SENT_PER_WINDOW, A2A_APPROVALS_SENT_WINDOW_MS, parseA2aRemoteStatus, type A2aRemoteStatusV1 } from '../../../shared/a2aRemote';
import { ApprovalPacer, checkApprovalOffer } from '../approvalAsk';

const PROMPT = '0123456789abcdef';
const HOST_A = '22222222-2222-4222-8222-222222222222';
const HOST_B = '33333333-3333-4333-8333-333333333333';

/** A status as this PC keeps it: parsed from the other PC's words. */
function status(approval: Record<string, unknown>): A2aRemoteStatusV1 {
  const parsed = parseA2aRemoteStatus({ kind: 'question', since: '2026-11-19T00:00:00.000Z', detail: { question: 'permission', approval } });
  if (!parsed) throw new Error('not a status');
  return parsed;
}

describe('checkApprovalOffer', () => {
  it('a deny-only offer refuses allow here, and takes deny', () => {
    const s = status({ promptId: PROMPT, tool: 'Read', redacted: false, cut: false, allowed: ['deny'] });
    expect(checkApprovalOffer(s, PROMPT, 'allow')).toMatchObject({ ok: false, error: 'deny-only' });
    expect(checkApprovalOffer(s, PROMPT, 'deny')).toMatchObject({ ok: true, offer: { tool: 'Read' } });
  });

  it('an offer that says allow but whose command was cut, redacted or not shown is deny-only as read here', () => {
    for (const offer of [
      { promptId: PROMPT, tool: 'Bash', command: 'ls', redacted: false, cut: true, allowed: ['allow', 'deny'] },
      { promptId: PROMPT, tool: 'Bash', command: 'ls', redacted: true, cut: false, allowed: ['allow', 'deny'] },
      { promptId: PROMPT, tool: 'Bash', redacted: false, cut: false, allowed: ['allow', 'deny'] },
    ]) {
      expect(checkApprovalOffer(status(offer), PROMPT, 'allow')).toMatchObject({ ok: false, error: 'deny-only' });
    }
    const whole = status({ promptId: PROMPT, tool: 'Bash', command: 'ls', redacted: false, cut: false, allowed: ['allow', 'deny'] });
    expect(checkApprovalOffer(whole, PROMPT, 'allow')).toMatchObject({ ok: true });
  });

  it('no offer, or another prompt id than the one offered now: not-offered', () => {
    expect(checkApprovalOffer(undefined, PROMPT, 'deny')).toMatchObject({ ok: false, error: 'not-offered' });
    const s = status({ promptId: 'fedcba9876543210', tool: 'Bash', redacted: false, cut: false, allowed: ['deny'] });
    expect(checkApprovalOffer(s, PROMPT, 'deny')).toMatchObject({ ok: false, error: 'not-offered' });
  });
});

describe('ApprovalPacer', () => {
  it(`takes ${A2A_APPROVALS_SENT_PER_WINDOW} per PC in a rolling window, then says how long to wait`, () => {
    const clock = { now: 1_000_000 };
    const pacer = new ApprovalPacer(() => clock.now);
    for (let i = 0; i < A2A_APPROVALS_SENT_PER_WINDOW; i++) {
      expect(pacer.waitMs(HOST_A)).toBe(0);
      pacer.note(HOST_A);
      clock.now += 10;
    }
    const wait = pacer.waitMs(HOST_A);
    expect(wait).toBeGreaterThan(0);
    // Another PC has its own count.
    expect(pacer.waitMs(HOST_B)).toBe(0);
    clock.now += wait;
    expect(pacer.waitMs(HOST_A)).toBe(0);
  });

  it('60 late in one minute and 60 early in the next are never 120 within one minute: the window rolls', () => {
    const clock = { now: 0 };
    const pacer = new ApprovalPacer(() => clock.now);
    const sentAt: number[] = [];
    // Late in a minute: 60 sent in its last second.
    clock.now = 59_000;
    for (let i = 0; i < 60; i++) { expect(pacer.waitMs(HOST_A)).toBe(0); pacer.note(HOST_A); sentAt.push(clock.now); clock.now += 10; }
    // Right after the minute turns, as many as it takes, every 100 ms for a minute.
    for (clock.now = 60_000; clock.now < 120_000; clock.now += 100) {
      if (pacer.waitMs(HOST_A) === 0) { pacer.note(HOST_A); sentAt.push(clock.now); }
    }
    // However a one-minute window falls on the send times, it holds at most 60 (arrival times can differ).
    for (const start of sentAt) {
      expect(sentAt.filter((t) => t >= start && t < start + 60_000).length).toBeLessThanOrEqual(60);
    }
    expect(A2A_APPROVALS_SENT_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('reduces, but cannot rule out, a 61st in the receiving PC\'s minute: it counts at arrival, a delay that varies moves them closer', () => {
    const clock = { now: 0 };
    const pacer = new ApprovalPacer(() => clock.now);
    const arrivals: number[] = [];
    // 60 sent at once, held on the way for 3 s.
    for (let i = 0; i < 60; i++) { pacer.note(HOST_A); arrivals.push(3_000); }
    // The pace lets the 61st go once its window rolls; it arrives at once.
    clock.now = A2A_APPROVALS_SENT_WINDOW_MS;
    expect(pacer.waitMs(HOST_A)).toBe(0);
    arrivals.push(clock.now);
    expect(arrivals.filter((t) => t >= 3_000 && t < 3_000 + A2A_APPROVALS_RECEIVED_WINDOW_MS)).toHaveLength(61);
  });

  it('only what was noted counts: a check alone sends nothing', () => {
    const pacer = new ApprovalPacer(() => 0);
    for (let i = 0; i < 1000; i++) expect(pacer.waitMs(HOST_A)).toBe(0);
  });
});
