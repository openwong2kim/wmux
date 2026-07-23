import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FrameCoalescer } from '../frameCoalescer';

// node has no requestAnimationFrame; coalescer schedules frames via setTimeout(16ms)
// fallback. Fake timers give deterministic frame boundaries.
describe('FrameCoalescer — one merge per frame (last value wins)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces N consecutive pushes for same key into one commit per frame', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    for (let i = 1; i <= 10; i++) fc.push('pty-1', i);
    // Frame not elapsed yet — zero commits.
    expect(commit).toHaveBeenCalledTimes(0);
    expect(fc.pendingSize).toBe(1);

    vi.advanceTimersByTime(16);
    // One frame → one commit; only last value (10) applied.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('pty-1', 10);
  });

  it('commits each distinct key once in the same frame', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    fc.push('a', 1);
    fc.push('b', 2);
    fc.push('a', 3); // a updated — last value 3 wins
    vi.advanceTimersByTime(16);

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith('a', 3);
    expect(commit).toHaveBeenCalledWith('b', 2);
  });

  it('push in next frame creates a new commit (no cross-frame merge)', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    fc.push('x', 1);
    vi.advanceTimersByTime(16);
    fc.push('x', 2);
    vi.advanceTimersByTime(16);

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenNthCalledWith(1, 'x', 1);
    expect(commit).toHaveBeenNthCalledWith(2, 'x', 2);
  });

  it('values pushed during flush(commit) are reflected next frame without loss', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);
    // Re-push during first commit to exercise in-flight gate.
    commit.mockImplementationOnce(() => {
      fc.push('re', 99);
    });

    fc.push('re', 1);
    vi.advanceTimersByTime(16); // 1 commit → 99 re-queued internally
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenNthCalledWith(1, 're', 1);

    vi.advanceTimersByTime(16); // Next frame applies 99
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenNthCalledWith(2, 're', 99);
  });

  it('flushNow() cancels scheduled frame and applies pending synchronously', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    fc.push('k', 7);
    fc.flushNow();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('k', 7);

    // Advancing timers must not duplicate commit (frame was cancelled).
    vi.advanceTimersByTime(32);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('dispose() discards pending without applying', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    fc.push('k', 1);
    fc.dispose();
    vi.advanceTimersByTime(32);
    expect(commit).toHaveBeenCalledTimes(0);
    expect(fc.pendingSize).toBe(0);
  });
});
