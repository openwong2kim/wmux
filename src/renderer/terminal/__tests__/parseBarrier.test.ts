import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitParseBarrier, PARSE_BARRIER_TIMEOUT_MS, type BarrierWritable } from '../parseBarrier';

/** A terminal whose write buffer drains normally — the callback fires. */
const healthy = (): BarrierWritable => ({
  write: (_data, cb) => { cb?.(); },
});

/** A terminal whose write buffer is WEDGED: xterm accepted the write and
 *  queued the callback, but the drain loop died earlier and never advances,
 *  so the callback is stranded forever. This is the real failure mode — a
 *  handler that threw inside WriteBuffer._innerWrite. */
const wedged = (): BarrierWritable => ({
  write: () => { /* callback intentionally never invoked */ },
});

describe('awaitParseBarrier', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('resolves true as soon as xterm reports the pane parsed', async () => {
    await expect(awaitParseBarrier(healthy())).resolves.toBe(true);
  });

  it('resolves false instead of hanging when the write buffer is wedged', async () => {
    vi.useFakeTimers();
    const settled = awaitParseBarrier(wedged(), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(settled).resolves.toBe(false);
  });

  it('bounds the wait inside the 5s RPC deadline that reads run under', () => {
    expect(PARSE_BARRIER_TIMEOUT_MS).toBeLessThan(5_000);
  });

  // The budget is squeezed from both sides, and the lower bound is the one that
  // is easy to lose: a dirty pane replaying the whole daemon ring (≤8MB, parsed
  // at ~5–35MB/s) needs ~2s, and a barrier that expires first hands the reader a
  // half-applied replay while reporting success. Reads that quietly go stale are
  // harder to notice than reads that fail, so pin the floor.
  it('leaves room for a healthy full-ring replay to finish parsing (~2s)', () => {
    expect(PARSE_BARRIER_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
  });

  it('lets a slow-but-healthy parse settle instead of timing it out', async () => {
    vi.useFakeTimers();
    // Parses for 2s — the full-ring worst case — then calls back.
    const slowButHealthy: BarrierWritable = {
      write: (_d, cb) => { setTimeout(() => cb?.(), 2_000); },
    };
    const settled = awaitParseBarrier(slowButHealthy);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(settled).resolves.toBe(true);
  });

  it('treats a synchronous write throw (disposed terminal) as settled, not a hang', async () => {
    const disposed: BarrierWritable = {
      write: () => { throw new Error('Terminal disposed'); },
    };
    await expect(awaitParseBarrier(disposed)).resolves.toBe(false);
  });

  it('ignores a late callback that arrives after the timeout already fired', async () => {
    vi.useFakeTimers();
    let late: (() => void) | undefined;
    const slow: BarrierWritable = { write: (_d, cb) => { late = cb; } };
    const settled = awaitParseBarrier(slow, 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(settled).resolves.toBe(false);
    // The stranded callback eventually running must not throw or re-resolve.
    expect(() => late?.()).not.toThrow();
  });
});
