import { describe, it, expect } from 'vitest';
import {
  isDaemonOlder,
  runDaemonReplacement,
  REPLACEMENT_SHUTDOWN_BUDGET_MS,
  type ReplacementDeps,
  type ReplacementOutcome,
} from '../daemonReplacement';
import type { ProcessLiveness } from '../../../shared/processLiveness';

// ---------------------------------------------------------------------------
// isDaemonOlder — the full decision table from the plan (§4), including the
// prerelease and epoch edge rows the review panel added (Claude #11).
// ---------------------------------------------------------------------------

describe('isDaemonOlder', () => {
  const APP = '3.17.0';
  const EPOCH = 2;

  it('missing field entirely → positively old (pre-B′ daemon) → replace', () => {
    expect(isDaemonOlder({}, APP, EPOCH).older).toBe(true);
    expect(isDaemonOlder(undefined, APP, EPOCH).older).toBe(true);
    expect(isDaemonOlder(null, APP, EPOCH).older).toBe(true);
    expect(isDaemonOlder({ spawnedByVersion: undefined }, APP, EPOCH).older).toBe(true);
  });

  it('sentinel "unknown" → information absence → keep (warn)', () => {
    const v = isDaemonOlder({ spawnedByVersion: 'unknown' }, APP, EPOCH);
    expect(v.older).toBe(false);
    expect(v.warnOnKeep).toBe(true);
  });

  it('non-string field → keep (warn), never destructive on malformed input', () => {
    const v = isDaemonOlder({ spawnedByVersion: 42 }, APP, EPOCH);
    expect(v.older).toBe(false);
    expect(v.warnOnKeep).toBe(true);
  });

  it('valid semver below the app → replace', () => {
    expect(isDaemonOlder({ spawnedByVersion: '3.16.0' }, APP, EPOCH).older).toBe(true);
    expect(isDaemonOlder({ spawnedByVersion: '3.16.9' }, APP, EPOCH).older).toBe(true);
    expect(isDaemonOlder({ spawnedByVersion: '2.99.99' }, APP, EPOCH).older).toBe(true);
  });

  it('same core + daemon prerelease under release app → replace', () => {
    expect(isDaemonOlder({ spawnedByVersion: '3.17.0-beta.1' }, APP, EPOCH).older).toBe(true);
  });

  it('same core + release daemon under prerelease app → keep (daemon is not older)', () => {
    expect(isDaemonOlder({ spawnedByVersion: '3.17.0' }, '3.17.0-beta.1', EPOCH).older).toBe(false);
  });

  it('same core + older channelsEpoch → replace (dev-window schema bump)', () => {
    const v = isDaemonOlder({ spawnedByVersion: APP, channelsEpoch: 1 }, APP, EPOCH);
    expect(v.older).toBe(true);
  });

  it('same core + absent or malformed epoch takes the explicit keep branch (no NaN-false accident)', () => {
    expect(isDaemonOlder({ spawnedByVersion: APP }, APP, EPOCH).older).toBe(false);
    expect(isDaemonOlder({ spawnedByVersion: APP, channelsEpoch: 'x' }, APP, EPOCH).older).toBe(false);
    expect(isDaemonOlder({ spawnedByVersion: APP, channelsEpoch: NaN }, APP, EPOCH).older).toBe(false);
  });

  it('same core + current/higher epoch → keep', () => {
    expect(isDaemonOlder({ spawnedByVersion: APP, channelsEpoch: EPOCH }, APP, EPOCH).older).toBe(false);
    expect(isDaemonOlder({ spawnedByVersion: APP, channelsEpoch: EPOCH + 1 }, APP, EPOCH).older).toBe(false);
  });

  it('daemon NEWER than app → keep (downgrade forbidden), warn-level', () => {
    const v = isDaemonOlder({ spawnedByVersion: '3.18.0' }, APP, EPOCH);
    expect(v.older).toBe(false);
    expect(v.warnOnKeep).toBe(true);
    // Even a newer daemon with an older epoch must not be replaced —
    // version dominates; the epoch row only applies at same core.
    expect(isDaemonOlder({ spawnedByVersion: '3.18.0', channelsEpoch: 0 }, APP, EPOCH).older).toBe(false);
  });

  it('unparseable versions (either side) → keep (warn)', () => {
    expect(isDaemonOlder({ spawnedByVersion: 'garbage' }, APP, EPOCH).older).toBe(false);
    expect(isDaemonOlder({ spawnedByVersion: '3.16' }, APP, EPOCH).older).toBe(false);
    expect(isDaemonOlder({ spawnedByVersion: '3.16.0' }, 'not-a-version', EPOCH).older).toBe(false);
  });

  it('build metadata is tolerated, prerelease detection unaffected', () => {
    expect(isDaemonOlder({ spawnedByVersion: '3.16.0+build.5' }, APP, EPOCH).older).toBe(true);
    expect(isDaemonOlder({ spawnedByVersion: '3.17.0+build.5' }, APP, EPOCH).older).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDaemonReplacement — sequence + failure policy. All effects injected;
// liveness scripts advance per call so each scenario is deterministic.
// ---------------------------------------------------------------------------

interface Script {
  ack?: boolean | (() => Promise<{ acked: boolean; stateSaved?: boolean }>);
  /** Sequence of liveness answers; the last value repeats forever. */
  liveness: ProcessLiveness[];
  connectedAfterShutdownFail?: boolean;
  killResult?: boolean;
  /** When true, checkLiveness answers 'dead' only AFTER killVerifiedPid ran —
   *  models the daemon dying BECAUSE of the kill, not before it. */
  deadAfterKill?: boolean;
  /** stateSaved carried on a successful ack (undefined = pre-B′ daemon). */
  stateSaved?: boolean;
  cancelled?: boolean | (() => boolean);
  /** #545 — pipe-gone answers, consumed in order (last value sticks). Default
   *  false everywhere, i.e. exactly the pre-#545 liveness-only behavior, so
   *  every existing case in this file keeps asserting what it always did. */
  pipeGone?: boolean[];
}

function makeDeps(script: Script) {
  const calls = {
    shutdownTimeouts: [] as number[],
    disconnects: 0,
    livenessChecks: 0,
    kills: 0,
    sleeps: [] as number[],
    logs: [] as string[],
    pipeProbes: 0,
  };
  let killed = false;
  const deps: ReplacementDeps = {
    oldPid: 4242,
    shutdownRpc: async (timeoutMs) => {
      calls.shutdownTimeouts.push(timeoutMs);
      if (typeof script.ack === 'function') return script.ack();
      return { acked: script.ack ?? true, stateSaved: script.stateSaved };
    },
    isClientConnected: () => script.connectedAfterShutdownFail ?? false,
    disconnectClient: async () => { calls.disconnects++; },
    isPipeGone: async () => {
      calls.pipeProbes++;
      const seq = script.pipeGone;
      if (!seq || seq.length === 0) return false;
      return seq[Math.min(calls.pipeProbes - 1, seq.length - 1)];
    },
    checkLiveness: () => {
      calls.livenessChecks++;
      if (killed && script.deadAfterKill) return 'dead';
      const idx = Math.min(calls.livenessChecks - 1, script.liveness.length - 1);
      return script.liveness[idx];
    },
    killVerifiedPid: () => {
      calls.kills++;
      killed = script.killResult ?? false;
      return script.killResult ?? false;
    },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    isCancelled: () => (typeof script.cancelled === 'function' ? script.cancelled() : (script.cancelled ?? false)),
    log: (_level, msg) => { calls.logs.push(msg); },
  };
  return { deps, calls };
}

async function run(script: Script): Promise<{ outcome: ReplacementOutcome; calls: ReturnType<typeof makeDeps>['calls'] }> {
  const { deps, calls } = makeDeps(script);
  const outcome = await runDaemonReplacement(deps);
  return { outcome, calls };
}

describe('runDaemonReplacement', () => {
  it('happy path: ack → death confirmed → settle → old-daemon-dead, no kill', async () => {
    const { outcome, calls } = await run({ ack: true, liveness: ['alive', 'alive', 'dead'] });
    expect(outcome).toBe('old-daemon-dead');
    expect(calls.kills).toBe(0);
    expect(calls.disconnects).toBe(1);
    // The shutdown budget must stay below the daemon's 10s hard timeout.
    expect(calls.shutdownTimeouts).toEqual([REPLACEMENT_SHUTDOWN_BUDGET_MS]);
    expect(REPLACEMENT_SHUTDOWN_BUDGET_MS).toBeLessThan(10_000);
  });

  it('shutdown refused while client still connected → pre-ack reuse, nothing killed, no death poll', async () => {
    const { outcome, calls } = await run({
      ack: false,
      connectedAfterShutdownFail: true,
      liveness: ['alive'],
    });
    expect(outcome).toBe('reuse-old-daemon');
    expect(calls.kills).toBe(0);
    expect(calls.disconnects).toBe(0);
    expect(calls.livenessChecks).toBe(0);
  });

  it('shutdown RPC throws with live client → same pre-ack reuse', async () => {
    const { outcome, calls } = await run({
      ack: () => Promise.reject(new Error('boom')),
      connectedAfterShutdownFail: true,
      liveness: ['alive'],
    });
    expect(outcome).toBe('reuse-old-daemon');
    expect(calls.kills).toBe(0);
  });

  it('no ack + client dropped (daemon died mid-shutdown) → crash-grade path, death confirmed WITHOUT kill', async () => {
    const { outcome, calls } = await run({
      ack: false,
      connectedAfterShutdownFail: false,
      liveness: ['alive', 'dead'],
    });
    expect(outcome).toBe('old-daemon-dead');
    expect(calls.kills).toBe(0);
  });

  it('no ack + client dropped + process never dies → dead-end, kill NEVER attempted without ack', async () => {
    const { outcome, calls } = await run({
      ack: false,
      connectedAfterShutdownFail: false,
      liveness: ['alive'],
    });
    expect(outcome).toBe('dead-end');
    expect(calls.kills).toBe(0);
  });

  it('ack + linger → verified kill against the captured pid → dead → old-daemon-dead', async () => {
    const { outcome, calls } = await run({
      ack: true,
      liveness: ['alive'],
      killResult: true,
      deadAfterKill: true,
    });
    expect(outcome).toBe('old-daemon-dead');
    expect(calls.kills).toBe(1);
  });

  it('ack + linger + kill refused (indeterminate verification) → dead-end', async () => {
    const { outcome, calls } = await run({
      ack: true,
      liveness: ['alive'],
      killResult: false,
    });
    expect(outcome).toBe('dead-end');
    expect(calls.kills).toBe(1);
  });

  it('ack + liveness stuck at unknown (Windows AV scenario) → kill attempted; refusal → dead-end', async () => {
    const { outcome } = await run({
      ack: true,
      liveness: ['unknown'],
      killResult: false,
    });
    expect(outcome).toBe('dead-end');
  });

  it('ack + kill acknowledged but process still refuses to die → dead-end', async () => {
    const { outcome } = await run({
      ack: true,
      liveness: ['alive'],
      killResult: true,
      deadAfterKill: false,
    });
    expect(outcome).toBe('dead-end');
  });

  it('cancellation after death (before-quit race) → cancelled, caller must not spawn', async () => {
    const { outcome } = await run({
      ack: true,
      liveness: ['dead'],
      cancelled: true,
    });
    expect(outcome).toBe('cancelled');
  });

  it('cancellation during a failed shutdown race → cancelled, old client NOT offered for reuse', async () => {
    // Codex code-review #1a: without this, dispose() during the 8s race
    // would fall into the reuse branch and hand a client to install() on a
    // disposed controller.
    const { outcome, calls } = await run({
      ack: false,
      connectedAfterShutdownFail: true,
      liveness: ['alive'],
      cancelled: true,
    });
    expect(outcome).toBe('cancelled');
    expect(calls.kills).toBe(0);
  });

  it('ack with stateSaved=false proceeds but logs the snapshot-grade downgrade', async () => {
    const { outcome, calls } = await run({
      ack: true,
      stateSaved: false,
      liveness: ['dead'],
    });
    expect(outcome).toBe('old-daemon-dead');
    expect(calls.logs.some((m) => m.includes('stateSaved=false'))).toBe(true);
  });

  it('ack with stateSaved=true (or absent) logs no downgrade warning', async () => {
    const withTrue = await run({ ack: true, stateSaved: true, liveness: ['dead'] });
    expect(withTrue.calls.logs.some((m) => m.includes('stateSaved=false'))).toBe(false);
    const preBPrime = await run({ ack: true, liveness: ['dead'] });
    expect(preBPrime.calls.logs.some((m) => m.includes('stateSaved=false'))).toBe(false);
  });

  it('disconnect failure does not derail the sequence', async () => {
    const { deps, calls } = makeDeps({ ack: true, liveness: ['dead'] });
    deps.disconnectClient = async () => { throw new Error('already closed'); };
    const outcome = await runDaemonReplacement(deps);
    expect(outcome).toBe('old-daemon-dead');
    expect(calls.kills).toBe(0);
  });
});
