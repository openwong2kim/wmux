import { describe, it, expect, vi, afterEach } from 'vitest';
import { startSseHeartbeat, SSE_HEARTBEAT_MS } from '../sseHeartbeat';

afterEach(() => {
  vi.useRealTimers();
});

/** A response stub that records what was written, or throws on demand. */
function fakeRes(onWrite?: () => void) {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string) {
      onWrite?.();
      writes.push(chunk);
      return true;
    },
  };
}

describe('startSseHeartbeat', () => {
  it('writes an SSE comment frame on every interval', () => {
    vi.useFakeTimers();
    const res = fakeRes();
    startSseHeartbeat(res, 1000);

    expect(res.writes).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(res.writes).toEqual([': ping\n\n']);
    vi.advanceTimersByTime(2000);
    expect(res.writes).toHaveLength(3);
    // A comment frame carries no event name, so EventSource ignores it.
    for (const w of res.writes) expect(w.startsWith(':')).toBe(true);
  });

  it('defaults to the 25s cadence', () => {
    vi.useFakeTimers();
    const res = fakeRes();
    startSseHeartbeat(res);

    expect(SSE_HEARTBEAT_MS).toBe(25_000);
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS - 1);
    expect(res.writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(res.writes).toHaveLength(1);
  });

  it('stops writing once stopped', () => {
    vi.useFakeTimers();
    const res = fakeRes();
    const stop = startSseHeartbeat(res, 1000);

    vi.advanceTimersByTime(1000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(res.writes).toHaveLength(1);
  });

  it('is safe to stop more than once', () => {
    vi.useFakeTimers();
    const res = fakeRes();
    const stop = startSseHeartbeat(res, 1000);

    stop();
    expect(() => stop()).not.toThrow();
    vi.advanceTimersByTime(5000);
    expect(res.writes).toHaveLength(0);
  });

  it('swallows a write failure instead of throwing out of the timer', () => {
    vi.useFakeTimers();
    const res = fakeRes(() => {
      throw new Error('EPIPE');
    });
    startSseHeartbeat(res, 1000);

    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    expect(res.writes).toHaveLength(0);
  });

  it('unrefs the timer so it never holds the daemon open', () => {
    // A referenced 25 s interval would keep the daemon's event loop alive for
    // as long as any browser tab is open, so this is a shutdown guarantee, not
    // a style point — assert on the call rather than on an observable effect.
    const unref = vi.fn();
    const handle = { unref } as unknown as ReturnType<typeof setInterval>;
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    try {
      const stop = startSseHeartbeat(fakeRes(), 1000);
      expect(unref).toHaveBeenCalledTimes(1);
      stop();
      expect(clearSpy).toHaveBeenCalledWith(handle);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
