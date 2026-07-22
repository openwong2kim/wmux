// Unit tests for the fleet-wide concurrent-turn gate: the cap holds, releases
// free slots back (by token), a wedged slot is reclaimed once its lease elapses,
// a stale/double release is a safe no-op, and the FIFO waiter queue honours
// timeout + its upper bound.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createGlobalTurnGate,
  GlobalTurnGate,
  DEFAULT_GLOBAL_TURN_CAP,
} from '../globalTurnGate';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('globalTurnGate — cap + token release', () => {
  it('defaults to a cap of 2', () => {
    expect(DEFAULT_GLOBAL_TURN_CAP).toBe(2);
    const gate = createGlobalTurnGate();
    expect(gate.tryAcquire('a')).toBeTruthy();
    expect(gate.tryAcquire('b')).toBeTruthy();
    expect(gate.tryAcquire('c')).toBeNull(); // third over the default cap
    expect(gate.inFlight).toBe(2);
  });

  it('acquires up to the cap, then rejects; a release frees exactly one slot', () => {
    const gate = createGlobalTurnGate(2);
    const t1 = gate.tryAcquire('a');
    expect(t1).toBeTruthy();
    expect(gate.tryAcquire('b')).toBeTruthy();
    expect(gate.tryAcquire('c')).toBeNull();
    gate.release(t1!);
    expect(gate.inFlight).toBe(1);
    expect(gate.tryAcquire('d')).toBeTruthy(); // the freed slot is reusable
    expect(gate.tryAcquire('e')).toBeNull();
  });

  it('hands out distinct tokens per slot', () => {
    const gate = createGlobalTurnGate(2);
    const t1 = gate.tryAcquire('a');
    const t2 = gate.tryAcquire('b');
    expect(t1).not.toBe(t2);
  });

  it('a cap below 1 is clamped up to 1 (never zero — nothing could ever run)', () => {
    const gate = new GlobalTurnGate(0);
    expect(gate.tryAcquire('a')).toBeTruthy();
    expect(gate.tryAcquire('b')).toBeNull();
  });

  it('a larger cap allows more concurrent slots', () => {
    const gate = createGlobalTurnGate(4);
    for (let i = 0; i < 4; i++) expect(gate.tryAcquire(`w${i}`)).toBeTruthy();
    expect(gate.tryAcquire('over')).toBeNull();
    expect(gate.inFlight).toBe(4);
  });
});

describe('globalTurnGate — stale + double release are safe no-ops', () => {
  it('a double release of the same token does not phantom-decrement', () => {
    const gate = createGlobalTurnGate(2);
    const t1 = gate.tryAcquire('a')!;
    gate.tryAcquire('b');
    gate.release(t1);
    gate.release(t1); // second release of an already-freed token — no-op
    expect(gate.inFlight).toBe(1); // b's slot untouched
    expect(gate.tryAcquire('c')).toBeTruthy(); // exactly one slot free
    expect(gate.tryAcquire('d')).toBeNull();
  });

  it('an unknown token release is a no-op', () => {
    const gate = createGlobalTurnGate(1);
    gate.tryAcquire('a');
    gate.release('turn-999'); // never handed out
    expect(gate.inFlight).toBe(1);
  });
});

describe('globalTurnGate — wedged-slot lease reclaim', () => {
  it('reclaims a slot held past its lease and warns once, naming the workspace', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gate = new GlobalTurnGate(2, { leaseMs: 1000 });
    gate.tryAcquire('ws-wedged-1');
    gate.tryAcquire('ws-wedged-2');
    expect(gate.tryAcquire('ws-3')).toBeNull(); // gate full

    vi.advanceTimersByTime(1001); // both leases elapse

    // The next acquire sweeps the two wedged slots, then succeeds.
    const t3 = gate.tryAcquire('ws-3');
    expect(t3).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(2); // one per reclaimed slot
    expect(warn.mock.calls[0][0]).toContain('ws-wedged-1');
    expect(gate.inFlight).toBe(1); // only ws-3 remains
  });

  it("a wedged turn's late release() is a no-op after its slot was reclaimed", () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gate = new GlobalTurnGate(1, { leaseMs: 1000 });
    const wedged = gate.tryAcquire('ws-wedged')!;

    vi.advanceTimersByTime(1001); // wedged slot expires
    const fresh = gate.tryAcquire('ws-fresh'); // reclaims wedged, takes the slot
    expect(fresh).toBeTruthy();
    expect(gate.inFlight).toBe(1);

    // The wedged turn finally finishes far too late and releases its old token.
    gate.release(wedged); // must NOT free ws-fresh's slot
    expect(gate.inFlight).toBe(1);
    expect(gate.tryAcquire('ws-other')).toBeNull(); // still full — cap intact
  });
});

describe('globalTurnGate — acquireWhenAvailable (FIFO waiters)', () => {
  it('resolves immediately when a slot is free', async () => {
    const gate = createGlobalTurnGate(1);
    const tok = await gate.acquireWhenAvailable(1000, 'a');
    expect(tok).toBeTruthy();
  });

  it('queues FIFO and hands each freed slot to the next waiter in order', async () => {
    const gate = new GlobalTurnGate(1, { leaseMs: 10 * 60_000 });
    const t1 = gate.tryAcquire('a')!; // gate full
    const order: string[] = [];
    const pB = gate.acquireWhenAvailable(60_000, 'b').then((t) => {
      order.push('b');
      return t;
    });
    const pC = gate.acquireWhenAvailable(60_000, 'c').then((t) => {
      order.push('c');
      return t;
    });

    gate.release(t1); // → b (first waiter)
    const tB = await pB;
    expect(tB).toBeTruthy();
    expect(order).toEqual(['b']); // c still waiting

    gate.release(tB!); // → c
    const tC = await pC;
    expect(tC).toBeTruthy();
    expect(order).toEqual(['b', 'c']);
    gate.dispose();
  });

  it('resolves null on timeout without leaking the waiter', async () => {
    vi.useFakeTimers();
    const gate = createGlobalTurnGate(1);
    gate.tryAcquire('a'); // full
    const p = gate.acquireWhenAvailable(1000, 'b');
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBeNull();
    // The timed-out waiter was removed: a later release finds no one queued.
    gate.dispose();
  });

  it('rejects (resolves null) immediately once the waiter bound is reached', async () => {
    const gate = new GlobalTurnGate(1, { maxWaiters: 2, leaseMs: 10 * 60_000 });
    gate.tryAcquire('a'); // full
    const p1 = gate.acquireWhenAvailable(60_000, 'w1');
    const p2 = gate.acquireWhenAvailable(60_000, 'w2');
    const p3 = gate.acquireWhenAvailable(60_000, 'w3'); // over the bound
    await expect(p3).resolves.toBeNull();
    // p1/p2 are still legitimately queued.
    gate.dispose();
    await expect(p1).resolves.toBeNull(); // dispose drains them
    await expect(p2).resolves.toBeNull();
  });

  it('dispose() resolves all queued waiters null and refuses new ones', async () => {
    const gate = new GlobalTurnGate(1, { leaseMs: 10 * 60_000 });
    gate.tryAcquire('a');
    const p = gate.acquireWhenAvailable(60_000, 'b');
    gate.dispose();
    await expect(p).resolves.toBeNull();
    await expect(gate.acquireWhenAvailable(60_000, 'c')).resolves.toBeNull();
  });
});
