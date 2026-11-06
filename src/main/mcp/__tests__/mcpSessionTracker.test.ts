import { describe, expect, it, vi } from 'vitest';
import { McpSessionTracker } from '../mcpSessionTracker';

const id = (n: number) => n.toString(16).padStart(32, '0');

describe('McpSessionTracker', () => {
  it('counts distinct ids seen within the TTL', () => {
    let now = 0;
    const t = new McpSessionTracker({ now: () => now, ttlMs: 1000, cap: 8 });
    t.touch(id(1));
    t.touch(id(1));
    t.touch(id(2));
    expect(t.summary()).toEqual({ recent: 2, capped: false, ttlS: 1 });
    now = 1000; // exactly the TTL: still recent
    expect(t.summary().recent).toBe(2);
    t.touch(id(2));
    now = 1001;
    expect(t.summary().recent).toBe(1);
  });

  it('expires by age even when the clock stepped back between touches', () => {
    let now = 5000;
    const t = new McpSessionTracker({ now: () => now, ttlMs: 1000, cap: 8 });
    t.touch(id(1)); // seen at 5000
    now = 0;
    t.touch(id(2)); // seen at 0, touched later
    now = 1500; // id(2) is 1500 old; id(1) reads as from the future
    expect(t.has(id(2))).toBe(false);
    expect(t.summary().recent).toBe(1);
  });

  it('defaults to a monotonic clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t = new McpSessionTracker();
      t.touch(id(1));
      vi.setSystemTime(Date.now() + 3_600_000); // the wall clock is set an hour ahead
      expect(t.has(id(1))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores anything that is not 32 lowercase hex', () => {
    const t = new McpSessionTracker({ now: () => 0, ttlMs: 1000, cap: 8 });
    for (const bad of [undefined, null, 7, '', 'x'.repeat(32), id(1).toUpperCase() + 'a', id(1).slice(1), `${id(1)}\n`, { id: id(1) }]) {
      t.touch(bad);
    }
    expect(t.summary().recent).toBe(0);
  });

  it('holds at most the cap, evicting the least recently seen, and says so', () => {
    let now = 0;
    const t = new McpSessionTracker({ now: () => now, ttlMs: 10_000, cap: 3 });
    for (let i = 1; i <= 3; i++) {
      now = i;
      t.touch(id(i));
    }
    now = 4;
    t.touch(id(1)); // refreshed: id(2) is now the oldest
    now = 5;
    t.touch(id(4));
    expect(t.summary()).toMatchObject({ recent: 3, capped: true });
    expect(t.has(id(2))).toBe(false);
    expect(t.has(id(1))).toBe(true);
  });
});
