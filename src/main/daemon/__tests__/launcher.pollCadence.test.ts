import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextPollDelayMs, pollDaemonReady } from '../launcher';

// S-A C1 — adaptive readiness-poll cadence. The old loop was a fixed
// 200 ms setInterval, which quantized the (typically fast) daemon-spawned →
// first-ping-ok span by +0–200 ms. These tests pin the extracted chain:
// immediate first check, dense early cadence, 200 ms long-tail backoff,
// wall-clock budget, and the cancel path used by the
// DAEMON_EXIT_ALREADY_RUNNING child-exit handler.

describe('nextPollDelayMs', () => {
  it('polls densely (40 ms) during the first 2 s', () => {
    expect(nextPollDelayMs(0)).toBe(40);
    expect(nextPollDelayMs(1_999)).toBe(40);
  });

  it('backs off to the original 200 ms after 2 s', () => {
    expect(nextPollDelayMs(2_000)).toBe(200);
    expect(nextPollDelayMs(14_000)).toBe(200);
  });
});

describe('pollDaemonReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface Overrides {
    budgetMs?: number;
    readPipeName?: () => string | null;
    readToken?: () => string | null;
    ping?: (pipeName: string, token: string) => Promise<boolean>;
    onPipeFileSeen?: () => void;
    onPingOk?: () => void;
  }

  function startPoll(overrides: Overrides = {}) {
    return pollDaemonReady({
      budgetMs: 15_000,
      readPipeName: () => 'pipe-x',
      readToken: () => 'token-x',
      ping: async () => true,
      ...overrides,
    });
  }

  /** Attach a state probe — fake timers make bare await-on-promise hang. */
  function observe(promise: Promise<void>) {
    const state = { resolved: false, rejected: null as Error | null };
    promise.then(
      () => {
        state.resolved = true;
      },
      (err: Error) => {
        state.rejected = err;
      },
    );
    return state;
  }

  it('resolves on the immediate first check without waiting one interval', async () => {
    const onPingOk = vi.fn();
    const state = observe(startPoll({ onPingOk }).promise);

    // No timer advance at all — only microtask flush.
    await vi.advanceTimersByTimeAsync(0);

    expect(state.resolved).toBe(true);
    expect(onPingOk).toHaveBeenCalledTimes(1);
  });

  it('detects a late pipe file on the dense 40 ms cadence', async () => {
    let pipeName: string | null = null;
    const state = observe(startPoll({ readPipeName: () => pipeName }).promise);

    await vi.advanceTimersByTimeAsync(0);
    expect(state.resolved).toBe(false);

    pipeName = 'pipe-x';
    // One dense tick (40 ms) must pick it up — well under the old 200 ms.
    await vi.advanceTimersByTimeAsync(40);
    expect(state.resolved).toBe(true);
  });

  it('fires onPipeFileSeen exactly once across repeated checks', async () => {
    const onPipeFileSeen = vi.fn();
    let alive = false;
    const state = observe(
      startPoll({
        onPipeFileSeen,
        ping: async () => alive,
      }).promise,
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(onPipeFileSeen).toHaveBeenCalledTimes(1);

    alive = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(state.resolved).toBe(true);
    expect(onPipeFileSeen).toHaveBeenCalledTimes(1);
  });

  it('retries a failing ping and resolves once it answers', async () => {
    let calls = 0;
    const state = observe(
      startPoll({
        ping: async () => {
          calls++;
          return calls >= 3;
        },
      }).promise,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(state.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(state.resolved).toBe(true);
    expect(calls).toBe(3);
  });

  it('never overlaps checks while a slow ping is in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const state = observe(
      startPoll({
        ping: () =>
          new Promise<boolean>((resolve) => {
            calls++;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            setTimeout(() => {
              inFlight--;
              resolve(false);
            }, 1_000); // slower than many dense ticks
          }),
        budgetMs: 10_000,
      }).promise,
    );

    await vi.advanceTimersByTimeAsync(2_500);
    expect(maxInFlight).toBe(1);
    // The chain must not queue extra ticks while a ping is in flight: each
    // 1 s ping is followed by exactly one scheduled delay before the next
    // check. In 2 500 ms that is ping(0–1000) → 40 ms → ping(1040–2040) →
    // 200 ms → ping(2240–…) = 3 calls. A fixed-interval loop that kept
    // ticking behind the in-flight guard would not hold this bound.
    expect(calls).toBe(3);
    expect(state.resolved).toBe(false);
    expect(state.rejected).toBeNull();
  });

  it('treats a rejecting ping as a failed attempt (no unhandled rejection)', async () => {
    let calls = 0;
    const state = observe(
      startPoll({
        ping: async () => {
          calls++;
          if (calls === 1) throw new Error('pipe write EPIPE');
          return true;
        },
      }).promise,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(state.resolved).toBe(false); // first attempt rejected → retry
    await vi.advanceTimersByTimeAsync(40);
    expect(state.resolved).toBe(true);
    expect(calls).toBe(2);
  });

  it('rejects with the pipe-file message when the budget runs out', async () => {
    const state = observe(
      startPoll({ readPipeName: () => null, budgetMs: 15_000 }).promise,
    );

    await vi.advanceTimersByTimeAsync(15_500);
    expect(state.rejected?.message).toBe(
      'Daemon spawned but pipe name file not created after 15 seconds',
    );
  });

  it('rejects with the auth-token message when the budget runs out', async () => {
    const state = observe(
      startPoll({ readToken: () => null, budgetMs: 15_000 }).promise,
    );

    await vi.advanceTimersByTimeAsync(15_500);
    expect(state.rejected?.message).toBe(
      'Daemon spawned but auth token not found after 15 seconds',
    );
  });

  it('rejects with the not-responding message when pings never answer', async () => {
    const state = observe(
      startPoll({ ping: async () => false, budgetMs: 15_000 }).promise,
    );

    await vi.advanceTimersByTimeAsync(15_500);
    expect(state.rejected?.message).toBe(
      'Daemon spawned but not responding after 15 seconds',
    );
  });

  it('cancel() settles with the given error and stops further checks', async () => {
    let calls = 0;
    const poll = startPoll({
      ping: async () => {
        calls++;
        return false;
      },
    });
    const state = observe(poll.promise);

    await vi.advanceTimersByTimeAsync(100);
    const callsAtCancel = calls;
    const err = new Error('daemon yielded');
    poll.cancel(err);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(state.rejected).toBe(err);
    expect(calls).toBe(callsAtCancel);
  });

  it('discards a ping that resolves after cancel (no double settle)', async () => {
    let resolvePing!: (alive: boolean) => void;
    const onPingOk = vi.fn();
    const poll = startPoll({
      ping: () =>
        new Promise<boolean>((res) => {
          resolvePing = res;
        }),
      onPingOk,
    });
    const state = observe(poll.promise);

    await vi.advanceTimersByTimeAsync(0); // first check now awaiting ping
    const err = new Error('daemon yielded');
    poll.cancel(err);
    resolvePing(true); // late success must be ignored
    await vi.advanceTimersByTimeAsync(0);

    expect(state.rejected).toBe(err);
    expect(onPingOk).not.toHaveBeenCalled();
  });
});
