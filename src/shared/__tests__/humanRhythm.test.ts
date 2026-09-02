import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DELAY,
  DEFAULT_MIN_DELAY,
  generateTypingDelays,
  typingDelayFor,
} from '../humanRhythm';

/** mulberry32 — a tiny seeded PRNG so every assertion below is deterministic. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** A long run of context-free draws ('a' owes no punctuation allowance). */
function sample(count: number, seed = 1): number[] {
  const rng = seeded(seed);
  return Array.from({ length: count }, () => typingDelayFor('a', { rng }));
}

describe('humanRhythm typing distribution', () => {
  it('centres the median on the midpoint of the configured band', () => {
    const m = median(sample(20_000));
    const midpoint = (DEFAULT_MIN_DELAY + DEFAULT_MAX_DELAY) / 2;
    // Log-normal: the median is the scale parameter, so it lands on the
    // midpoint up to sampling noise.
    expect(m).toBeGreaterThan(midpoint * 0.9);
    expect(m).toBeLessThan(midpoint * 1.1);
  });

  it('is right-skewed: the mean sits above the median', () => {
    const values = sample(20_000);
    expect(mean(values)).toBeGreaterThan(median(values));
  });

  it('emits a longer thinking pause a few percent of the time', () => {
    const values = sample(20_000);
    const paused = values.filter((v) => v > 300).length / values.length;
    expect(paused).toBeGreaterThan(0.02);
    expect(paused).toBeLessThan(0.07);
  });

  it('stays inside the clamp on every draw', () => {
    for (const value of sample(20_000, 7)) {
      expect(value).toBeGreaterThanOrEqual(DEFAULT_MIN_DELAY * 0.6);
      // The base draw is clamped at 5x max; a pause can add up to 700ms.
      expect(value).toBeLessThanOrEqual(DEFAULT_MAX_DELAY * 5 + 700);
    }
  });

  it('waits longer after sentence punctuation than after a letter', () => {
    // Same seed on both sides, so the only difference is the allowance.
    const letter = mean(Array.from({ length: 4000 }, () => 0).map((_v, i) =>
      typingDelayFor('a', { rng: seeded(100 + i) })));
    const period = mean(Array.from({ length: 4000 }, () => 0).map((_v, i) =>
      typingDelayFor('.', { rng: seeded(100 + i) })));
    const space = mean(Array.from({ length: 4000 }, () => 0).map((_v, i) =>
      typingDelayFor(' ', { rng: seeded(100 + i) })));

    expect(period).toBeGreaterThan(space);
    expect(space).toBeGreaterThan(letter);
    // The allowances are exact, so the gaps are too.
    expect(period - letter).toBeCloseTo(120, 6);
    expect(space - letter).toBeCloseTo(40, 6);
  });

  it('is deterministic for a given seed', () => {
    const a = generateTypingDelays('hello world', { rng: seeded(42) });
    const b = generateTypingDelays('hello world', { rng: seeded(42) });
    expect(a).toEqual(b);
    expect(a).toHaveLength(11);
  });

  it('keeps a 40-character string inside a plausible 3-6s of typing', () => {
    const text = 'the quick brown fox jumps over lazy dog.';
    expect(text).toHaveLength(40);
    // Averaged over many schedules: one schedule can land outside the band on
    // an unlucky run of pauses, the typist's habit is what the band describes.
    const totals = Array.from({ length: 300 }, (_v, i) =>
      generateTypingDelays(text, { rng: seeded(500 + i) }).reduce((s, d) => s + d, 0));
    const average = mean(totals);
    expect(average).toBeGreaterThan(3000);
    expect(average).toBeLessThan(6000);
  });

  it('keeps a very long string inside a total-duration budget', () => {
    const text = 'a. '.repeat(667).slice(0, 2000);
    expect(text).toHaveLength(2000);
    const delays = generateTypingDelays(text, { rng: seeded(3) });
    const total = delays.reduce((s, d) => s + d, 0);
    // 120ms/char plus 1.5s slack — a 2,000-char paste must not sit in a
    // multi-minute loop just because the pauses stacked up.
    // Summing 2,000 scaled floats drifts a fraction of a millisecond past the
    // ceiling; the budget is a duration, not an exact arithmetic identity.
    expect(total).toBeLessThanOrEqual(2000 * 120 + 1500 + 1);
    expect(delays).toHaveLength(2000);
    for (const d of delays) expect(d).toBeGreaterThan(0);
  });

  it('scales a budget-capped schedule without flattening its shape', () => {
    // Forced over budget by a band far above the per-character allowance.
    const text = 'a'.repeat(500);
    const delays = generateTypingDelays(text, {
      minDelay: 400, maxDelay: 800, rng: seeded(4),
    });
    const total = delays.reduce((s, d) => s + d, 0);
    expect(total).toBeLessThanOrEqual(500 * 120 + 1500 + 1);
    // Still right-skewed after scaling: a uniform squeeze preserves the ratios.
    expect(mean(delays)).toBeGreaterThan(median(delays));
  });

  it('leaves a schedule that fits its budget untouched', () => {
    const text = 'hello there';
    // Same seed, so an unscaled schedule equals the raw per-character draws.
    const scheduled = generateTypingDelays(text, { rng: seeded(77) });
    const rng = seeded(77);
    const raw = Array.from({ length: text.length }, (_v, i) => typingDelayFor(text[i], { rng }));
    expect(scheduled).toEqual(raw);
  });

  it('honours a custom band', () => {
    const values = Array.from({ length: 5000 }, () => 0).map((_v, i) =>
      typingDelayFor('a', { minDelay: 200, maxDelay: 400, rng: seeded(900 + i) }));
    expect(median(values)).toBeGreaterThan(270);
    expect(median(values)).toBeLessThan(330);
  });
});
