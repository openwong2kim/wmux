import { describe, it, expect } from 'vitest';
import { needsAttention, orderByAttention, orderByRecentActivity, orderWorkspaces } from '../attentionOrder';
import type { AgentStatus } from '../../../../shared/types';

const rows = [
  { id: 'a' },
  { id: 'b' },
  { id: 'c' },
  { id: 'd' },
];

function statusMap(map: Record<string, AgentStatus>) {
  return (id: string): AgentStatus => map[id] ?? 'idle';
}

describe('needsAttention', () => {
  it('is true only for the two stopped-on-you statuses', () => {
    expect(needsAttention('waiting')).toBe(true);
    expect(needsAttention('awaiting_input')).toBe(true);
    expect(needsAttention('running')).toBe(false);
    expect(needsAttention('complete')).toBe(false);
    expect(needsAttention('error')).toBe(false);
    expect(needsAttention('idle')).toBe(false);
  });
});

describe('orderByAttention', () => {
  it('is the identity when disabled, even with rows that would pin', () => {
    const statusOf = statusMap({ c: 'awaiting_input', a: 'waiting' });
    expect(orderByAttention(rows, statusOf, false).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lifts needs-attention rows to the top, stable in both partitions', () => {
    const statusOf = statusMap({ b: 'awaiting_input', d: 'waiting', c: 'running' });
    expect(orderByAttention(rows, statusOf, true).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('leaves the order alone when nothing needs attention', () => {
    const statusOf = statusMap({ a: 'running', b: 'complete', c: 'error', d: 'idle' });
    expect(orderByAttention(rows, statusOf, true).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not mutate the input array', () => {
    const statusOf = statusMap({ d: 'waiting' });
    const input = [...rows];
    orderByAttention(input, statusOf, true);
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

// #1481 — the "Recent activity" sort option.

describe('recent-activity order', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const at: Record<string, number> = { a: 10, b: 30, c: 0, d: 30 };

  it('puts the newest activity first, stable on ties, silent rows last', () => {
    expect(orderByRecentActivity(items, (id) => at[id]).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('dispatches on the sort mode and leaves manual untouched', () => {
    expect(orderWorkspaces(items, 'manual', () => 'idle', (id) => at[id])).toBe(items);
    expect(orderWorkspaces(items, 'recent', () => 'idle', (id) => at[id]).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(orderWorkspaces(items, 'attention', (id) => (id === 'c' ? 'awaiting_input' : 'idle'), () => 0).map((i) => i.id))
      .toEqual(['c', 'a', 'b', 'd']);
  });
});
