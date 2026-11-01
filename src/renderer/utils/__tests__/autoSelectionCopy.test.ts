import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startCopy } from '../cleanCopyResolve';
import { createAutoSelectionCopy } from '../autoSelectionCopy';

describe('createAutoSelectionCopy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the latest selection after the debounce window', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 100 });

    handle.onSelection('hello');

    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('coalesces rapid selection changes into a single write', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 100 });

    // Simulate the per-cell storm during a drag.
    handle.onSelection('h');
    vi.advanceTimersByTime(20);
    handle.onSelection('he');
    vi.advanceTimersByTime(20);
    handle.onSelection('hel');
    vi.advanceTimersByTime(20);
    handle.onSelection('hell');
    vi.advanceTimersByTime(20);
    handle.onSelection('hello');

    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('ignores empty selections (clearing should not clobber clipboard)', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 50 });

    handle.onSelection('');
    vi.advanceTimersByTime(50);

    expect(write).not.toHaveBeenCalled();
  });

  it('replaces a pending non-empty write when the selection clears mid-debounce', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 100 });

    handle.onSelection('hello');
    vi.advanceTimersByTime(50);
    // User clicks elsewhere before debounce fires — selection clears.
    handle.onSelection('');
    vi.advanceTimersByTime(100);

    // The previous write was canceled and the empty selection bailed.
    expect(write).not.toHaveBeenCalled();
  });

  it('swallows write errors silently (explicit copy path handles toasts)', async () => {
    const write = vi.fn().mockRejectedValue(new Error('CLIPBOARD_WRITE_FAILED'));
    const handle = createAutoSelectionCopy({ write, debounceMs: 50 });

    handle.onSelection('hello');
    vi.advanceTimersByTime(50);

    // Pump microtasks so the .catch() runs without an unhandled rejection.
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(1);
    // No throw observed — failure is silent.
  });

  it('dispose() cancels pending writes', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 100 });

    handle.onSelection('hello');
    vi.advanceTimersByTime(50);
    handle.dispose();
    vi.advanceTimersByTime(100);

    expect(write).not.toHaveBeenCalled();
  });

  it('dispose() is safe to call multiple times', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write });

    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  });

  it('uses the default 150ms debounce when none specified', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write });

    handle.onSelection('x');
    vi.advanceTimersByTime(149);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a selection that arrives after dispose() is honored (handle is reusable)', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 50 });

    handle.dispose();
    handle.onSelection('reborn');
    vi.advanceTimersByTime(50);

    expect(write).toHaveBeenCalledWith('reborn');
  });

  it('writes the resolved text after the debounce', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn(async (s: string) => `clean:${s}`);
    const handle = createAutoSelectionCopy({ write, resolve, debounceMs: 50 });

    handle.onSelection('raw');
    expect(resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);

    expect(resolve).toHaveBeenCalledWith('raw');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('clean:raw');
  });

  it('an older resolution that finishes after a newer one never writes', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const finishers: Record<string, (text: string) => void> = {};
    const resolve = (s: string) => new Promise<string>((r) => { finishers[s] = r; });
    const handle = createAutoSelectionCopy({ write, resolve, debounceMs: 50 });

    handle.onSelection('first');
    await vi.advanceTimersByTimeAsync(50);
    handle.onSelection('second');
    await vi.advanceTimersByTimeAsync(50);
    finishers.second('second clean');
    await vi.advanceTimersByTimeAsync(0);
    finishers.first('first clean');
    await vi.advanceTimersByTimeAsync(0);

    expect(write.mock.calls).toEqual([['second clean']]);
  });

  it('a copy started anywhere else meanwhile (an explicit copy) stops it from writing', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    let finish!: (text: string) => void;
    const resolve = () => new Promise<string>((r) => { finish = r; });
    const handle = createAutoSelectionCopy({ write, resolve, debounceMs: 50 });

    handle.onSelection('sel');
    await vi.advanceTimersByTimeAsync(50);
    startCopy(); // e.g. Cmd+C in this pane or another
    finish('sel clean');
    await vi.advanceTimersByTimeAsync(0);

    expect(write).not.toHaveBeenCalled();
  });

  it('skips its write when a copy started during its debounce (Cmd+C on the selection)', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn(async (s: string) => `clean:${s}`);
    const handle = createAutoSelectionCopy({ write, resolve, debounceMs: 50 });

    handle.onSelection('sel');
    await vi.advanceTimersByTimeAsync(20);
    startCopy(); // the explicit copy of the same selection
    await vi.advanceTimersByTimeAsync(50);

    expect(resolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('dispose() stops a resolution still running from writing', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    let finish!: (text: string) => void;
    const resolve = () => new Promise<string>((r) => { finish = r; });
    const handle = createAutoSelectionCopy({ write, resolve, debounceMs: 50 });

    handle.onSelection('sel');
    await vi.advanceTimersByTimeAsync(50);
    handle.dispose(); // e.g. a right-click copy takes over
    finish('sel clean');
    await vi.advanceTimersByTimeAsync(0);

    expect(write).not.toHaveBeenCalled();
  });
});
