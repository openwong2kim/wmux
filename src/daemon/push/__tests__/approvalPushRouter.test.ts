// One push per awaiting episode, carried over when a record is replaced.
import { describe, it, expect } from 'vitest';
import { ApprovalPushRouter } from '../approvalPushRouter';
import type { PushPayload } from '../../../shared/push/pushEnvelope';
import type { ApprovalEvent, ApprovalRequest } from '../../approvals/types';

function record(id: string): ApprovalRequest {
  return { id, sessionId: 's1', agent: 'claude', kind: 'terminal_prompt', createdAt: 1, state: 'pending' };
}

function harness(present: { value: boolean }) {
  const sent: string[] = [];
  const parked = new Map<string, PushPayload>();
  const router = new ApprovalPushRouter({
    build: (r) => ({ title: 't', body: r.id, approvalId: r.id }),
    collapseId: (r) => `ap-${r.sessionId}`,
    suppress: () => present.value,
    send: (payload) => { sent.push(payload.approvalId as string); },
    park: (id, payload) => { parked.set(id, payload); },
    forget: (id) => { parked.delete(id); },
    isParked: (id) => parked.has(id),
  });
  /** The desktop goes away: the queue releases what it held. */
  const release = () => {
    for (const [id] of parked) sent.push(id);
    parked.clear();
  };
  return { router, sent, parked, release };
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
