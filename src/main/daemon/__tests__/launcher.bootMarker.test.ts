// Issue #546 — the launcher's reuse path must not SIGKILL a daemon that is
// alive and provably still cold-recovering.
//
// The daemon writes daemon.pid at lock acquisition but daemon-pipe only after
// recoverSessions completes (~19-23 s for 30-35 sessions); in between it cannot
// answer a ping. The old path granted it tryEscalatedReping (~1.9 s) and then
// killed it, restarting the same recovery and thrashing the respawn budget into
// local mode with duplicate sessions (the #537 symptom).
//
// These are pure decision tests — no live daemon, no real clock, no fs. Every
// effect is injected, same seam tryEscalatedReping uses.
import { describe, it, expect } from 'vitest';
import {
  parseBootMarker,
  waitOutRecoveringDaemon,
  BOOT_WAIT_POLL_MS,
} from '../launcher';

/** Fake clock + sleep: sleeping advances `now`, so the ceiling is reachable
 *  without any real waiting. */
function makeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    advance: (ms: number) => { now += ms; },
  };
}

describe('#546 parseBootMarker', () => {
  it('reads a missing marker as "not booting"', () => {
    expect(parseBootMarker(null, 4242)).toBe(false);
  });

  it('reads a marker naming our verified PID as "booting"', () => {
    expect(parseBootMarker('4242', 4242)).toBe(true);
  });

  it('tolerates trailing whitespace/newline from the daemon write', () => {
    expect(parseBootMarker('4242\n', 4242)).toBe(true);
    expect(parseBootMarker('  4242  ', 4242)).toBe(true);
  });

  it('rejects a marker naming a DIFFERENT pid', () => {
    // A leftover from some other daemon must never buy the live PID a grace
    // period — PID equality is the whole safety argument.
    expect(parseBootMarker('999', 4242)).toBe(false);
  });

  it('rejects an unparseable marker', () => {
    expect(parseBootMarker('', 4242)).toBe(false);
    expect(parseBootMarker('garbage', 4242)).toBe(false);
  });

  it('rejects NaN-ish input rather than coercing it', () => {
    expect(parseBootMarker('NaN', 4242)).toBe(false);
  });
});

describe('#546 waitOutRecoveringDaemon', () => {
  it('returns "alive" as soon as a ping answers mid-recovery (→ reuse, no kill)', async () => {
    const clock = makeClock();
    let pings = 0;
    const outcome = await waitOutRecoveringDaemon({
      ping: async () => { pings++; return pings >= 3; },
      readMarker: () => '4242',
      expectedPid: 4242,
      sleep: clock.sleep,
      now: clock.now,
      ceilingMs: 90_000,
    });
    expect(outcome).toBe('alive');
    expect(pings).toBe(3);
    // Two failed pings → two sleeps → 1 s of simulated wait. Nowhere near the
    // ceiling, and critically: no kill.
    expect(clock.now()).toBe(2 * BOOT_WAIT_POLL_MS);
  });

  it('returns "gone" when the marker stops naming our pid', async () => {
    // The daemon unlinks the marker the instant it writes its pipe file, so
    // "gone" means either "just became ready" or "died" — the caller re-pings
    // once to tell those apart.
    const clock = makeClock();
    let reads = 0;
    const outcome = await waitOutRecoveringDaemon({
      ping: async () => false,
      readMarker: () => { reads++; return reads >= 3 ? null : '4242'; },
      expectedPid: 4242,
      sleep: clock.sleep,
      now: clock.now,
      ceilingMs: 90_000,
    });
    expect(outcome).toBe('gone');
  });

  it('returns "gone" when the marker is replaced by a different pid', async () => {
    const clock = makeClock();
    const outcome = await waitOutRecoveringDaemon({
      ping: async () => false,
      readMarker: () => '777',
      expectedPid: 4242,
      sleep: clock.sleep,
      now: clock.now,
      ceilingMs: 90_000,
    });
    expect(outcome).toBe('gone');
  });

  it('returns "ceiling" when the daemon claims to boot forever', async () => {
    // Bounds a genuinely hung boot so the kill path is still reachable — the
    // wait is generous, not unlimited.
    const clock = makeClock();
    const outcome = await waitOutRecoveringDaemon({
      ping: async () => false,
      readMarker: () => '4242',
      expectedPid: 4242,
      sleep: clock.sleep,
      now: clock.now,
      ceilingMs: 5_000,
    });
    expect(outcome).toBe('ceiling');
    expect(clock.now()).toBeGreaterThanOrEqual(5_000);
  });

  it('checks the ping BEFORE the marker each round', async () => {
    // Ordering matters: the daemon deletes its marker immediately after opening
    // the pipe. Reading the marker first would resolve that instant as "gone"
    // and fall through to the kill path for a daemon that just became healthy.
    const clock = makeClock();
    const outcome = await waitOutRecoveringDaemon({
      ping: async () => true,
      readMarker: () => null, // marker already deleted
      expectedPid: 4242,
      sleep: clock.sleep,
      now: clock.now,
      ceilingMs: 90_000,
    });
    expect(outcome).toBe('alive');
  });

  it('fires onWaiting exactly once, however long the wait runs', async () => {
    const clock = makeClock();
    const waits: number[] = [];
    await waitOutRecoveringDaemon({
      ping: async () => false,
      readMarker: () => '4242',
      expectedPid: 4242,
      sleep: clock.sleep,
      now: clock.now,
      ceilingMs: 3_000,
      onWaiting: (elapsed) => { waits.push(elapsed); },
    });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBe(0);
  });

  it('never sleeps when the daemon answers on the first ping', async () => {
    // The zero-added-latency guarantee for the ordinary path. ensureDaemon
    // additionally gates entry on the marker existing at all, so a genuinely
    // wedged daemon (no marker) never even reaches this function.
    const clock = makeClock();
    const sleeps: number[] = [];
    const outcome = await waitOutRecoveringDaemon({
      ping: async () => true,
      readMarker: () => '4242',
      expectedPid: 4242,
      sleep: async (ms) => { sleeps.push(ms); clock.advance(ms); },
      now: clock.now,
      ceilingMs: 90_000,
    });
    expect(outcome).toBe('alive');
    expect(sleeps).toEqual([]);
    expect(clock.now()).toBe(0);
  });
});
