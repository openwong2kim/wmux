import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watchdog } from '../Watchdog';

describe('Watchdog', () => {
  let watchdog: Watchdog;

  beforeEach(() => {
    vi.useFakeTimers();
    watchdog = new Watchdog(1000);
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
  });

  it('isBlocked defaults to false', () => {
    expect(watchdog.isBlocked).toBe(false);
  });

  it('does not escalate when memory is below warn threshold', () => {
    const onReap = vi.fn(() => 0);
    const onBlock = vi.fn();
    watchdog.setCallbacks({ onReapDeadSessions: onReap, onBlockNewSessions: onBlock });

    watchdog.start(() => ({ sessions: 1, memory: 100 * 1024 * 1024, uptime: 60 }));
    vi.advanceTimersByTime(1000);

    expect(onReap).not.toHaveBeenCalled();
    expect(onBlock).not.toHaveBeenCalled();
    expect(watchdog.isBlocked).toBe(false);
  });

  it('logs warning at 500MB but does not reap or block', () => {
    const onReap = vi.fn(() => 0);
    const onBlock = vi.fn();
    watchdog.setCallbacks({ onReapDeadSessions: onReap, onBlockNewSessions: onBlock });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    watchdog.start(() => ({ sessions: 2, memory: 600 * 1024 * 1024, uptime: 120 }));
    vi.advanceTimersByTime(1000);

    expect(onReap).not.toHaveBeenCalled();
    expect(onBlock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: Memory'),
      );
    consoleSpy.mockRestore();
  });

  it('reaps dead sessions at 750MB threshold', () => {
    const onReap = vi.fn(() => 3);
    const onBlock = vi.fn();
    watchdog.setCallbacks({ onReapDeadSessions: onReap, onBlockNewSessions: onBlock });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    watchdog.start(() => ({ sessions: 5, memory: 800 * 1024 * 1024, uptime: 300 }));
    vi.advanceTimersByTime(1000);

    expect(onReap).toHaveBeenCalledTimes(1);
    expect(onBlock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('reaped 3 dead sessions'),
    );
    consoleSpy.mockRestore();
  });

  it('blocks new sessions at 1GB threshold', () => {
    const onReap = vi.fn(() => 0);
    const onBlock = vi.fn();
    watchdog.setCallbacks({ onReapDeadSessions: onReap, onBlockNewSessions: onBlock });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    watchdog.start(() => ({ sessions: 10, memory: 1100 * 1024 * 1024, uptime: 600 }));
    vi.advanceTimersByTime(1000);

    expect(watchdog.isBlocked).toBe(true);
    expect(onBlock).toHaveBeenCalledWith(true);
    expect(onReap).toHaveBeenCalled(); // also reaps at this level
    consoleSpy.mockRestore();
  });

  it('does not re-fire block callback on subsequent checks while still blocked', () => {
    const onBlock = vi.fn();
    watchdog.setCallbacks({ onBlockNewSessions: onBlock });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    watchdog.start(() => ({ sessions: 10, memory: 1100 * 1024 * 1024, uptime: 600 }));

    vi.advanceTimersByTime(1000);
    expect(onBlock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    // Should NOT call again since already blocked
    expect(onBlock).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it('unblocks when memory drops below 1GB', () => {
    const onBlock = vi.fn();
    watchdog.setCallbacks({ onBlockNewSessions: onBlock });

    let memoryBytes = 1100 * 1024 * 1024;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    watchdog.start(() => ({ sessions: 5, memory: memoryBytes, uptime: 100 }));
    vi.advanceTimersByTime(1000);

    expect(watchdog.isBlocked).toBe(true);
    expect(onBlock).toHaveBeenCalledWith(true);

    // Simulate memory recovery
    memoryBytes = 800 * 1024 * 1024;
    vi.advanceTimersByTime(1000);

    expect(watchdog.isBlocked).toBe(false);
    expect(onBlock).toHaveBeenCalledWith(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('unblocking new sessions'),
    );
    consoleSpy.mockRestore();
  });

  it('handles missing callbacks gracefully', () => {
    // No callbacks set — should not throw
    vi.spyOn(console, 'log').mockImplementation(() => {});
    watchdog.start(() => ({ sessions: 1, memory: 1100 * 1024 * 1024, uptime: 60 }));
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    vi.restoreAllMocks();
  });

  it('catches errors from healthCheck', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    watchdog.start(() => { throw new Error('boom'); });
    vi.advanceTimersByTime(1000);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Health check failed'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('stop clears the interval', () => {
    const healthCheck = vi.fn(() => ({ sessions: 0, memory: 0, uptime: 0 }));
    watchdog.start(healthCheck);
    vi.advanceTimersByTime(1000);
    expect(healthCheck).toHaveBeenCalledTimes(1);

    watchdog.stop();
    vi.advanceTimersByTime(5000);
    // No more calls after stop
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it('start is idempotent — second call is a no-op', () => {
    const healthCheck = vi.fn(() => ({ sessions: 0, memory: 0, uptime: 0 }));
    watchdog.start(healthCheck);
    watchdog.start(healthCheck); // should not create another interval
    vi.advanceTimersByTime(1000);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  describe('idle shutdown', () => {
    // Idle-shutdown evaluation runs at the tail of every health tick. We
    // drive the Watchdog directly via `evaluateIdle()` instead of relying
    // on `start()` + fake timers — that keeps these tests pure-functional
    // and decoupled from the 30s default interval. A daemon main loop in
    // production wires the same callbacks and lets `start()` drive it.

    function makeWatchdogWithIdle(opts: { idleTimeoutMs: number; graceMs?: number; bootedAt?: number }): Watchdog {
      return new Watchdog(30_000, {
        idleTimeoutMs: opts.idleTimeoutMs,
        graceMs: opts.graceMs ?? 60_000,
        startTime: opts.bootedAt ?? Date.now(),
      });
    }

    it('does not fire when disabled (idleTimeoutMs <= 0)', () => {
      const onIdleShutdown = vi.fn();
      const wd = makeWatchdogWithIdle({ idleTimeoutMs: 0, bootedAt: Date.now() - 10 * 60_000 });
      wd.setCallbacks({
        onIdleCheck: () => ({ connections: 0, sessions: 0, lastDisconnectAt: Date.now() - 9 * 60_000 }),
        onIdleShutdown,
      });
      wd.evaluateIdle();
      expect(onIdleShutdown).not.toHaveBeenCalled();
    });

    it('does not fire inside the grace window', () => {
      const onIdleShutdown = vi.fn();
      // Just booted — uptime well below the 60s grace.
      const wd = makeWatchdogWithIdle({ idleTimeoutMs: 60_000, bootedAt: Date.now() - 10_000 });
      wd.setCallbacks({
        onIdleCheck: () => ({ connections: 0, sessions: 0, lastDisconnectAt: null }),
        onIdleShutdown,
      });
      wd.evaluateIdle();
      expect(onIdleShutdown).not.toHaveBeenCalled();
    });

    it('does not fire while at least one client is connected', () => {
      const onIdleShutdown = vi.fn();
      const wd = makeWatchdogWithIdle({ idleTimeoutMs: 60_000, bootedAt: Date.now() - 10 * 60_000 });
      wd.setCallbacks({
        onIdleCheck: () => ({ connections: 1, sessions: 0, lastDisconnectAt: null }),
        onIdleShutdown,
      });
      wd.evaluateIdle();
      expect(onIdleShutdown).not.toHaveBeenCalled();
    });

    it('does not fire while at least one PTY session is alive', () => {
      const onIdleShutdown = vi.fn();
      const wd = makeWatchdogWithIdle({ idleTimeoutMs: 60_000, bootedAt: Date.now() - 10 * 60_000 });
      wd.setCallbacks({
        onIdleCheck: () => ({ connections: 0, sessions: 1, lastDisconnectAt: Date.now() - 90_000 }),
        onIdleShutdown,
      });
      wd.evaluateIdle();
      expect(onIdleShutdown).not.toHaveBeenCalled();
    });

    it('fires after lastDisconnectAt + idleTimeoutMs has elapsed', () => {
      const onIdleShutdown = vi.fn();
      const wd = makeWatchdogWithIdle({ idleTimeoutMs: 60_000, bootedAt: Date.now() - 10 * 60_000 });
      const disconnectedAt = Date.now() - 90_000; // 90s ago
      wd.setCallbacks({
        onIdleCheck: () => ({ connections: 0, sessions: 0, lastDisconnectAt: disconnectedAt }),
        onIdleShutdown,
      });
      wd.evaluateIdle();
      expect(onIdleShutdown).toHaveBeenCalledTimes(1);
      const idleMs = onIdleShutdown.mock.calls[0][0] as number;
      expect(idleMs).toBeGreaterThanOrEqual(60_000);
    });

    it('fires after boot+grace+idleTimeoutMs when no client has ever connected', () => {
      // Daemon spawned but main never appeared (e.g. main crashed before
      // first ping). lastDisconnectAt stays null → falls back to startTime.
      const onIdleShutdown = vi.fn();
      const wd = makeWatchdogWithIdle({ idleTimeoutMs: 60_000, bootedAt: Date.now() - 5 * 60_000 });
      wd.setCallbacks({
        onIdleCheck: () => ({ connections: 0, sessions: 0, lastDisconnectAt: null }),
        onIdleShutdown,
      });
      wd.evaluateIdle();
      expect(onIdleShutdown).toHaveBeenCalledTimes(1);
    });

    it('only fires once even if evaluated repeatedly', () => {
      const onIdleShutdown = vi.fn();
      const wd = makeWatchdogWithIdle({ idleTimeoutMs: 60_000, bootedAt: Date.now() - 10 * 60_000 });
      wd.setCallbacks({
        onIdleCheck: () => ({ connections: 0, sessions: 0, lastDisconnectAt: Date.now() - 5 * 60_000 }),
        onIdleShutdown,
      });
      wd.evaluateIdle();
      wd.evaluateIdle();
      wd.evaluateIdle();
      expect(onIdleShutdown).toHaveBeenCalledTimes(1);
    });

    it('does nothing when onIdleCheck callback is not wired', () => {
      // Defensive: a daemon that forgets to wire the callback must not
      // accidentally self-terminate. Without `onIdleCheck` returning a
      // payload, evaluateIdle has no signal to act on.
      const onIdleShutdown = vi.fn();
      const wd = makeWatchdogWithIdle({ idleTimeoutMs: 60_000, bootedAt: Date.now() - 10 * 60_000 });
      wd.setCallbacks({ onIdleShutdown });
      wd.evaluateIdle();
      expect(onIdleShutdown).not.toHaveBeenCalled();
    });
  });

  it('logs health every 5th check', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    watchdog.start(() => ({ sessions: 1, memory: 100 * 1024 * 1024, uptime: 10 }));

    // Ticks 1-4: no health log (memory below warn)
    vi.advanceTimersByTime(4000);
    const healthLogs = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('Health:'),
    );
    expect(healthLogs).toHaveLength(0);

    // Tick 5: health log
    vi.advanceTimersByTime(1000);
    const healthLogs2 = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('Health:'),
    );
    expect(healthLogs2).toHaveLength(1);

    consoleSpy.mockRestore();
  });

  describe('custom memory thresholds (substrate 3.0)', () => {
    // Proves the escalation ladder is instance-driven (config.daemon.mem*Mb)
    // rather than the old static constants. The pairing with the control
    // case below is the actual evidence: 250 MB trips a custom 200 MB block
    // but is a no-op under the 1 GB default.
    it('blocks at a custom block threshold below the 1GB default', () => {
      const wd = new Watchdog(1000, undefined, { warnMb: 100, reapMb: 150, blockMb: 200 });
      const onBlock = vi.fn();
      wd.setCallbacks({ onBlockNewSessions: onBlock });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      wd.start(() => ({ sessions: 5, memory: 250 * 1024 * 1024, uptime: 100 }));
      vi.advanceTimersByTime(1000);

      expect(wd.isBlocked).toBe(true);
      expect(onBlock).toHaveBeenCalledWith(true);
      wd.stop();
      consoleSpy.mockRestore();
    });

    it('default thresholds do NOT block at 250MB (control for the above)', () => {
      const wd = new Watchdog(1000); // omit memConfig → default 500/750/1024
      const onBlock = vi.fn();
      wd.setCallbacks({ onBlockNewSessions: onBlock });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      wd.start(() => ({ sessions: 5, memory: 250 * 1024 * 1024, uptime: 100 }));
      vi.advanceTimersByTime(1000);

      expect(wd.isBlocked).toBe(false);
      expect(onBlock).not.toHaveBeenCalled();
      wd.stop();
      consoleSpy.mockRestore();
    });

    it('reaps dead sessions at a custom reap threshold', () => {
      const wd = new Watchdog(1000, undefined, { warnMb: 100, reapMb: 150, blockMb: 200 });
      const onReap = vi.fn(() => 2);
      wd.setCallbacks({ onReapDeadSessions: onReap });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // 160MB: above custom reap(150), below custom block(200).
      wd.start(() => ({ sessions: 3, memory: 160 * 1024 * 1024, uptime: 100 }));
      vi.advanceTimersByTime(1000);

      expect(onReap).toHaveBeenCalledTimes(1);
      expect(wd.isBlocked).toBe(false);
      wd.stop();
      consoleSpy.mockRestore();
    });
  });
});
