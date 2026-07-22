// Unit tests for the fleet-wide concurrent-turn gate: the cap holds, releases
// free slots back, and a below-zero release clamps + warns exactly once.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGlobalTurnGate, GlobalTurnGate, DEFAULT_GLOBAL_TURN_CAP } from '../globalTurnGate';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('globalTurnGate', () => {
  it('defaults to a cap of 2', () => {
    expect(DEFAULT_GLOBAL_TURN_CAP).toBe(2);
    const gate = createGlobalTurnGate();
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false); // third over the default cap
    expect(gate.inFlight).toBe(2);
  });

  it('acquires up to the cap, then rejects; a release frees exactly one slot', () => {
    const gate = createGlobalTurnGate(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    gate.release();
    expect(gate.inFlight).toBe(1);
    expect(gate.tryAcquire()).toBe(true); // the freed slot is reusable
    expect(gate.tryAcquire()).toBe(false);
  });

  it('a cap below 1 is clamped up to 1 (never zero — nothing could ever run)', () => {
    const gate = new GlobalTurnGate(0);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
  });

  it('release below zero clamps at 0 and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gate = createGlobalTurnGate(2);
    gate.release(); // no slot in flight
    gate.release(); // still none
    expect(gate.inFlight).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1); // once, not per call
    // A legitimate acquire after the underflow still works.
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.inFlight).toBe(1);
  });

  it('a larger cap allows more concurrent slots', () => {
    const gate = createGlobalTurnGate(4);
    for (let i = 0; i < 4; i++) expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    expect(gate.inFlight).toBe(4);
  });
});
