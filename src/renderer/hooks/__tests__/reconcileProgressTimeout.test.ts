import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithProgressTimeout } from '../reconcileProgressTimeout';

describe('runWithProgressTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a multi-step reconcile to exceed one timeout window while each step makes progress', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const run = runWithProgressTimeout(
      async (reportProgress) => {
        for (let step = 0; step < 3; step++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 900));
          reportProgress();
        }
        return 'reconciled';
      },
      { timeoutMs: 1_000, label: 'startup reconcile', onTimeout },
    );

    await vi.advanceTimersByTimeAsync(2_700);

    await expect(run).resolves.toBe('reconciled');
    expect(onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a fresh timeout window after progress and still rejects a later stalled step', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const run = runWithProgressTimeout(
      async (reportProgress) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        reportProgress();
        await new Promise<never>(() => { /* next stage stalled */ });
      },
      { timeoutMs: 1_000, label: 'startup reconcile', onTimeout },
    );
    const rejected = expect(run).rejects.toThrow(
      'startup reconcile made no progress for 1000ms',
    );

    await vi.advanceTimersByTimeAsync(1_899);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('rejects and invokes the timeout hook when one step stops making progress', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const run = runWithProgressTimeout(
      async () => new Promise<never>(() => { /* stalled */ }),
      { timeoutMs: 1_000, label: 'startup reconcile', onTimeout },
    );
    const rejected = expect(run).rejects.toThrow(
      'startup reconcile made no progress for 1000ms',
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('clears the watchdog when the work rejects on its own', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const failure = new Error('pty.list failed');

    const run = runWithProgressTimeout(
      async () => { throw failure; },
      { timeoutMs: 1_000, label: 'startup reconcile', onTimeout },
    );

    await expect(run).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
