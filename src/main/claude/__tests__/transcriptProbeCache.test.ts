import { describe, expect, it, vi } from 'vitest';
import {
  createTranscriptProbeCache,
  type ProbeOutcome,
} from '../transcriptProbeCache';

/**
 * The cache guards one invariant: a transcript-existence answer is at most TTL
 * old, and an unreachable guest is never evidence of absence.
 *
 * Every behaviour here was unreachable before the extraction — the TTL, the
 * single-flight flag, the FIFO cap and the error-retention rule all lived in
 * `lastAssistantMessage.ts` behind a production-vs-test runner identity compare,
 * so no test could drive the out-of-band refresh at all.
 */

const answered = (lives: boolean): ProbeOutcome => ({ status: 'answered', lives });
const unreachable: ProbeOutcome = { status: 'unreachable' };

/** A clock the test advances by hand — no fake timers, so an injected clock can
 *  never be shadowed by a global `Date` mock. */
function testClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** A probe whose settlement the test controls, so post-refresh assertions never
 *  race an unknown number of microtask ticks. */
function deferredProbe() {
  let settle!: (outcome: ProbeOutcome) => void;
  const calls = vi.fn(() => new Promise<ProbeOutcome>((resolve) => { settle = resolve; }));
  return { calls, settle: (outcome: ProbeOutcome) => settle(outcome) };
}

const TTL = 30_000;
const never = () => Promise.resolve<ProbeOutcome>(unreachable);

/** Drain enough microtasks that an already-resolved promise would have won —
 *  lets a test assert that something is genuinely still pending. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function makeCache(now: () => number, max = 256) {
  return createTranscriptProbeCache({ now, ttlMs: TTL, max });
}

describe('transcript probe cache', () => {
  describe('the one error-retention rule', () => {
    it.each([
      { name: 'a live answer', outcome: answered(true), returned: true, cached: true },
      { name: 'a dead answer', outcome: answered(false), returned: false, cached: true },
      // The whole point of the issue: "could not probe" is never recorded as
      // "does not exist", and an unproven transcript is assumed alive so the
      // exact `--resume <id>` survives a distro that cannot answer yet.
      { name: 'an unreachable guest', outcome: unreachable, returned: true, cached: false },
    ])('$name: returns $returned, records an answer: $cached', ({ outcome, returned, cached }) => {
      const clock = testClock();
      const cache = makeCache(clock.now);
      const probe = vi.fn(() => outcome);

      expect(cache.lives('k', probe, never)).toBe(returned);
      // A second poll within the TTL is served from the recorded answer; with no
      // answer recorded there is nothing to serve, but it must still not block.
      clock.advance(TTL - 1);
      expect(cache.lives('k', probe, never)).toBe(returned);
      expect(probe).toHaveBeenCalledTimes(1);
      // Still stamped at the probe's own moment: a cache hit serves the answer
      // without restamping it, so the TTL keeps ageing from the real probe.
      expect(cache.answerFor('k')).toEqual(cached ? { lives: returned, at: 1_000 } : null);
    });
  });

  it('throttles retries for a key that has never been answered for', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const probe = vi.fn(() => unreachable);
    const refresh = deferredProbe();

    // Ten daemon polls against a distro that cannot answer. Before the cache
    // recorded the *attempt* this was ten blocking 750 ms wsl.exe spawns — the
    // stall #26 existed to remove.
    for (let i = 0; i < 10; i += 1) expect(cache.lives('k', probe, refresh.calls)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    // An entry with no answer has no answer timestamp to age, so the retry gate
    // is the attempt. Without it every poll would re-spawn wsl.exe and keep an
    // idle distro awake indefinitely.
    expect(refresh.calls).not.toHaveBeenCalled();

    clock.advance(TTL);
    expect(cache.lives('k', probe, refresh.calls)).toBe(true);
    expect(refresh.calls).toHaveBeenCalledTimes(1);
    // Single-flight holds on the unanswered path too: crossing the TTL again
    // while the first attempt is still pending starts nothing new.
    clock.advance(TTL);
    expect(cache.lives('k', probe, refresh.calls)).toBe(true);
    expect(refresh.calls).toHaveBeenCalledTimes(1);

    refresh.settle(unreachable);
    await cache.whenIdle();
    clock.advance(TTL);
    expect(cache.lives('k', probe, refresh.calls)).toBe(true);
    expect(refresh.calls).toHaveBeenCalledTimes(2);
    // Still never answered, so still never recorded as absent.
    expect(cache.answerFor('k')).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('serves the cached answer until the TTL expires, then refreshes exactly once', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const refresh = deferredProbe();
    const probe = vi.fn(() => answered(true));

    expect(cache.lives('k', probe, refresh.calls)).toBe(true);
    clock.advance(TTL - 1);
    expect(cache.lives('k', probe, refresh.calls)).toBe(true);
    expect(refresh.calls).not.toHaveBeenCalled();

    clock.advance(1);
    // The stale answer is returned while the refresh is still pending, and the
    // blocking probe is NOT re-entered — together that is the non-blocking
    // property. A spy on the sync probe is what makes the second half real; its
    // return value coincides with the cached one, so the boolean cannot show it.
    expect(cache.lives('k', probe, refresh.calls)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(refresh.calls).toHaveBeenCalledTimes(1);

    refresh.settle(answered(false));
    await cache.whenIdle();
    expect(cache.lives('k', probe, refresh.calls)).toBe(false);
    // The refresh restamped the answer, so the next TTL window is quiet again.
    clock.advance(TTL - 1);
    expect(cache.lives('k', probe, refresh.calls)).toBe(false);
    expect(refresh.calls).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps at most one in-flight refresh per key', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const refresh = deferredProbe();

    cache.lives('k', () => answered(true), refresh.calls);
    clock.advance(TTL);
    for (let i = 0; i < 5; i += 1) cache.lives('k', () => answered(true), refresh.calls);
    expect(refresh.calls).toHaveBeenCalledTimes(1);

    refresh.settle(answered(true));
    await cache.whenIdle();
    // The flag clears, so a later TTL crossing refreshes again.
    clock.advance(TTL);
    cache.lives('k', () => answered(true), refresh.calls);
    expect(refresh.calls).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known answer when a refresh cannot reach the guest', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const refresh = deferredProbe();

    expect(cache.lives('k', () => answered(true), refresh.calls)).toBe(true);
    clock.advance(TTL);
    cache.lives('k', () => answered(true), refresh.calls);
    refresh.settle(unreachable);
    await cache.whenIdle();

    // Not false: a timeout is not evidence the transcript is gone.
    expect(cache.answerFor('k')).toEqual({ lives: true, at: 1_000 });
    // The answer is not poisoned, and the retry comes one TTL after the failed
    // attempt — not one TTL after the stale answer, which would compound.
    clock.advance(TTL);
    cache.lives('k', () => answered(true), refresh.calls);
    expect(refresh.calls).toHaveBeenCalledTimes(2);
  });

  it('rejects a refresh failure the same way as an unreachable outcome', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const refresh = vi.fn(() => Promise.reject(new Error('spawn failed')));

    expect(cache.lives('k', () => answered(true), refresh)).toBe(true);
    clock.advance(TTL);
    expect(cache.lives('k', () => answered(true), refresh)).toBe(true);
    await cache.whenIdle();
    expect(cache.answerFor('k')).toEqual({ lives: true, at: 1_000 });
  });

  it('lets a later refresh answer a key that was never answered for', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const refresh = deferredProbe();
    const probe = vi.fn(() => unreachable);

    // The issue's failure scenario: a cold-booting distro cannot answer, so the
    // exact `--resume <id>` is kept alive on trust.
    expect(cache.lives('k', probe, refresh.calls)).toBe(true);
    expect(cache.answerFor('k')).toBeNull();

    clock.advance(TTL);
    expect(cache.lives('k', probe, refresh.calls)).toBe(true);

    // Once the distro is warm the refresh learns the truth. Assume-alive is a
    // recovery, not a latch: an unproven key that a refresh proves dead must
    // start reporting dead, or the earlier unreachable attempt has quietly
    // become a permanent answer.
    refresh.settle(answered(false));
    await cache.whenIdle();
    expect(cache.answerFor('k')).toEqual({ lives: false, at: 1_000 + TTL });
    expect(cache.lives('k', probe, refresh.calls)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry at the cache cap, FIFO not LRU', () => {
    const clock = testClock();
    const cache = makeCache(clock.now, 3);
    const probe = vi.fn(() => answered(true));

    for (const key of ['a', 'b', 'c']) cache.lives(key, probe, never);
    // A cache hit must not renew insertion order — this is FIFO, not LRU.
    cache.lives('a', probe, never);
    expect(probe).toHaveBeenCalledTimes(3);

    cache.lives('d', probe, never);
    expect(probe).toHaveBeenCalledTimes(4);
    // 'a' was the oldest insertion, so it lost its entry and probes again.
    cache.lives('a', probe, never);
    expect(probe).toHaveBeenCalledTimes(5);
    // 'b' and 'c' are still cached.
    cache.lives('c', probe, never);
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it('discards a refresh whose key was evicted and re-probed while it ran', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now, 1);
    const refresh = deferredProbe();

    expect(cache.lives('a', () => answered(true), refresh.calls)).toBe(true);
    clock.advance(TTL);
    cache.lives('a', () => answered(true), refresh.calls);
    expect(refresh.calls).toHaveBeenCalledTimes(1);

    // At the cap, so 'b' evicts 'a' while 'a' is still being refreshed.
    cache.lives('b', () => answered(true), never);
    // 'a' is gone, so the next sighting probes it for real again.
    cache.lives('a', () => answered(true), never);

    refresh.settle(answered(false));
    await cache.whenIdle();

    // The orphan belongs to the evicted entry. Letting it write would overwrite
    // a newer answer in the live-to-absent direction and backdate it to the
    // orphan's own attempt — both halves of the invariant, broken at once.
    expect(cache.answerFor('a')).toEqual({ lives: true, at: 1_000 + TTL });
    expect(cache.lives('a', () => answered(true), never)).toBe(true);
  });

  it('discards a refresh that resolves after a reset, even onto a re-probed key', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const refresh = deferredProbe();

    cache.lives('k', () => answered(false), refresh.calls);
    clock.advance(TTL);
    cache.lives('k', () => answered(false), refresh.calls);
    expect(refresh.calls).toHaveBeenCalledTimes(1);

    cache.reset();
    // Reset drops the entry but not the spawn, so the refresh stays tracked and
    // awaitable. Asserted as a race: if the drain were empty it would resolve
    // here, and every later assertion would pass without waiting for anything.
    const drained = cache.whenIdle();
    let drainedEarly = false;
    void drained.then(() => { drainedEarly = true; });
    await flushMicrotasks();
    expect(drainedEarly).toBe(false);

    // Re-probe the same key BEFORE the pre-reset refresh settles. Clearing the
    // map alone does not protect this: `record` finds a live entry and would
    // overwrite the fresh answer with the discarded generation's.
    const probe = vi.fn(() => answered(true));
    expect(cache.lives('k', probe, never)).toBe(true);

    refresh.settle(answered(false));
    await drained;

    expect(cache.answerFor('k')).toEqual({ lives: true, at: 1_000 + TTL });
    expect(cache.lives('k', probe, never)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
