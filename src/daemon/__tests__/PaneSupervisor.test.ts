import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaneSupervisor, type PaneSupervisorDeps } from '../PaneSupervisor';
import type { DaemonSupervisionPolicy } from '../../shared/rpc';

// X8 PaneSupervisor — pure policy/backoff/guard machine driven by a fake
// clock + fake timers. The single most important behavioral contract here:
// user intent never reaches onSessionDied (destroySession disposes the exit
// listener first), so these tests only model PTY self-exits.

const POLICY: DaemonSupervisionPolicy = {
  restart: 'on-failure',
  limit: { burst: 5, healthyUptimeSec: 300 },
};

function makeHarness() {
  let t = 0;
  const deps = {
    restartSession: vi.fn(),
    isSessionDead: vi.fn(() => true),
    broadcast: vi.fn(),
    persistStatus: vi.fn(),
    log: vi.fn(),
    now: () => t,
  } satisfies PaneSupervisorDeps;
  const sup = new PaneSupervisor(deps);
  // Keep the injected clock and vitest's timer clock in lockstep. Tests must
  // measure against `now()` (the injected clock), never Date.now() — the
  // fake-timer Date starts at install time, not 0.
  const advance = (ms: number) => {
    t += ms;
    vi.advanceTimersByTime(ms);
  };
  return { sup, deps, advance, now: () => t };
}

describe('PaneSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('restart policy classification', () => {
    it('on-failure does not restart a clean exit (code 0, no signal)', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 0 });
      advance(60_000);
      expect(deps.restartSession).not.toHaveBeenCalled();
    });

    it('on-failure restarts a non-zero exit after the base backoff', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 1 });
      advance(999);
      expect(deps.restartSession).not.toHaveBeenCalled();
      advance(1);
      expect(deps.restartSession).toHaveBeenCalledOnce();
      expect(sup.getRuntime('s')?.restartCount).toBe(1);
      // The restart announcement main forwards to the renderer for re-attach.
      expect(deps.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session.restarted',
          sessionId: 's',
          data: expect.objectContaining({ restartCount: 1, exitCode: 1 }),
        }),
      );
    });

    it('treats exitCode null (external kill seen by ProcessMonitor) as failure', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: null });
      advance(1_000);
      expect(deps.restartSession).toHaveBeenCalledOnce();
    });

    it('treats a signal as failure even with exit code 0', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 0, signal: 15 });
      advance(1_000);
      expect(deps.restartSession).toHaveBeenCalledOnce();
    });

    it('always restarts even a clean exit', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', { ...POLICY, restart: 'always' });
      sup.onSessionDied({ id: 's', exitCode: 0 });
      advance(1_000);
      expect(deps.restartSession).toHaveBeenCalledOnce();
    });

    it('ignores deaths of sessions it does not supervise', () => {
      const { sup, deps, advance } = makeHarness();
      sup.onSessionDied({ id: 'stranger', exitCode: 1 });
      advance(60_000);
      expect(deps.restartSession).not.toHaveBeenCalled();
      expect(sup.getRuntime('stranger')).toBeUndefined();
    });
  });

  describe('backoff and runaway guard', () => {
    it('doubles the backoff per consecutive short run (1s, 2s, 4s, 8s)', () => {
      const { sup, deps, advance, now } = makeHarness();
      sup.arm('s', POLICY);
      const expected = [1_000, 2_000, 4_000, 8_000];
      for (const delay of expected) {
        sup.onSessionDied({ id: 's', exitCode: 1 });
        const runtime = sup.getRuntime('s');
        // nextRestartAt is the absolute fire time; delta from "now" is the delay.
        expect(runtime!.nextRestartAt! - now()).toBe(delay);
        advance(delay - 1);
        const before = deps.restartSession.mock.calls.length;
        advance(1);
        expect(deps.restartSession.mock.calls.length).toBe(before + 1);
      }
    });

    it('trips the guard at `burst` consecutive short runs and stops, sticky', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      // 4 failures restart (with growing backoff)…
      for (const delay of [1_000, 2_000, 4_000, 8_000]) {
        sup.onSessionDied({ id: 's', exitCode: 1 });
        advance(delay);
      }
      expect(deps.restartSession).toHaveBeenCalledTimes(4);
      // …the 5th consecutive short failure trips instead of scheduling.
      sup.onSessionDied({ id: 's', exitCode: 1 });
      advance(60_000);
      expect(deps.restartSession).toHaveBeenCalledTimes(4);
      expect(sup.getRuntime('s')?.status).toBe('stopped');
      expect(deps.persistStatus).toHaveBeenCalledWith('s', 'stopped');
      expect(deps.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'supervision.changed',
          sessionId: 's',
          data: expect.objectContaining({ status: 'stopped', reason: 'guard-trip' }),
        }),
      );
      // Sticky: further deaths only record, never restart.
      sup.onSessionDied({ id: 's', exitCode: 1 });
      advance(60_000);
      expect(deps.restartSession).toHaveBeenCalledTimes(4);
    });

    it('a healthy run resets the consecutive-failure counter', () => {
      const { sup, advance, now } = makeHarness();
      sup.arm('s', POLICY);
      // Three short failures → counter 3.
      for (const delay of [1_000, 2_000, 4_000]) {
        sup.onSessionDied({ id: 's', exitCode: 1 });
        advance(delay);
      }
      expect(sup.getRuntime('s')?.consecutiveFailures).toBe(3);
      // The run now survives past healthyUptimeSec before dying…
      advance(POLICY.limit.healthyUptimeSec * 1_000 + 1);
      sup.onSessionDied({ id: 's', exitCode: 1 });
      // …so the counter fully resets — a healthy run's death is not a
      // "short run" and contributes nothing to the spiral. Backoff returns
      // to the base delay. The guard measures a CONSECUTIVE crash spiral,
      // not lifetime failures.
      const runtime = sup.getRuntime('s');
      expect(runtime?.consecutiveFailures).toBe(0);
      expect(runtime!.nextRestartAt! - now()).toBe(1_000);
    });

    it('an instantly-exiting always loop with code 0 still trips the guard (token-burn protection)', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', { ...POLICY, restart: 'always' });
      for (const delay of [1_000, 2_000, 4_000, 8_000]) {
        sup.onSessionDied({ id: 's', exitCode: 0 });
        advance(delay);
      }
      sup.onSessionDied({ id: 's', exitCode: 0 });
      expect(sup.getRuntime('s')?.status).toBe('stopped');
      expect(deps.restartSession).toHaveBeenCalledTimes(4);
    });

    it('counts a synchronous restartSession failure as a failed start and keeps backing off', () => {
      const { sup, deps, advance } = makeHarness();
      deps.restartSession.mockImplementationOnce(() => {
        throw new Error('ConPTY error code: 87');
      });
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 1 }); // counter 1
      advance(1_000); // fire → throws → counter 2, reschedule (2s)
      expect(sup.getRuntime('s')?.consecutiveFailures).toBe(2);
      expect(deps.restartSession).toHaveBeenCalledTimes(1);
      advance(2_000); // second attempt succeeds
      expect(deps.restartSession).toHaveBeenCalledTimes(2);
      // No session.restarted broadcast for the failed attempt.
      const restartedEvents = deps.broadcast.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === 'session.restarted',
      );
      expect(restartedEvents).toHaveLength(1);
    });

    it('a persistently failing restartSession eventually trips the guard', () => {
      const { sup, deps, advance } = makeHarness();
      deps.restartSession.mockImplementation(() => {
        throw new Error('spawn failed');
      });
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 1 });
      advance(120_000); // generous: covers every backoff step until the trip
      expect(sup.getRuntime('s')?.status).toBe('stopped');
      // counter path: died(1) → throw(2) → throw(3) → throw(4) → throw(5=burst) → trip.
      expect(deps.restartSession).toHaveBeenCalledTimes(4);
    });

    const restartedEvents = (deps: ReturnType<typeof makeHarness>['deps']) =>
      deps.broadcast.mock.calls.filter((c) => (c[0] as { type: string }).type === 'session.restarted');

    it('routes an async restartSession rejection through the same failure path', async () => {
      const { sup, deps, advance } = makeHarness();
      deps.restartSession.mockImplementationOnce(() => Promise.reject(new Error('WSL probe timed out')));
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 1 }); // counter 1
      advance(1_000); // fire → promise rejects
      await Promise.resolve();
      await Promise.resolve();
      expect(sup.getRuntime('s')?.consecutiveFailures).toBe(2);
      expect(sup.getRuntime('s')?.nextRestartAt).toBeDefined(); // backoff rescheduled
      expect(restartedEvents(deps)).toHaveLength(0);
      expect(deps.log).toHaveBeenCalledWith('error', expect.stringContaining('WSL probe timed out'));
    });

    it('broadcasts session.restarted only after an async restartSession resolves', async () => {
      const { sup, deps, advance } = makeHarness();
      let resolve!: () => void;
      deps.restartSession.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 1 });
      advance(1_000);
      expect(deps.restartSession).toHaveBeenCalledOnce();
      expect(restartedEvents(deps)).toHaveLength(0);
      resolve();
      await Promise.resolve();
      expect(restartedEvents(deps)).toHaveLength(1);
      expect(sup.getRuntime('s')?.restartCount).toBe(1);
    });

    it('stays silent when the pane is closed while an async restart is in flight', async () => {
      const { sup, deps, advance } = makeHarness();
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      deps.restartSession
        .mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }))
        .mockImplementationOnce(() => new Promise<void>((_r, j) => { reject = j; }));
      sup.arm('a', POLICY);
      sup.onSessionDied({ id: 'a', exitCode: 1 });
      sup.arm('b', POLICY);
      sup.onSessionDied({ id: 'b', exitCode: 1 });
      advance(1_000);
      sup.disarm('a');
      sup.disarm('b');
      resolve();
      reject(new Error('spawn failed'));
      await Promise.resolve();
      await Promise.resolve();
      expect(restartedEvents(deps)).toHaveLength(0);
      expect(sup.getRuntime('a')).toBeUndefined();
      expect(sup.getRuntime('b')).toBeUndefined();
    });
  });

  describe('races and lifecycle', () => {
    it('disarm during the backoff window cancels the pending restart (user closed the pane)', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 1 });
      sup.disarm('s');
      advance(60_000);
      expect(deps.restartSession).not.toHaveBeenCalled();
      expect(sup.getRuntime('s')).toBeUndefined();
    });

    it('ignores a duplicate death while a restart is already pending', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 1 });
      // ProcessMonitor safety net re-reports the same death.
      sup.onSessionDied({ id: 's', exitCode: null });
      expect(sup.getRuntime('s')?.consecutiveFailures).toBe(1);
      advance(1_000);
      expect(deps.restartSession).toHaveBeenCalledTimes(1);
      advance(60_000);
      expect(deps.restartSession).toHaveBeenCalledTimes(1);
    });

    it('dispose cancels all pending restarts (daemon shutdown)', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('a', POLICY);
      sup.arm('b', POLICY);
      sup.onSessionDied({ id: 'a', exitCode: 1 });
      sup.onSessionDied({ id: 'b', exitCode: 1 });
      sup.dispose();
      advance(60_000);
      expect(deps.restartSession).not.toHaveBeenCalled();
    });

    it('arming with a persisted stopped status stays inert until rearm (reboot trust)', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY, 'stopped');
      sup.onSessionDied({ id: 's', exitCode: 1 });
      advance(60_000);
      expect(deps.restartSession).not.toHaveBeenCalled();
      expect(sup.getRuntime('s')?.status).toBe('stopped');
    });
  });

  describe('manual stop / rearm', () => {
    it('stop cancels a pending restart, persists, broadcasts, and stays stopped', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      sup.onSessionDied({ id: 's', exitCode: 1 });
      expect(sup.stop('s')).toBe(true);
      advance(60_000);
      expect(deps.restartSession).not.toHaveBeenCalled();
      expect(deps.persistStatus).toHaveBeenCalledWith('s', 'stopped');
      expect(deps.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'supervision.changed',
          data: expect.objectContaining({ status: 'stopped', reason: 'manual-stop' }),
        }),
      );
      // Idempotent-ish: stopping an already-stopped entry reports false.
      expect(sup.stop('s')).toBe(false);
      expect(sup.stop('ghost')).toBe(false);
    });

    it('rearm after a guard trip resets counters, persists, and restarts a dead unit immediately', () => {
      const { sup, deps, advance } = makeHarness();
      sup.arm('s', POLICY);
      for (const delay of [1_000, 2_000, 4_000, 8_000]) {
        sup.onSessionDied({ id: 's', exitCode: 1 });
        advance(delay);
      }
      sup.onSessionDied({ id: 's', exitCode: 1 }); // trips
      expect(sup.getRuntime('s')?.status).toBe('stopped');

      expect(sup.rearm('s')).toBe(true);
      expect(deps.persistStatus).toHaveBeenLastCalledWith('s', 'armed');
      expect(deps.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'supervision.changed',
          data: expect.objectContaining({ status: 'armed', reason: 'rearm' }),
        }),
      );
      // Dead unit → one immediate restart; counters started fresh.
      expect(deps.restartSession).toHaveBeenCalledTimes(5);
      expect(sup.getRuntime('s')?.consecutiveFailures).toBe(0);
      expect(sup.getRuntime('s')?.restartCount).toBe(1);
    });

    it('rearm does not relaunch a still-running unit', () => {
      const { sup, deps } = makeHarness();
      deps.isSessionDead.mockReturnValue(false);
      sup.arm('s', POLICY);
      sup.stop('s');
      expect(sup.rearm('s')).toBe(true);
      expect(deps.restartSession).not.toHaveBeenCalled();
    });

    it('rearm is a no-op for armed or unknown sessions', () => {
      const { sup } = makeHarness();
      sup.arm('s', POLICY);
      expect(sup.rearm('s')).toBe(false);
      expect(sup.rearm('ghost')).toBe(false);
    });
  });
});
