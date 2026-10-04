import { describe, it, expect, vi } from 'vitest';
import { notifyPrOwner, publishPrOwnerEvent, setPrOwnerSink, type PrOwnerEvent } from '../prOwnerNotify';

const EV = { workspaceId: 'ws-1', prNumber: 123, url: 'https://github.com/o/r/pull/123', kind: 'pr.ci_failed' as const, headSha: 'abc1234' };

function ports(hasBrain = false) {
  const sent: PrOwnerEvent[] = [];
  return { sent, p: { hasBrain: vi.fn(() => hasBrain), send: (ev: PrOwnerEvent) => (sent.push(ev), true) } };
}

describe('notifyPrOwner', () => {
  it('a workspace with no brain (mode off) gets the pointer', () => {
    const { sent, p } = ports(false);
    expect(notifyPrOwner(EV, p)).toBe(true);
    expect(sent).toEqual([{ ...EV, seq: expect.any(Number) }]);
    expect(p.hasBrain).toHaveBeenCalledWith('ws-1');
  });

  it('never addresses a workspace whose brain hears the event (the HQ included)', () => {
    const { sent, p } = ports(true);
    expect(notifyPrOwner(EV, p)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('never addresses the HQ workspace, even while its brain is down', () => {
    const { sent, p } = ports(false);
    expect(notifyPrOwner(EV, { ...p, isHq: (ws) => ws === 'ws-1' })).toBe(false);
    expect(notifyPrOwner({ ...EV, workspaceId: 'ws-2' }, { ...p, isHq: (ws) => ws === 'ws-1' })).toBe(true);
    expect(sent.map((e) => e.workspaceId)).toEqual(['ws-2']);
  });

  it('only the fixed fields travel: no external text, a malformed head commit is dropped', () => {
    const { sent, p } = ports(false);
    notifyPrOwner({ ...EV, headSha: 'x; rm -rf', snippet: 'body', author: 'someone' } as typeof EV, p);
    expect(Object.keys(sent[0]).sort()).toEqual(['kind', 'prNumber', 'seq', 'url', 'workspaceId']);
  });

  it('refuses an unknown kind or a non-PR number', () => {
    const { sent, p } = ports(false);
    expect(notifyPrOwner({ ...EV, kind: 'pr.ci' as never }, p)).toBe(false);
    expect(notifyPrOwner({ ...EV, prNumber: 0 }, p)).toBe(false);
    expect(notifyPrOwner({ ...EV, workspaceId: '' }, p)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('publish goes through the installed sink and never throws', () => {
    const sink = vi.fn();
    setPrOwnerSink(sink);
    publishPrOwnerEvent(EV);
    expect(sink).toHaveBeenCalledWith(EV);
    setPrOwnerSink(() => { throw new Error('boom'); });
    expect(() => publishPrOwnerEvent(EV)).not.toThrow();
    setPrOwnerSink(null);
    expect(() => publishPrOwnerEvent(EV)).not.toThrow();
  });
});
