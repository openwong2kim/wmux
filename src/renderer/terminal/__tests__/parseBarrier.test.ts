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

  it('bounds the wait well inside the 5s RPC deadline that reads run under', () => {
    expect(PARSE_BARRIER_TIMEOUT_MS).toBeLessThan(5_000);
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
