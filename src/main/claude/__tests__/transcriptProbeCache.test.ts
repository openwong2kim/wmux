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
      expect(cache.lives('k', probe, never)).toBe(returned);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(cache.answerFor('k')).toEqual(cached ? { lives: returned, at: 1_000 } : null);
    });
  });

  it('never re-enters the blocking probe once a key is known, even unanswered', () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const probe = vi.fn(() => unreachable);
    // Ten daemon polls against a distro that cannot answer. Before the cache
    // recorded the *attempt* this was ten blocking 750 ms wsl.exe spawns — the
    // stall #26 existed to remove.
    for (let i = 0; i < 10; i += 1) expect(cache.lives('k', probe, never)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('serves the cached answer until the TTL expires, then refreshes exactly once', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const refresh = deferredProbe();

    expect(cache.lives('k', () => answered(true), refresh.calls)).toBe(true);
    clock.advance(TTL - 1);
    expect(cache.lives('k', () => answered(true), refresh.calls)).toBe(true);
    expect(refresh.calls).not.toHaveBeenCalled();

    clock.advance(1);
    // The stale answer is returned synchronously while the refresh is still
    // pending — that is the non-blocking property, asserted directly.
    expect(cache.lives('k', () => answered(true), refresh.calls)).toBe(true);
    expect(refresh.calls).toHaveBeenCalledTimes(1);

    refresh.settle(answered(false));
    await cache.whenIdle('k');
    expect(cache.lives('k', () => answered(true), refresh.calls)).toBe(false);
    // The refresh restamped the answer, so the next TTL window is quiet again.
    clock.advance(TTL - 1);
    expect(cache.lives('k', () => answered(true), refresh.calls)).toBe(false);
    expect(refresh.calls).toHaveBeenCalledTimes(1);
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
    await cache.whenIdle('k');
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
    await cache.whenIdle('k');

    // Not false: a timeout is not evidence the transcript is gone.
    expect(cache.answerFor('k')).toEqual({ lives: true, at: 1_000 });
    // The failed attempt is throttled, but the answer is not poisoned and the
    // next window retries rather than waiting out a second full TTL.
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
    await cache.whenIdle('k');
    expect(cache.answerFor('k')).toEqual({ lives: true, at: 1_000 });
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

  it('drops in-flight refreshes on reset so one test cannot write into the next', async () => {
    const clock = testClock();
    const cache = makeCache(clock.now);
    const refresh = deferredProbe();

    cache.lives('k', () => answered(true), refresh.calls);
    clock.advance(TTL);
    cache.lives('k', () => answered(true), refresh.calls);
    cache.reset();
    refresh.settle(answered(false));
    await cache.whenIdle();

    // The late answer belongs to a discarded generation; the fresh cache probes
    // for itself rather than inheriting it.
    const probe = vi.fn(() => answered(true));
    expect(cache.lives('k', probe, never)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
