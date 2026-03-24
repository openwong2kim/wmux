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
});
