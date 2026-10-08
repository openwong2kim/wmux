import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  session: { fromPartition: vi.fn() },
}));

import { clearPrivateSession } from '../privateSession';

function fakeSession() {
  const order: string[] = [];
  return {
    order,
    session: {
      clearStorageData: vi.fn(async () => { order.push('storage'); }),
      clearCache: vi.fn(async () => { order.push('cache'); }),
      clearAuthCache: vi.fn(async () => { order.push('auth'); }),
    },
  };
}

describe('clearPrivateSession', () => {
  it('waits until no private guest is alive before clearing', async () => {
    const { session, order } = fakeSession();
    let live = 2;
    const liveCount = vi.fn(() => {
      // The closed tabs' guests die one poll at a time.
      const now = live;
      if (live > 0) live -= 1;
      if (now > 0) expect(order).toEqual([]);
      return now;
    });

    await clearPrivateSession({ session, liveCount, pollMs: 1, waitMs: 1_000 });

    expect(liveCount).toHaveBeenCalledTimes(3);
    expect(order.sort()).toEqual(['auth', 'cache', 'storage']);
  });

  it('gives up waiting after the bound and clears anyway', async () => {
    const { session, order } = fakeSession();

    await clearPrivateSession({ session, liveCount: () => 1, pollMs: 1, waitMs: 20 });

    expect(order.sort()).toEqual(['auth', 'cache', 'storage']);
  });

  it('runs every part and logs each failure separately', async () => {
    const { session } = fakeSession();
    session.clearCache.mockRejectedValueOnce(new Error('cache boom'));
    session.clearAuthCache.mockRejectedValueOnce(new Error('auth boom'));
    const warn = vi.fn();

    await clearPrivateSession({ session, liveCount: () => 0, warn });

    expect(session.clearStorageData).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call) => [String(call[0]).includes('cache'), (call[1] as Error).message])).toEqual([
      [true, 'cache boom'],
      [true, 'auth boom'],
    ]);
    expect(String(warn.mock.calls[1][0])).toContain('auth cache');
  });
});
