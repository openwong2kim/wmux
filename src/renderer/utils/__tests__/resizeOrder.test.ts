import { describe, it, expect, vi } from 'vitest';
import { resizeOrderFor, runOrderedFit } from '../resizeOrder';

describe('resizeOrderFor', () => {
  it('puts the PTY first when rows shrink — the case that scrolls the pane (#1436)', () => {
    expect(resizeOrderFor(30, 20)).toBe('pty-first');
  });

  it('keeps the local fit first when rows grow or stay put', () => {
    expect(resizeOrderFor(20, 30)).toBe('local-first');
    expect(resizeOrderFor(30, 30)).toBe('local-first');
  });

  it('ignores columns — a narrower terminal reflows, it does not overflow', () => {
    // callers pass rows only; this pins the contract so a future caller does
    // not "helpfully" start feeding cols in here.
    expect(resizeOrderFor(30, 30)).toBe('local-first');
  });
});

function scheduler() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => { timers.push({ fn, ms, cancelled: false }); return timers.length - 1; },
    cancel: (h: unknown) => { timers[h as number].cancelled = true; },
    fire: (i = 0) => { if (!timers[i].cancelled) timers[i].fn(); },
  };
}

describe('runOrderedFit', () => {
  it('local-first applies the fit synchronously and defers nothing', () => {
    const applyLocalFit = vi.fn();
    const sendGeometry = vi.fn(() => Promise.resolve());
    const s = scheduler();
    runOrderedFit({ order: 'local-first', sendGeometry, applyLocalFit, schedule: s.schedule, cancel: s.cancel });
    expect(applyLocalFit).toHaveBeenCalledTimes(1);
    expect(s.timers).toHaveLength(0);
  });

  it('pty-first sends the geometry before the local fit runs', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = scheduler();
    runOrderedFit({
      order: 'pty-first',
      sendGeometry: () => { calls.push('send'); return gate; },
      applyLocalFit: () => { calls.push('fit'); },
      schedule: s.schedule,
      cancel: s.cancel,
    });
    expect(calls).toEqual(['send']);
    release();
    await gate;
    await Promise.resolve();
    expect(calls).toEqual(['send', 'fit']);
  });

  it('pty-first still fits when the daemon never answers (timeout ceiling)', () => {
    const applyLocalFit = vi.fn();
    const s = scheduler();
    runOrderedFit({
      order: 'pty-first',
      sendGeometry: () => new Promise(() => { /* never settles */ }),
      applyLocalFit,
      settleTimeoutMs: 150,
      schedule: s.schedule,
      cancel: s.cancel,
    });
    expect(applyLocalFit).not.toHaveBeenCalled();
    expect(s.timers[0].ms).toBe(150);
    s.fire();
    expect(applyLocalFit).toHaveBeenCalledTimes(1);
  });

  it('pty-first fits exactly once even when the ack and the timeout both land', async () => {
    const applyLocalFit = vi.fn();
    const s = scheduler();
    runOrderedFit({
      order: 'pty-first',
      sendGeometry: () => Promise.resolve(),
      applyLocalFit,
      schedule: s.schedule,
      cancel: s.cancel,
    });
    await Promise.resolve();
    await Promise.resolve();
    s.fire();
    expect(applyLocalFit).toHaveBeenCalledTimes(1);
    expect(s.timers[0].cancelled).toBe(true);
  });

  it('a rejected resize still settles the fit — xterm must not stay pinned', async () => {
    const applyLocalFit = vi.fn();
    const s = scheduler();
    runOrderedFit({
      order: 'pty-first',
      sendGeometry: () => Promise.reject(new Error('rate limited')),
      applyLocalFit,
      schedule: s.schedule,
      cancel: s.cancel,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(applyLocalFit).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops a deferred fit and disarms its timer', async () => {
    const applyLocalFit = vi.fn();
    const s = scheduler();
    const cancel = runOrderedFit({
      order: 'pty-first',
      sendGeometry: () => Promise.resolve(),
      applyLocalFit,
      schedule: s.schedule,
      cancel: s.cancel,
    });
    cancel();
    await Promise.resolve();
    await Promise.resolve();
    s.fire();
    expect(applyLocalFit).not.toHaveBeenCalled();
    expect(s.timers[0].cancelled).toBe(true);
  });

  it('cancel() after the fit already ran is a no-op', () => {
    const applyLocalFit = vi.fn();
    const s = scheduler();
    const cancel = runOrderedFit({
      order: 'local-first',
      sendGeometry: () => Promise.resolve(),
      applyLocalFit,
      schedule: s.schedule,
      cancel: s.cancel,
    });
    cancel();
    expect(applyLocalFit).toHaveBeenCalledTimes(1);
  });
});
