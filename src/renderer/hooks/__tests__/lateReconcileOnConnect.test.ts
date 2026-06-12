import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLateReconcileOnConnect, type LateReconcileDeps } from '../lateReconcileOnConnect';

// S-A Step 1 — the renderer now loads in parallel with the daemon bootstrap,
// so the INITIAL daemon:connected can arrive while the startup reconcile is
// still pending. These tests pin the gate (pending → skip, ready → run) and
// the RCA A1/A3 guards (supersede, timeout-abort, swallow-and-preserve)
// that were previously inline in AppLayout and untestable.

describe('createLateReconcileOnConnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(overrides: Partial<LateReconcileDeps> = {}) {
    const reconcile = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => {
      /* resolves immediately */
    });
    const log = vi.fn();
    const late = createLateReconcileOnConnect({
      getPaneGate: () => 'ready',
      reconcile,
      timeoutMs: 1_000,
      log,
      ...overrides,
    });
    return { late, reconcile, log };
  }

  it('skips entirely while paneGate is pending (startup path owns the first reconcile)', () => {
    const { late, reconcile, log } = make({ getPaneGate: () => 'pending' });

    late.onConnected();

    expect(reconcile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'log',
      '[lifecycle] daemon connected during startup — skipping late reconcile (startup path owns it)',
    );
  });

  it('runs the reconcile once the gate is ready', () => {
    const { late, reconcile } = make();

    late.onConnected();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it('re-reads the gate per event — pending connect then ready connect', () => {
    let gate: 'pending' | 'ready' = 'pending';
    const { late, reconcile } = make({ getPaneGate: () => gate });

    late.onConnected();
    expect(reconcile).not.toHaveBeenCalled();

    gate = 'ready';
    late.onConnected();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('a newer connect aborts the still-running previous reconcile', () => {
    const signals: AbortSignal[] = [];
    const { late } = make({
      reconcile: vi.fn(async (signal: AbortSignal) => {
        signals.push(signal);
        await new Promise<void>(() => {
          /* never settles */
        });
      }),
    });

    late.onConnected();
    late.onConnected();

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('aborts via timeout when the reconcile exceeds the budget', async () => {
    const signals: AbortSignal[] = [];
    const { late } = make({
      reconcile: vi.fn(async (signal: AbortSignal) => {
        signals.push(signal);
        await new Promise<void>(() => {
          /* never settles */
        });
      }),
    });

    late.onConnected();
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(signals[0].aborted).toBe(true);
  });

  it('swallows a reconcile rejection (preserve ptyIds, no unhandled rejection)', async () => {
    const { late, log } = make({
      reconcile: vi.fn(async () => {
        throw new Error('pty.list RPC failed');
      }),
    });

    late.onConnected();
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toHaveBeenCalledWith(
      'warn',
      '[lifecycle] late reconcile failed — preserving ptyIds (no clear):',
      expect.any(Error),
    );
  });

  it('clears the timeout once the reconcile settles (no stray late abort)', async () => {
    let resolveReconcile!: () => void;
    const signals: AbortSignal[] = [];
    const { late } = make({
      reconcile: vi.fn((signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<void>((res) => {
          resolveReconcile = res;
        });
      }),
    });

    late.onConnected();
    resolveReconcile();
    await vi.advanceTimersByTimeAsync(0); // let .finally clear the timer
    await vi.advanceTimersByTimeAsync(2_000); // past the budget
    expect(signals[0].aborted).toBe(false);
  });

  it('dispose aborts the in-flight reconcile (effect cleanup)', () => {
    const signals: AbortSignal[] = [];
    const { late } = make({
      reconcile: vi.fn(async (signal: AbortSignal) => {
        signals.push(signal);
        await new Promise<void>(() => {
          /* never settles */
        });
      }),
    });

    late.onConnected();
    late.dispose();

    expect(signals[0].aborted).toBe(true);
  });
});
