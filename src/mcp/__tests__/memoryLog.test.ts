import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_WARN_BYTES, MEMORY_LOG_INTERVAL_MS, startMemoryLog } from '../memoryLog';

const MB = 1024 * 1024;
const usage = (external: number): NodeJS.MemoryUsage => ({
  rss: 400 * MB,
  heapTotal: 100 * MB,
  heapUsed: 80 * MB,
  external,
  arrayBuffers: external / 2,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startMemoryLog', () => {
  it('logs one line per interval, and warns once per crossing of the external mark', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const samples = [10 * MB, EXTERNAL_WARN_BYTES + MB, EXTERNAL_WARN_BYTES + 2 * MB, 10 * MB, EXTERNAL_WARN_BYTES + MB];
    let i = 0;
    const stop = startMemoryLog('[t]', () => usage(samples[i++]));

    await vi.advanceTimersByTimeAsync(MEMORY_LOG_INTERVAL_MS - 1);
    expect(err).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(err).toHaveBeenLastCalledWith('[t] memory rss=400MB heapUsed=80MB external=10MB arrayBuffers=5MB');

    await vi.advanceTimersByTimeAsync(MEMORY_LOG_INTERVAL_MS * 4);
    stop();
    const warnings = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('warning'));
    // Over at samples 2 and 3 (one warning), back under, over again (a second).
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('external memory is over 300MB');
    expect(err).toHaveBeenCalledTimes(5 + 2);
  });
});
