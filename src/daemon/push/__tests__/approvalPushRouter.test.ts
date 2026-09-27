// One push per awaiting episode, carried over when a record is replaced.
import { describe, it, expect } from 'vitest';
import { ApprovalPushRouter, TERMINAL_PROMPT_PUSH_GRACE_MS } from '../approvalPushRouter';
import type { PushPayload } from '../../../shared/push/pushEnvelope';
import type { ApprovalEvent, ApprovalRequest } from '../../approvals/types';

function record(id: string): ApprovalRequest {
  return { id, sessionId: 's1', agent: 'claude', kind: 'terminal_prompt', createdAt: 1, state: 'pending' };
}

function harness(present: { value: boolean }, graceMs = 0) {
  const sent: string[] = [];
  /** Every send in order, retractions included, with its collapse id. */
  const wire: Array<{ payload: PushPayload; collapseId: string }> = [];
  const parked = new Map<string, PushPayload>();
  let now = 1_000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 0;
  const router = new ApprovalPushRouter({
    build: (r) => ({ title: 't', body: r.id, approvalId: r.id }),
    buildRetraction: (r) => ({ title: 'retract', body: r.id, kind: 'approval_retraction', retractsApprovalId: r.id }),
    collapseId: (r) => `ap-${r.sessionId}`,
    suppress: () => present.value,
    send: (payload, opts) => {
      wire.push({ payload, collapseId: opts.collapseId });
      if (payload.approvalId !== undefined) sent.push(payload.approvalId as string);
    },
    park: (id, payload) => { parked.set(id, payload); },
    forget: (id) => { parked.delete(id); },
    isParked: (id) => parked.has(id),
    graceMs,
    now: () => now,
    setTimer: (fn, ms) => { timers.set(++nextTimer, { fn, at: now + ms }); return nextTimer; },
    clearTimer: (handle) => { timers.delete(handle as number); },
  });
  /** The desktop goes away: the queue releases what it held. */
  const release = () => {
    for (const [id, payload] of parked) {
      sent.push(id);
      wire.push({ payload, collapseId: 'ap-s1' });
    }
    parked.clear();
  };
  /** Move the clock, firing due timers in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  const retractions = () => wire.filter((w) => w.payload.kind === 'approval_retraction');
  return { router, sent, wire, parked, release, advance, retractions };
}

const replaceEvents = (from: string, to: string): ApprovalEvent[] => [
  { type: 'supersede', request: { ...record(from), state: 'superseded' } },
  { type: 'create', request: record(to), replaces: from },
];

describe('ApprovalPushRouter', () => {
  it('a replacement after the push went out sends nothing more', () => {
    const h = harness({ value: false });
    h.router.onEvent({ type: 'create', request: record('a') });
    for (const e of replaceEvents('a', 'b')) h.router.onEvent(e);
    expect(h.sent).toEqual(['a']);
  });

  it('a still-parked push moves to the replacing record, and goes out once', () => {
    const present = { value: true };
    const h = harness(present);
    h.router.onEvent({ type: 'create', request: record('a') });
    expect([...h.parked.keys()]).toEqual(['a']);
    for (const e of replaceEvents('a', 'b')) h.router.onEvent(e);
    expect([...h.parked.keys()]).toEqual(['b']);
    h.release();
    expect(h.sent).toEqual(['b']);
  });

  it('a parked push already released counts as sent', () => {
    const present = { value: true };
    const h = harness(present);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.release();
    for (const e of replaceEvents('a', 'b')) h.router.onEvent(e);
    expect(h.sent).toEqual(['a']);
    expect(h.parked.size).toBe(0);
  });

  it('a replacement whose predecessor was never pushed carries the episode\'s one push', () => {
    const h = harness({ value: false });
    for (const e of replaceEvents('ghost', 'b')) h.router.onEvent(e);
    expect(h.sent).toEqual(['b']);
  });

  it('a record answered or expired drops its parked push', () => {
    const h = harness({ value: true });
    h.router.onEvent({ type: 'create', request: record('a') });
    h.router.onEvent({ type: 'expire', request: { ...record('a'), state: 'expired' } });
    h.release();
    expect(h.sent).toEqual([]);
  });

  it('a plain supersede by a different question does not stop that question\'s own push', () => {
    const h = harness({ value: false });
    h.router.onEvent({ type: 'create', request: record('a') });
    h.router.onEvent({ type: 'supersede', request: { ...record('a'), state: 'superseded' } });
    h.router.onEvent({ type: 'create', request: { ...record('q'), kind: 'awaiting_input' } });
    expect(h.sent).toEqual(['a', 'q']);
  });
});

describe('ApprovalPushRouter — terminal_prompt grace and retraction', () => {
  const G = TERMINAL_PROMPT_PUSH_GRACE_MS;
  const resolved = (id: string, extra: Partial<ApprovalRequest> = {}): ApprovalEvent => ({
    type: 'resolve', request: { ...record(id), state: 'resolved', ...extra },
  });

  it('is pushed only once the grace has passed with the record still pending', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G - 1);
    expect(h.sent).toEqual([]);
    h.advance(1);
    expect(h.sent).toEqual(['a']);
    h.advance(10 * G);
    expect(h.wire).toHaveLength(1);
  });

  it('is never pushed when answered inside the grace', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(5_000);
    h.router.onEvent(resolved('a'));
    h.advance(10 * G);
    expect(h.wire).toEqual([]);
  });

  it('is never pushed when the dialog clears inside the grace', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(3_000);
    h.router.onEvent({ type: 'expire', request: { ...record('a'), state: 'expired' } });
    h.advance(10 * G);
    expect(h.wire).toEqual([]);
  });

  it('a record ended after its push retracts it once, under the same collapse id', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent(resolved('a'));
    h.router.onEvent(resolved('a'));
    expect(h.wire.map((w) => w.collapseId)).toEqual(['ap-s1', 'ap-s1']);
    expect(h.retractions()).toHaveLength(1);
    expect(h.retractions()[0].payload).not.toHaveProperty('approvalId');
    expect(h.retractions()[0].payload.retractsApprovalId).toBe('a');
  });

  it('a replacement inside the grace inherits the remaining time and pushes once', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(6_000);
    for (const e of replaceEvents('a', 'b')) h.router.onEvent(e);
    h.advance(G - 6_000 - 1);
    expect(h.sent).toEqual([]);
    h.advance(1);
    expect(h.sent).toEqual(['b']);
    h.advance(10 * G);
    expect(h.sent).toEqual(['b']);
  });

  it('the grace comes before presence parking, and a parked push never sent is not retracted', () => {
    const present = { value: true };
    const h = harness(present, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    expect([...h.parked.keys()]).toEqual(['a']);
    h.router.onEvent(resolved('a'));
    h.release();
    expect(h.wire).toEqual([]);
  });

  it('a parked push that was released is retracted when the record ends', () => {
    const h = harness({ value: true }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.release();
    h.router.onEvent(resolved('a'));
    expect(h.retractions()).toHaveLength(1);
  });

  it('an answer that came from a remote client (press) is not retracted', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent({ type: 'press', request: { ...record('a'), pressedAt: 5 } });
    h.router.onEvent(resolved('a', { pressedAt: 5 }));
    expect(h.retractions()).toEqual([]);
  });

  it('a delivered banner orphaned by a new question is retracted if that question ends unpushed', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent({ type: 'supersede', request: { ...record('a'), state: 'superseded' } });
    h.router.onEvent({ type: 'create', request: record('c') });
    h.advance(2_000);
    h.router.onEvent(resolved('c'));
    expect(h.sent).toEqual(['a']);
    expect(h.retractions().map((w) => w.payload.retractsApprovalId)).toEqual(['c']);
    expect(h.retractions()[0].collapseId).toBe('ap-s1');
  });

  it('gate records keep the instant push and are never retracted', () => {
    const h = harness({ value: false }, G);
    const gate: ApprovalRequest = { ...record('g'), kind: 'awaiting_permission' };
    h.router.onEvent({ type: 'create', request: gate });
    expect(h.sent).toEqual(['g']);
    h.router.onEvent({ type: 'resolve', request: { ...gate, state: 'resolved' } });
    expect(h.retractions()).toEqual([]);
  });
});
