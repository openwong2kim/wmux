// Issue #545 — a clean shutdown must not dead-end just because `tasklist` is
// slow or AV-blocked.
//
// checkProcessLiveness returns 'unknown' (never 'dead') on a failed probe, by
// deliberate design (Defect-1 / split-brain). On a box where the probe always
// fails, the replacement death poll can never confirm, burns its whole 5 s
// budget, fails the definitiveOnly kill for the same reason, and dead-ends —
// for a daemon that acked and exited ~10 ms later. The pipe-gone signal is the
// second, probe-independent proof.
import { describe, it, expect } from 'vitest';
import {
  confirmShutdownComplete,
  runDaemonReplacement,
  REPLACEMENT_DEATH_POLL_INTERVAL_MS,
  type ReplacementDeps,
} from '../daemonReplacement';

describe('#545 confirmShutdownComplete', () => {
  it('confirms on an authoritative dead, regardless of the pipe', () => {
    expect(confirmShutdownComplete({ liveness: 'dead', acked: true, pipeGone: false })).toBe(true);
    expect(confirmShutdownComplete({ liveness: 'dead', acked: false, pipeGone: false })).toBe(true);
  });

  it('confirms on acked + pipe gone even when the probe is useless', () => {
    expect(confirmShutdownComplete({ liveness: 'unknown', acked: true, pipeGone: true })).toBe(true);
  });

  it('does NOT confirm on pipe-gone without an ack', () => {
    // Without an ack we never learned the daemon committed to dying, so a pipe
    // that merely looks gone must not authorize spawning over it.
    expect(confirmShutdownComplete({ liveness: 'unknown', acked: false, pipeGone: true })).toBe(false);
  });

  it('does NOT confirm while the process is positively alive', () => {
    // A live process that closed its pipe is mid-shutdown, not done. Only the
    // authoritative 'dead' overrides, and that is handled above.
    expect(confirmShutdownComplete({ liveness: 'alive', acked: true, pipeGone: true })).toBe(false);
  });

  it('does NOT confirm on unknown + pipe still up', () => {
    expect(confirmShutdownComplete({ liveness: 'unknown', acked: true, pipeGone: false })).toBe(false);
  });
});

function makeDeps(over: Partial<ReplacementDeps> = {}): {
  deps: ReplacementDeps;
  calls: { sleeps: number[]; kills: number; logs: string[] };
} {
  const calls = { sleeps: [] as number[], kills: 0, logs: [] as string[] };
  const deps: ReplacementDeps = {
    oldPid: 4242,
    shutdownRpc: async () => ({ acked: true, stateSaved: true }),
    isClientConnected: () => false,
    disconnectClient: async () => { /* no socket in these decision tests */ },
    checkLiveness: () => 'unknown',
    isPipeGone: async () => false,
    killVerifiedPid: () => { calls.kills++; return false; },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    isCancelled: () => false,
    log: (_l, msg) => { calls.logs.push(msg); },
    ...over,
  };
  return { deps, calls };
}

describe('#545 replacement death poll', () => {
  it('confirms on the first poll when the probe is blind but the pipe is gone', async () => {
    const { deps, calls } = makeDeps({
      checkLiveness: () => 'unknown',
      isPipeGone: async () => true,
    });
    const outcome = await runDaemonReplacement(deps);
    expect(outcome).toBe('old-daemon-dead');
    expect(calls.kills).toBe(0);
    // Only the pipe-settle sleep — the 5 s budget is never entered.
    expect(calls.sleeps).toEqual([200]);
  });

  it('still burns the budget and dead-ends when the pipe is up (fail-closed)', async () => {
    // The regression that matters: an unknown probe plus a live pipe means we
    // learned nothing, so the destructive path must stay exactly as cautious as
    // it was before this change.
    const { deps, calls } = makeDeps({
      checkLiveness: () => 'unknown',
      isPipeGone: async () => false,
    });
    const outcome = await runDaemonReplacement(deps);
    expect(outcome).toBe('dead-end');
    expect(calls.kills).toBe(1);
    expect(calls.sleeps.filter((ms) => ms === REPLACEMENT_DEATH_POLL_INTERVAL_MS).length)
      .toBeGreaterThanOrEqual(20);
  });

  it('does not let pipe-gone rescue a shutdown that was never acked', async () => {
    const { deps } = makeDeps({
      shutdownRpc: async () => ({ acked: false }),
      isClientConnected: () => false,
      checkLiveness: () => 'unknown',
      isPipeGone: async () => true,
    });
    // No ack → no escalation is safe, and pipe-gone alone must not confirm.
    expect(await runDaemonReplacement(deps)).toBe('dead-end');
  });

  it('treats a throwing pipe probe as "not gone" rather than crashing', async () => {
    const { deps } = makeDeps({
      checkLiveness: () => 'dead',
      isPipeGone: async () => { throw new Error('probe exploded'); },
    });
    // Liveness still confirms; the broken probe is absorbed, not propagated.
    expect(await runDaemonReplacement(deps)).toBe('old-daemon-dead');
  });
});
