// One push per awaiting episode, carried over when a record is replaced.
import { describe, it, expect } from 'vitest';
import { ApprovalPushRouter, TERMINAL_PROMPT_PUSH_GRACE_MS } from '../approvalPushRouter';
import type { PushPayload } from '../../../shared/push/pushEnvelope';
import type { ApprovalEvent, ApprovalRequest } from '../../approvals/types';

function record(id: string): ApprovalRequest {
  return { id, sessionId: 's1', agent: 'claude', kind: 'terminal_prompt', createdAt: 1, state: 'pending' };
}

function harness(present: { value: boolean }, graceMs = 0, orphanRetractMs?: number) {
  const sent: string[] = [];
  /** Every send in order, retractions included, with its collapse id. */
  const wire: Array<{ payload: PushPayload; collapseId: string }> = [];
  const parked = new Map<string, PushPayload>();
  let now = 1_000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 0;
  const router = new ApprovalPushRouter({
    build: (r) => ({ title: 't', body: r.id, approvalId: r.id }),
    buildRetraction: (r, deliveredId) => ({ title: 'retract', body: r.id, kind: 'approval_retraction', retractsApprovalId: deliveredId }),
    collapseId: (r) => `ap-${r.sessionId}`,
    suppress: () => present.value,
    send: (payload, opts) => {
      wire.push({ payload, collapseId: opts.collapseId });
      if (payload.approvalId !== undefined) sent.push(payload.approvalId as string);
    },
    park: (id, payload) => { parked.set(id, payload); },
    forget: (id) => { parked.delete(id); },
    graceMs,
    ...(orphanRetractMs !== undefined ? { orphanRetractMs } : {}),
    now: () => now,
    setTimer: (fn, ms) => { timers.set(++nextTimer, { fn, at: now + ms }); return nextTimer; },
    clearTimer: (handle) => { timers.delete(handle as number); },
  });
  /** The desktop goes away: the queue releases what it held, and says so. */
  const release = () => {
    const entries = [...parked];
    parked.clear();
    for (const [id, payload] of entries) {
      sent.push(id);
      wire.push({ payload, collapseId: 'ap-s1' });
      router.onParkedOutcome(id, 'delivered', 'ap-s1');
    }
  };
  /** The queue evicts a held push past its cap: never sent. */
  const drop = (id: string) => {
    parked.delete(id);
    router.onParkedOutcome(id, 'dropped', 'ap-s1');
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
  return { router, sent, wire, parked, release, drop, advance, retractions };
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
    // The banner on the phone is `a`'s, so that is the id the retraction names.
    expect(h.retractions().map((w) => w.payload.retractsApprovalId)).toEqual(['a']);
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

describe('ApprovalPushRouter — review fixes', () => {
  const G = TERMINAL_PROMPT_PUSH_GRACE_MS;
  const resolved = (id: string, extra: Partial<ApprovalRequest> = {}): ApprovalEvent => ({
    type: 'resolve', request: { ...record(id), state: 'resolved', ...extra },
  });
  const pressed = (id: string): ApprovalEvent => ({ type: 'press', request: { ...record(id), pressedAt: 5 } });
  const gate = (id: string, sessionId = 's1'): ApprovalRequest => ({ ...record(id), sessionId, kind: 'awaiting_permission' });

  it('a press inside the grace cancels it: never pushed, never retracted', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(5_000);
    h.router.onEvent(pressed('a'));
    h.advance(10 * G);
    h.router.onEvent(resolved('a', { pressedAt: 5 }));
    expect(h.wire).toEqual([]);
  });

  it('a press on a parked push forgets it, and a later release neither pushes nor retracts it', () => {
    const h = harness({ value: true }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    expect([...h.parked.keys()]).toEqual(['a']);
    h.router.onEvent(pressed('a'));
    expect(h.parked.size).toBe(0);
    h.release();
    h.router.onEvent(resolved('a', { pressedAt: 5 }));
    expect(h.wire).toEqual([]);
  });

  it('the tracking cap never evicts a record still inside its grace', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    for (let i = 0; i < 600; i++) h.router.onEvent({ type: 'create', request: gate(`g${i}`, `x${i}`) });
    h.advance(G);
    expect(h.sent).toContain('a');
  });

  it('the tracking cap never evicts a parked push: once released it is still retracted', () => {
    const present = { value: true };
    const h = harness(present, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    present.value = false;
    for (let i = 0; i < 600; i++) h.router.onEvent({ type: 'create', request: gate(`g${i}`, `x${i}`) });
    h.release();
    h.router.onEvent(resolved('a'));
    expect(h.retractions().map((w) => w.payload.retractsApprovalId)).toEqual(['a']);
  });

  it('a retraction names the approval id that was actually delivered, across replacements', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    for (const e of replaceEvents('a', 'b')) h.router.onEvent(e);
    for (const e of replaceEvents('b', 'c')) h.router.onEvent(e);
    h.router.onEvent(resolved('c'));
    expect(h.sent).toEqual(['a']);
    expect(h.retractions().map((w) => w.payload.retractsApprovalId)).toEqual(['a']);
  });

  it('does not retract when a gate push has since taken the same collapse id', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent({ type: 'create', request: gate('g') });
    h.router.onEvent(resolved('a'));
    expect(h.sent).toEqual(['a', 'g']);
    expect(h.retractions()).toEqual([]);
  });

  it('does not retract when another approval push has since taken the same collapse id', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent({ type: 'create', request: record('c') });
    h.advance(G);
    h.router.onEvent(resolved('a'));
    expect(h.sent).toEqual(['a', 'c']);
    expect(h.retractions()).toEqual([]);
  });

  it('a gate that takes over the collapse id, even parked, clears the orphaned banner', () => {
    const present = { value: false };
    const h = harness(present, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent({ type: 'supersede', request: { ...record('a'), state: 'superseded' } });
    present.value = true;
    h.router.onEvent({ type: 'create', request: gate('g') });
    expect([...h.parked.keys()]).toEqual(['g']);
    h.router.onEvent({ type: 'create', request: record('c') });
    h.router.onEvent(resolved('c'));
    h.release();
    h.advance(100 * G);
    expect(h.retractions()).toEqual([]);
  });

  it('a delivered record superseded with no follow-up retracts itself once, after a bound', () => {
    const h = harness({ value: false }, G, 3 * G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent({ type: 'supersede', request: { ...record('a'), state: 'superseded' } });
    h.advance(3 * G - 1);
    expect(h.retractions()).toEqual([]);
    h.advance(1);
    expect(h.retractions().map((w) => w.payload.retractsApprovalId)).toEqual(['a']);
    h.advance(100 * G);
    expect(h.retractions()).toHaveLength(1);
  });

  it('the orphan bound outlasts a follow-up grace, so a follow-up push is never preceded by a retraction', () => {
    const h = harness({ value: false }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent({ type: 'supersede', request: { ...record('a'), state: 'superseded' } });
    h.router.onEvent({ type: 'create', request: record('c') });
    h.advance(100 * G);
    expect(h.sent).toEqual(['a', 'c']);
    expect(h.retractions()).toEqual([]);
  });

  it('a pressed follow-up leaves the orphaned banner to retract itself', () => {
    const h = harness({ value: false }, G, 3 * G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.router.onEvent({ type: 'supersede', request: { ...record('a'), state: 'superseded' } });
    h.router.onEvent({ type: 'create', request: record('c') });
    h.router.onEvent(pressed('c'));
    h.router.onEvent(resolved('c', { pressedAt: 5 }));
    expect(h.retractions()).toEqual([]);
    h.advance(3 * G);
    expect(h.retractions().map((w) => w.payload.retractsApprovalId)).toEqual(['a']);
  });

  it('adopt() re-arms a pending record\'s grace from its createdAt', () => {
    const h = harness({ value: false }, G);
    const now = 1_000;
    h.router.adopt([{ ...record('a'), createdAt: now - 5_000 }, { ...record('old'), sessionId: 's2', createdAt: now - 10 * G }]);
    h.advance(0);
    expect(h.sent).toEqual(['old']);
    h.advance(G - 5_000 - 1);
    expect(h.sent).toEqual(['old']);
    h.advance(1);
    expect(h.sent).toEqual(['old', 'a']);
  });

  it('a parked push the queue dropped is never retracted', () => {
    const h = harness({ value: true }, G);
    h.router.onEvent({ type: 'create', request: record('a') });
    h.advance(G);
    h.drop('a');
    h.router.onEvent(resolved('a'));
    expect(h.wire).toEqual([]);
  });
});
